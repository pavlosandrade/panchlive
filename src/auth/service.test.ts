import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/database.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import {
  AuthError,
  bootstrapAdminFromEnv,
  changeOwnPassword,
  createAccountByAdmin,
  createInvite,
  deleteAccountByAdmin,
  listAccounts,
  listInvites,
  login,
  logoutSession,
  registerWithInvite,
  revokeInvite,
  setupInitialAdmin,
  updateAccountByAdmin,
  validatePassword,
  validateSession,
} from "./service.js";

describe("auth/crypto", () => {
  it("gera hash scrypt único e verifica senha corretamente", async () => {
    const hash1 = await hashPassword("MinhaSenhaForte123");
    const hash2 = await hashPassword("MinhaSenhaForte123");
    assert.notEqual(hash1, hash2);
    assert.equal(await verifyPassword("MinhaSenhaForte123", hash1), true);
    assert.equal(await verifyPassword("SenhaErrada123", hash1), false);
    assert.equal(await verifyPassword("qualquer", "hash-invalido"), false);
  });
});

describe("auth/rate-limit", () => {
  it("bloqueia após atingir o limite na janela e libera quando a janela expira", () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    assert.equal(limiter.check("ip:1", 1000).allowed, true);
    assert.equal(limiter.check("ip:1", 2000).allowed, true);
    assert.equal(limiter.check("ip:1", 3000).allowed, true);
    const blocked = limiter.check("ip:1", 4000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 57);

    // Após a primeira tentativa expirar
    assert.equal(limiter.check("ip:1", 62_000).allowed, true);
  });
});

describe("auth/service", () => {
  it("valida requisitos mínimos de senha (8+ chars, maiúscula, minúscula e número)", () => {
    assert.equal(validatePassword("SenhaForte1"), "SenhaForte1");
    assert.throws(() => validatePassword("Curta1A"), AuthError);
    assert.throws(() => validatePassword("semmaiuscula1"), AuthError);
    assert.throws(() => validatePassword("SEMMINUSCULA1"), AuthError);
    assert.throws(() => validatePassword("SemNumeroAqui"), AuthError);
  });

  it("bootstrap via env cria admin apenas uma vez e nunca sobrescreve", async () => {
    const db = openDatabase(":memory:");
    try {
      const created = await bootstrapAdminFromEnv(db, "admin", "SenhaAdmin123");
      assert.equal(created, true);

      const secondRun = await bootstrapAdminFromEnv(db, "outro", "OutraSenha123");
      assert.equal(secondRun, false);

      const accounts = listAccounts(db);
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].username, "admin");
      assert.equal(accounts[0].role, "admin");
    } finally {
      db.close();
    }
  });

  it("fluxo completo: setup inicial, convite uso único, login, troca de senha e proteção do último admin", async () => {
    const db = openDatabase(":memory:");
    try {
      const setup = await setupInitialAdmin(db, {
        username: "pavlos",
        displayName: "Pavlos",
        password: "PasswordSuper123",
      });
      assert.equal(setup.account.role, "admin");
      assert.ok(validateSession(db, setup.sessionToken));

      // Não permite segundo setup
      await assert.rejects(
        () =>
          setupInitialAdmin(db, {
            username: "invasor",
            displayName: "Invasor",
            password: "PasswordSuper123",
          }),
        (err: unknown) => err instanceof AuthError && err.statusCode === 409,
      );

      // Protege o último admin ativo contra rebaixamento ou auto-desativação
      await assert.rejects(
        () =>
          updateAccountByAdmin(db, {
            actorId: setup.account.id,
            targetId: setup.account.id,
            role: "viewer",
          }),
        (err: unknown) => err instanceof AuthError && err.statusCode === 400,
      );

      // Cria convite e registra conta viewer
      const { invite, code } = createInvite(db, {
        actorId: setup.account.id,
        role: "viewer",
        expiresInHours: 24,
        note: "Amigo do Discord",
      });
      assert.equal(invite.status, "active");

      const registered = await registerWithInvite(db, {
        inviteCode: code.toLowerCase().replaceAll("-", " "),
        username: "amigo",
        displayName: "Amigo",
        password: "SenhaDoAmigo123",
      });
      assert.equal(registered.account.role, "viewer");
      assert.ok(validateSession(db, registered.sessionToken));

      // Convite não pode ser reutilizado
      await assert.rejects(
        () =>
          registerWithInvite(db, {
            inviteCode: code,
            username: "terceiro",
            displayName: "Terceiro",
            password: "SenhaTerceiro123",
          }),
        (err: unknown) => err instanceof AuthError && err.statusCode === 400,
      );

      const invites = listInvites(db);
      assert.equal(invites[0].status, "used");
      assert.equal(invites[0].usedByUsername, "amigo");

      // Convite revogado não funciona
      const revoked = createInvite(db, { actorId: setup.account.id, role: "viewer" });
      revokeInvite(db, revoked.invite.id);
      await assert.rejects(
        () =>
          registerWithInvite(db, {
            inviteCode: revoked.code,
            username: "bloqueado",
            displayName: "Bloqueado",
            password: "SenhaBloqueado123",
          }),
        (err: unknown) => err instanceof AuthError && err.statusCode === 400,
      );

      // Login adicional do viewer + troca de senha revoga a outra sessão
      const secondLogin = await login(db, {
        username: "amigo",
        password: "SenhaDoAmigo123",
      });
      const currentSession = validateSession(db, secondLogin.sessionToken);
      assert.ok(currentSession);

      await changeOwnPassword(db, {
        accountId: registered.account.id,
        currentPassword: "SenhaDoAmigo123",
        newPassword: "NovaSenhaAmigo456",
        currentTokenHash: currentSession.tokenHash,
      });

      assert.equal(validateSession(db, registered.sessionToken), null);
      assert.ok(validateSession(db, secondLogin.sessionToken));

      // Logout invalida a sessão atual
      logoutSession(db, secondLogin.sessionToken);
      assert.equal(validateSession(db, secondLogin.sessionToken), null);

      // Admin pode criar, desativar e excluir outra conta
      const manual = await createAccountByAdmin(db, {
        actorId: setup.account.id,
        username: "convidado",
        displayName: "Convidado",
        password: "SenhaConvidado123",
        role: "viewer",
      });
      const manualLogin = await login(db, {
        username: "convidado",
        password: "SenhaConvidado123",
      });
      await updateAccountByAdmin(db, {
        actorId: setup.account.id,
        targetId: manual.id,
        isActive: false,
      });
      assert.equal(validateSession(db, manualLogin.sessionToken), null);
      await assert.rejects(
        () => login(db, { username: "convidado", password: "SenhaConvidado123" }),
        (err: unknown) => err instanceof AuthError && err.statusCode === 401,
      );

      deleteAccountByAdmin(db, setup.account.id, manual.id);
      assert.equal(listAccounts(db).length, 2);
    } finally {
      db.close();
    }
  });
});
