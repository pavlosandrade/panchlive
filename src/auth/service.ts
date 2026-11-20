import type { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "../db/database.js";
import {
  generateInviteCode,
  generateOpaqueToken,
  hashPassword,
  normalizeInviteCode,
  sha256Hex,
  verifyPassword,
} from "./crypto.js";

export type AccountRole = "admin" | "viewer";

export interface PublicAccount {
  id: number;
  username: string;
  displayName: string;
  role: AccountRole;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  account: PublicAccount;
  tokenHash: string;
  expiresAt: string;
}

export interface LoginResult {
  account: PublicAccount;
  sessionToken: string;
  expiresAt: string;
}

export interface InviteSummary {
  id: number;
  codePrefix: string;
  role: AccountRole;
  note: string | null;
  status: "active" | "used" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdByUsername: string | null;
  usedByUsername: string | null;
}

export interface CreatedInviteResult {
  invite: InviteSummary;
  code: string;
}

export class AuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

interface AccountRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: AccountRole;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// Hash fixo usado apenas para equalizar o tempo de resposta quando o usuário não existe.
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("panchlive-dummy-timing-guard-value");
  }
  return dummyHashPromise;
}

function getAccountByIdOrThrow(db: DatabaseSync, id: number): AccountRow {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  if (!row) {
    throw new AuthError(404, "Conta não encontrada.");
  }
  return row;
}

function toPublicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function validateUsername(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!USERNAME_REGEX.test(normalized)) {
    throw new AuthError(
      400,
      "Usuário deve ter entre 3 e 32 caracteres (apenas letras, números, ponto, hífen ou underline).",
    );
  }
  return normalized;
}

export function validateDisplayName(raw: string): string {
  const cleaned = raw.trim();
  if (cleaned.length < 1 || cleaned.length > 64) {
    throw new AuthError(400, "Nome de exibição deve ter entre 1 e 64 caracteres.");
  }
  return cleaned;
}

export function validatePassword(raw: string): string {
  if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, `A senha deve ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.`);
  }
  if (!/[A-Z]/.test(raw) || !/[a-z]/.test(raw) || !/\d/.test(raw)) {
    throw new AuthError(
      400,
      "A senha deve conter pelo menos 1 letra maiúscula, 1 letra minúscula e 1 número.",
    );
  }
  return raw;
}

export function validateRole(raw: unknown): AccountRole {
  if (raw === "admin" || raw === "viewer") {
    return raw;
  }
  throw new AuthError(400, "Papel inválido. Use 'admin' ou 'viewer'.");
}

function getSessionTtlMs(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'session_ttl_days'")
    .get() as { value: string } | undefined;
  const days = row ? Number.parseInt(row.value, 10) : 7;
  const safeDays = Number.isFinite(days) && days >= 1 && days <= 90 ? days : 7;
  return safeDays * 24 * 60 * 60 * 1000;
}

function createSessionInternal(
  db: DatabaseSync,
  accountId: number,
  meta?: { userAgent?: string | null; ipAddress?: string | null },
): { sessionToken: string; expiresAt: string } {
  const sessionToken = generateOpaqueToken(32);
  const tokenHash = sha256Hex(sessionToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getSessionTtlMs(db)).toISOString();

  db.prepare(
    `INSERT INTO sessions (token_hash, account_id, user_agent, ip_address, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenHash,
    accountId,
    meta?.userAgent ? meta.userAgent.slice(0, 255) : null,
    meta?.ipAddress ? meta.ipAddress.slice(0, 64) : null,
    now.toISOString(),
    expiresAt,
  );

  // Limpeza leve de sessões já expiradas desta conta
  db.prepare("DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?").run(
    accountId,
    now.toISOString(),
  );

  return { sessionToken, expiresAt };
}

export function countAccounts(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
  return row.count;
}

function countActiveAdmins(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM accounts WHERE role = 'admin' AND is_active = 1")
    .get() as { count: number };
  return row.count;
}

export function hasAnyAccount(db: DatabaseSync): boolean {
  return countAccounts(db) > 0;
}

/**
 * Cria o primeiro administrador a partir das variáveis de ambiente quando o banco ainda não tem contas.
 * Nunca sobrescreve contas já existentes.
 */
export async function bootstrapAdminFromEnv(
  db: DatabaseSync,
  username?: string,
  password?: string,
): Promise<boolean> {
  if (!username && !password) {
    return false;
  }
  if (!username || !password) {
    throw new AuthError(
      400,
      "Defina ambas as variáveis DASHBOARD_ADMIN_USERNAME e DASHBOARD_ADMIN_PASSWORD (ou nenhuma).",
    );
  }
  if (hasAnyAccount(db)) {
    return false;
  }

  const validUsername = validateUsername(username);
  const validPassword = validatePassword(password);
  const passwordHash = await hashPassword(validPassword);
  const now = new Date().toISOString();

  return runInTransaction(db, () => {
    if (hasAnyAccount(db)) {
      return false;
    }
    db.prepare(
      `INSERT INTO accounts (username, display_name, password_hash, role, is_active, created_at)
       VALUES (?, ?, ?, 'admin', 1, ?)`,
    ).run(validUsername, validUsername, passwordHash, now);
    return true;
  });
}

export async function setupInitialAdmin(
  db: DatabaseSync,
  input: {
    username: string;
    displayName: string;
    password: string;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<LoginResult> {
  if (hasAnyAccount(db)) {
    throw new AuthError(409, "A configuração inicial já foi concluída.");
  }

  const username = validateUsername(input.username);
  const displayName = validateDisplayName(input.displayName || input.username);
  const password = validatePassword(input.password);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  return runInTransaction(db, () => {
    if (hasAnyAccount(db)) {
      throw new AuthError(409, "A configuração inicial já foi concluída.");
    }

    const result = db
      .prepare(
        `INSERT INTO accounts (username, display_name, password_hash, role, is_active, created_at, last_login_at)
         VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
      )
      .run(username, displayName, passwordHash, now, now);

    const accountId = Number(result.lastInsertRowid);
    const { sessionToken, expiresAt } = createSessionInternal(db, accountId, {
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });

    const row = getAccountByIdOrThrow(db, accountId);
    return {
      account: toPublicAccount(row),
      sessionToken,
      expiresAt,
    };
  });
}

export async function login(
  db: DatabaseSync,
  input: {
    username: string;
    password: string;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<LoginResult> {
  const normalizedUsername = input.username.trim().toLowerCase();
  const password = typeof input.password === "string" ? input.password : "";

  if (!normalizedUsername || !password) {
    throw new AuthError(400, "Informe usuário e senha.");
  }

  const row = db
    .prepare("SELECT * FROM accounts WHERE username = ?")
    .get(normalizedUsername) as AccountRow | undefined;

  if (!row || row.is_active !== 1) {
    // Executa verificação dummy para manter tempo similar ao caso válido.
    await verifyPassword(password, await getDummyPasswordHash());
    throw new AuthError(401, "Usuário ou senha inválidos.");
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    throw new AuthError(401, "Usuário ou senha inválidos.");
  }

  const now = new Date().toISOString();
  const { sessionToken, expiresAt } = runInTransaction(db, () => {
    db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(now, row.id);
    return createSessionInternal(db, row.id, {
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });
  });

  return {
    account: toPublicAccount({ ...row, last_login_at: now }),
    sessionToken,
    expiresAt,
  };
}

export function validateSession(db: DatabaseSync, rawToken: string | undefined | null): SessionInfo | null {
  if (!rawToken || rawToken.length < 16) {
    return null;
  }

  const tokenHash = sha256Hex(rawToken);
  const now = new Date().toISOString();

  const row = db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.password_hash, a.role, a.is_active, a.created_at, a.last_login_at,
              s.expires_at
       FROM sessions s
       INNER JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as (AccountRow & { expires_at: string }) | undefined;

  if (!row) {
    return null;
  }

  if (row.expires_at <= now || row.is_active !== 1) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  return {
    account: toPublicAccount(row),
    tokenHash,
    expiresAt: row.expires_at,
  };
}

export function logoutSession(db: DatabaseSync, rawToken: string | undefined | null): void {
  if (!rawToken) {
    return;
  }
  const tokenHash = sha256Hex(rawToken);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function revokeAllSessionsForAccount(
  db: DatabaseSync,
  accountId: number,
  exceptTokenHash?: string,
): void {
  if (exceptTokenHash) {
    db.prepare("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?").run(
      accountId,
      exceptTokenHash,
    );
    return;
  }
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}

export function cleanupExpiredSessions(db: DatabaseSync): number {
  const result = db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(new Date().toISOString());
  return Number(result.changes);
}

export async function changeOwnPassword(
  db: DatabaseSync,
  input: {
    accountId: number;
    currentPassword: string;
    newPassword: string;
    currentTokenHash?: string;
  },
): Promise<void> {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(input.accountId) as
    | AccountRow
    | undefined;
  if (!row || row.is_active !== 1) {
    throw new AuthError(404, "Conta não encontrada.");
  }

  const valid = await verifyPassword(input.currentPassword || "", row.password_hash);
  if (!valid) {
    throw new AuthError(401, "Senha atual incorreta.");
  }

  const validatedNew = validatePassword(input.newPassword);
  const newHash = await hashPassword(validatedNew);

  runInTransaction(db, () => {
    db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(newHash, row.id);
    revokeAllSessionsForAccount(db, row.id, input.currentTokenHash);
  });
}

export async function registerWithInvite(
  db: DatabaseSync,
  input: {
    inviteCode: string;
    username: string;
    displayName: string;
    password: string;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<LoginResult> {
  const normalizedCode = normalizeInviteCode(input.inviteCode || "");
  if (normalizedCode.length < 8) {
    throw new AuthError(400, "Código de convite inválido.");
  }

  const username = validateUsername(input.username);
  const displayName = validateDisplayName(input.displayName || input.username);
  const password = validatePassword(input.password);
  const codeHash = sha256Hex(normalizedCode);

  // Checagem preliminar antes de gastar CPU no scrypt
  const preliminaryInvite = db
    .prepare("SELECT id, used_at, revoked_at, expires_at FROM invite_codes WHERE code_hash = ?")
    .get(codeHash) as
    | { id: number; used_at: string | null; revoked_at: string | null; expires_at: string }
    | undefined;

  const preNow = new Date().toISOString();
  if (
    !preliminaryInvite ||
    preliminaryInvite.used_at ||
    preliminaryInvite.revoked_at ||
    preliminaryInvite.expires_at <= preNow
  ) {
    throw new AuthError(400, "Código de convite inválido, já utilizado ou expirado.");
  }

  const existingUser = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
  if (existingUser) {
    throw new AuthError(409, "Este nome de usuário já está em uso.");
  }

  const passwordHash = await hashPassword(password);

  return runInTransaction(db, () => {
    const now = new Date().toISOString();
    const invite = db
      .prepare(
        "SELECT id, role, created_by, used_at, revoked_at, expires_at FROM invite_codes WHERE code_hash = ?",
      )
      .get(codeHash) as
      | {
          id: number;
          role: AccountRole;
          created_by: number | null;
          used_at: string | null;
          revoked_at: string | null;
          expires_at: string;
        }
      | undefined;

    if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= now) {
      throw new AuthError(400, "Código de convite inválido, já utilizado ou expirado.");
    }

    const dup = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (dup) {
      throw new AuthError(409, "Este nome de usuário já está em uso.");
    }

    const inserted = db
      .prepare(
        `INSERT INTO accounts (username, display_name, password_hash, role, is_active, created_by, created_at, last_login_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(username, displayName, passwordHash, invite.role, invite.created_by, now, now);

    const accountId = Number(inserted.lastInsertRowid);
    db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?").run(
      accountId,
      now,
      invite.id,
    );

    const { sessionToken, expiresAt } = createSessionInternal(db, accountId, {
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });

    const row = getAccountByIdOrThrow(db, accountId);
    return {
      account: toPublicAccount(row),
      sessionToken,
      expiresAt,
    };
  });
}

export function listAccounts(db: DatabaseSync): PublicAccount[] {
  const rows = db
    .prepare(
      `SELECT id, username, display_name, password_hash, role, is_active, created_at, last_login_at
       FROM accounts
       ORDER BY created_at ASC`,
    )
    .all() as unknown as AccountRow[];
  return rows.map(toPublicAccount);
}

export async function createAccountByAdmin(
  db: DatabaseSync,
  input: {
    actorId: number;
    username: string;
    displayName: string;
    password: string;
    role: AccountRole;
  },
): Promise<PublicAccount> {
  const username = validateUsername(input.username);
  const displayName = validateDisplayName(input.displayName || input.username);
  const password = validatePassword(input.password);
  const role = validateRole(input.role);

  const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
  if (existing) {
    throw new AuthError(409, "Este nome de usuário já está em uso.");
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  return runInTransaction(db, () => {
    const dup = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (dup) {
      throw new AuthError(409, "Este nome de usuário já está em uso.");
    }

    const inserted = db
      .prepare(
        `INSERT INTO accounts (username, display_name, password_hash, role, is_active, created_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(username, displayName, passwordHash, role, input.actorId, now);

    const row = getAccountByIdOrThrow(db, Number(inserted.lastInsertRowid));
    return toPublicAccount(row);
  });
}

export async function updateAccountByAdmin(
  db: DatabaseSync,
  input: {
    actorId: number;
    targetId: number;
    displayName?: string;
    role?: AccountRole;
    isActive?: boolean;
    newPassword?: string;
  },
): Promise<PublicAccount> {
  const target = db.prepare("SELECT * FROM accounts WHERE id = ?").get(input.targetId) as
    | AccountRow
    | undefined;
  if (!target) {
    throw new AuthError(404, "Conta não encontrada.");
  }

  const nextDisplayName =
    input.displayName !== undefined ? validateDisplayName(input.displayName) : target.display_name;
  const nextRole = input.role !== undefined ? validateRole(input.role) : target.role;
  const nextActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : target.is_active;

  if (input.actorId === target.id && nextActive === 0) {
    throw new AuthError(400, "Você não pode desativar a própria conta.");
  }

  const wouldRemoveAdmin =
    target.role === "admin" && target.is_active === 1 && (nextRole !== "admin" || nextActive === 0);

  let nextPasswordHash: string | null = null;
  if (input.newPassword !== undefined && input.newPassword.length > 0) {
    nextPasswordHash = await hashPassword(validatePassword(input.newPassword));
  }

  return runInTransaction(db, () => {
    if (wouldRemoveAdmin && countActiveAdmins(db) <= 1) {
      throw new AuthError(400, "Não é possível remover ou desativar o último administrador ativo.");
    }

    if (nextPasswordHash) {
      db.prepare(
        `UPDATE accounts
         SET display_name = ?, role = ?, is_active = ?, password_hash = ?
         WHERE id = ?`,
      ).run(nextDisplayName, nextRole, nextActive, nextPasswordHash, target.id);
    } else {
      db.prepare(
        `UPDATE accounts
         SET display_name = ?, role = ?, is_active = ?
         WHERE id = ?`,
      ).run(nextDisplayName, nextRole, nextActive, target.id);
    }

    // Revoga sessões se a conta foi desativada ou teve a senha resetada
    if (nextActive === 0 || nextPasswordHash) {
      revokeAllSessionsForAccount(db, target.id);
    }

    const updated = getAccountByIdOrThrow(db, target.id);
    return toPublicAccount(updated);
  });
}

export function deleteAccountByAdmin(db: DatabaseSync, actorId: number, targetId: number): void {
  if (actorId === targetId) {
    throw new AuthError(400, "Você não pode excluir a própria conta.");
  }

  runInTransaction(db, () => {
    const target = db.prepare("SELECT * FROM accounts WHERE id = ?").get(targetId) as
      | AccountRow
      | undefined;
    if (!target) {
      throw new AuthError(404, "Conta não encontrada.");
    }

    if (target.role === "admin" && target.is_active === 1 && countActiveAdmins(db) <= 1) {
      throw new AuthError(400, "Não é possível excluir o último administrador ativo.");
    }

    db.prepare("DELETE FROM accounts WHERE id = ?").run(targetId);
  });
}

export function createInvite(
  db: DatabaseSync,
  input: {
    actorId: number;
    role: AccountRole;
    expiresInHours?: number;
    note?: string;
  },
): CreatedInviteResult {
  const role = validateRole(input.role);
  const hours =
    typeof input.expiresInHours === "number" && Number.isFinite(input.expiresInHours)
      ? Math.round(input.expiresInHours)
      : 48;
  if (hours < 1 || hours > 720) {
    throw new AuthError(400, "A validade do convite deve ficar entre 1 e 720 horas (30 dias).");
  }

  const note = input.note?.trim() ? input.note.trim().slice(0, 120) : null;
  const code = generateInviteCode();
  const normalized = normalizeInviteCode(code);
  const codeHash = sha256Hex(normalized);
  const codePrefix = code.slice(0, 9); // XXXX-XXXX
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

  const inserted = db
    .prepare(
      `INSERT INTO invite_codes (code_hash, code_prefix, role, note, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(codeHash, codePrefix, role, note, input.actorId, expiresAt, now.toISOString());

  const id = Number(inserted.lastInsertRowid);
  const invites = listInvites(db);
  const created = invites.find((item) => item.id === id);
  if (!created) {
    throw new Error("Falha ao carregar convite recém-criado.");
  }

  return { invite: created, code };
}

export function listInvites(db: DatabaseSync): InviteSummary[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT i.id, i.code_prefix, i.role, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at,
              creator.username AS created_by_username,
              consumer.username AS used_by_username
       FROM invite_codes i
       LEFT JOIN accounts creator ON creator.id = i.created_by
       LEFT JOIN accounts consumer ON consumer.id = i.used_by
       ORDER BY i.created_at DESC
       LIMIT 100`,
    )
    .all() as Array<{
    id: number;
    code_prefix: string;
    role: AccountRole;
    note: string | null;
    created_at: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
    created_by_username: string | null;
    used_by_username: string | null;
  }>;

  return rows.map((row) => {
    let status: InviteSummary["status"] = "active";
    if (row.used_at) {
      status = "used";
    } else if (row.revoked_at) {
      status = "revoked";
    } else if (row.expires_at <= now) {
      status = "expired";
    }

    return {
      id: row.id,
      codePrefix: row.code_prefix,
      role: row.role,
      note: row.note,
      status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
      createdByUsername: row.created_by_username,
      usedByUsername: row.used_by_username,
    };
  });
}

export function revokeInvite(db: DatabaseSync, inviteId: number): void {
  const row = db
    .prepare("SELECT id, used_at, revoked_at FROM invite_codes WHERE id = ?")
    .get(inviteId) as { id: number; used_at: string | null; revoked_at: string | null } | undefined;

  if (!row) {
    throw new AuthError(404, "Convite não encontrado.");
  }
  if (row.used_at) {
    throw new AuthError(400, "Este convite já foi utilizado.");
  }
  if (row.revoked_at) {
    return;
  }

  db.prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    inviteId,
  );
}
