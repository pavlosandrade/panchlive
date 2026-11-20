import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { Readable } from "node:stream";
import { openDatabase } from "../db/database.js";
import {
  finishTrackPlay,
  insertTrackPlay,
  upsertDiscordGuild,
  upsertDiscordUser,
} from "../stats/repository.js";
import { createWebServer, type LiveSnapshot } from "./server.js";

interface MockResponseResult {
  status: number;
  headers: Map<string, string | string[]>;
  text: string;
  json: <T = unknown>() => T;
  getHeader: (name: string) => string | null;
}

async function dispatchRequest(
  server: http.Server,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    remoteAddress?: string;
    encrypted?: boolean;
  },
): Promise<MockResponseResult> {
  const payloadText = options.body !== undefined ? JSON.stringify(options.body) : "";
  const reqStream = Readable.from(payloadText ? [Buffer.from(payloadText, "utf8")] : []);

  const normalizedHeaders: Record<string, string> = { host: "dashboard.example.com" };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const fakeReq = Object.assign(reqStream, {
    method: options.method ?? "GET",
    url: options.path,
    headers: normalizedHeaders,
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
      encrypted: options.encrypted ?? false,
    },
  }) as unknown as http.IncomingMessage;

  const headers = new Map<string, string | string[]>();
  const chunks: Buffer[] = [];

  return await new Promise<MockResponseResult>((resolve) => {
    const fakeRes = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name: string, value: number | string | readonly string[]) {
        headers.set(
          name.toLowerCase(),
          Array.isArray(value) ? [...value] : String(value),
        );
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
        }
        fakeRes.writableEnded = true;
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: fakeRes.statusCode,
          headers,
          text,
          json: <T = unknown>() => JSON.parse(text) as T,
          getHeader: (name: string) => {
            const val = headers.get(name.toLowerCase());
            if (val === undefined) return null;
            return Array.isArray(val) ? val.join("; ") : val;
          },
        });
      },
    } as unknown as http.ServerResponse;

    server.emit("request", fakeReq, fakeRes);
  });
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, "Cabeçalho Set-Cookie ausente");
  return setCookieHeader.split(";")[0];
}

const dummyLive: LiveSnapshot = {
  bot: { tag: "PanchLive#0001", ready: true, uptimeSeconds: 120, guildCount: 1 },
  nodes: [{ id: "main-node", connected: true, players: 1, playingPlayers: 1 }],
  players: [],
};

describe("web/server", () => {
  it("serve assets estáticos com segurança e bloqueia path traversal", async () => {
    const db = openDatabase(":memory:");
    const server = createWebServer({
      db,
      isProduction: false,
      trustProxy: false,
      requireHttps: false,
      getBotTag: () => "PanchLive#0001",
      getLiveSnapshot: () => dummyLive,
    });

    try {
      const rootRes = await dispatchRequest(server, { path: "/" });
      assert.equal(rootRes.status, 200);
      assert.ok(rootRes.getHeader("content-type")?.includes("text/html"));
      assert.ok(rootRes.text.includes("PanchLive Dashboard"));
      assert.ok(rootRes.getHeader("content-security-policy")?.includes("script-src 'self'"));
      assert.equal(rootRes.getHeader("x-robots-tag"), "noindex, nofollow, noarchive");

      const jsRes = await dispatchRequest(server, { path: "/assets/app.js" });
      assert.equal(jsRes.status, 200);
      assert.ok(jsRes.getHeader("content-type")?.includes("application/javascript"));

      const logoRes = await dispatchRequest(server, { path: "/assets/logo.jpg" });
      assert.equal(logoRes.status, 200);
      assert.equal(logoRes.getHeader("content-type"), "image/jpeg");
      assert.ok(Number(logoRes.getHeader("content-length")) > 1000);

      const faviconRes = await dispatchRequest(server, { path: "/favicon.ico" });
      assert.equal(faviconRes.status, 200);
      assert.equal(faviconRes.getHeader("content-type"), "image/x-icon");

      const appleIconRes = await dispatchRequest(server, { path: "/apple-touch-icon.png" });
      assert.equal(appleIconRes.status, 200);
      assert.equal(appleIconRes.getHeader("content-type"), "image/png");

      const manifestRes = await dispatchRequest(server, { path: "/site.webmanifest" });
      assert.equal(manifestRes.status, 200);
      assert.ok(manifestRes.getHeader("content-type")?.includes("application/manifest+json"));
      assert.equal(manifestRes.json<{ short_name: string }>().short_name, "PanchLive");

      const robotsRes = await dispatchRequest(server, { path: "/robots.txt" });
      assert.equal(robotsRes.status, 200);
      assert.ok(robotsRes.getHeader("content-type")?.includes("text/plain"));
      assert.ok(robotsRes.text.includes("User-agent: GPTBot"));

      const traversalRes = await dispatchRequest(server, { path: "/assets/..%2Fpackage.json" });
      assert.equal(traversalRes.status, 404);
    } finally {
      server.close();
      db.close();
    }
  });

  it("injeta URLs absolutas de Open Graph quando publicUrl está configurado", async () => {
    const db = openDatabase(":memory:");
    const server = createWebServer({
      db,
      isProduction: true,
      trustProxy: true,
      requireHttps: true,
      publicUrl: "https://dash.panchlive.example/",
      getBotTag: () => "PanchLive#0001",
      getLiveSnapshot: () => dummyLive,
    });

    try {
      const rootRes = await dispatchRequest(server, {
        path: "/",
        headers: { "X-Forwarded-Proto": "https" },
      });
      assert.equal(rootRes.status, 200);
      assert.ok(
        rootRes.text.includes('<meta property="og:url" content="https://dash.panchlive.example/" />'),
      );
      assert.ok(
        rootRes.text.includes(
          '<meta property="og:image" content="https://dash.panchlive.example/assets/icon-512.png" />',
        ),
      );
      assert.ok(
        rootRes.text.includes(
          '<meta name="twitter:image" content="https://dash.panchlive.example/assets/icon-512.png" />',
        ),
      );
    } finally {
      server.close();
      db.close();
    }
  });

  it("impõe trava HTTPS fail-closed em produção e rejeita spoofing de X-Forwarded-Proto sem trustProxy", async () => {
    const db = openDatabase(":memory:");
    const server = createWebServer({
      db,
      isProduction: true,
      trustProxy: false,
      requireHttps: true,
      setupToken: "segredo-setup-123",
      getBotTag: () => "PanchLive#0001",
      getLiveSnapshot: () => dummyLive,
    });

    try {
      // /health continua acessível mesmo em HTTP interno
      const healthRes = await dispatchRequest(server, { path: "/health" });
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.json<{ status: string }>().status, "ok");

      // /api/auth/status sinaliza bloqueio HTTPS sem vazar needsSetup
      const statusRes = await dispatchRequest(server, { path: "/api/auth/status" });
      assert.equal(statusRes.status, 200);
      const statusBody = statusRes.json<{
        httpsRequired: boolean;
        isSecure: boolean;
        needsSetup: boolean;
      }>();
      assert.equal(statusBody.httpsRequired, true);
      assert.equal(statusBody.isSecure, false);
      assert.equal(statusBody.needsSetup, false);

      // Login sem HTTPS -> 426
      const loginHttp = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/login",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: { username: "admin", password: "Password123" },
      });
      assert.equal(loginHttp.status, 426);

      // Tentativa de forjar X-Forwarded-Proto quando trustProxy=false -> continua 426
      const spoofed = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/login",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "fetch",
          "X-Forwarded-Proto": "https",
        },
        body: { username: "admin", password: "Password123" },
      });
      assert.equal(spoofed.status, 426);

      // Socket TLS direto funciona mesmo com trustProxy=false
      const statusTls = await dispatchRequest(server, {
        path: "/api/auth/status",
        encrypted: true,
      });
      assert.equal(statusTls.status, 200);
      assert.equal(statusTls.json<{ isSecure: boolean; needsSetup: boolean }>().isSecure, true);
      assert.equal(statusTls.json<{ isSecure: boolean; needsSetup: boolean }>().needsSetup, true);
    } finally {
      server.close();
      db.close();
    }
  });

  it("bloqueia setup em produção quando não há setupToken configurado", async () => {
    const db = openDatabase(":memory:");
    const server = createWebServer({
      db,
      isProduction: true,
      trustProxy: true,
      requireHttps: true,
      getBotTag: () => "PanchLive#0001",
      getLiveSnapshot: () => dummyLive,
    });

    try {
      const statusRes = await dispatchRequest(server, {
        path: "/api/auth/status",
        headers: { "X-Forwarded-Proto": "https" },
      });
      assert.equal(statusRes.json<{ setupMode: string }>().setupMode, "disabled");

      const setupRes = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/setup",
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Requested-With": "fetch",
          "Content-Type": "application/json",
        },
        body: {
          username: "admin",
          displayName: "Admin",
          password: "AdminPassword123",
        },
      });
      assert.equal(setupRes.status, 403);
    } finally {
      server.close();
      db.close();
    }
  });

  it("executa fluxo completo sobre HTTPS (proxy confiável): setup com token, CSRF, convite, RBAC e estatísticas", async () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    upsertDiscordGuild(db, { guildId: "g1", name: "Guilda Teste" });
    upsertDiscordUser(db, { userId: "u1", username: "dj", displayName: "DJ Teste" });
    const playId = insertTrackPlay(db, {
      guildId: "g1",
      trackKey: "youtube:dQw4w9WgXcQ",
      identifier: "dQw4w9WgXcQ",
      title: "Faixa Teste",
      author: "Artista Teste",
      platform: "youtube",
      durationMs: 200_000,
      isStream: false,
      requesterId: "u1",
      isLoop: false,
      startedAt: now - 250_000,
    });
    finishTrackPlay(db, {
      playId,
      endedAt: now - 50_000,
      listenedMs: 200_000,
      endReason: "finished",
    });

    const server = createWebServer({
      db,
      isProduction: true,
      trustProxy: true,
      requireHttps: true,
      setupToken: "token-inicial-seguro",
      getBotTag: () => "PanchLive#0001",
      getLiveSnapshot: () => dummyLive,
    });

    const httpsHeaders = {
      "X-Forwarded-Proto": "https",
      "X-Requested-With": "fetch",
      "Content-Type": "application/json",
      Origin: "https://dashboard.example.com",
    };

    try {
      // Sem header anti-CSRF -> 403
      const noCsrf = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/setup",
        headers: { "X-Forwarded-Proto": "https", "Content-Type": "application/json" },
        body: {},
      });
      assert.equal(noCsrf.status, 403);

      // Origin de domínio diferente -> 403
      const badOrigin = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/setup",
        headers: { ...httpsHeaders, Origin: "https://evil.example.com" },
        body: {},
      });
      assert.equal(badOrigin.status, 403);

      // Setup com token errado -> 403
      const badToken = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/setup",
        headers: httpsHeaders,
        body: {
          setupToken: "errado",
          username: "admin",
          displayName: "Admin",
          password: "AdminPassword123",
        },
      });
      assert.equal(badToken.status, 403);

      // Setup com token válido -> 201 + cookie Secure + HSTS
      const setupRes = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/setup",
        headers: httpsHeaders,
        body: {
          setupToken: "token-inicial-seguro",
          username: "admin",
          displayName: "Admin",
          password: "AdminPassword123",
        },
      });
      assert.equal(setupRes.status, 201);
      assert.ok(setupRes.getHeader("strict-transport-security")?.includes("max-age="));
      const adminSetCookie = setupRes.getHeader("set-cookie");
      assert.ok(adminSetCookie?.includes("Secure"));
      assert.ok(adminSetCookie?.includes("HttpOnly"));
      const adminCookie = extractCookiePair(adminSetCookie);

      // Admin gera convite viewer
      const inviteRes = await dispatchRequest(server, {
        method: "POST",
        path: "/api/invites",
        headers: { ...httpsHeaders, Cookie: adminCookie },
        body: { role: "viewer", expiresInHours: 12, note: "Teste" },
      });
      assert.equal(inviteRes.status, 201);
      const { code: inviteCode } = inviteRes.json<{ code: string }>();
      assert.ok(inviteCode.length >= 20);

      // Novo usuário cria conta com convite
      const regRes = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/register",
        headers: httpsHeaders,
        body: {
          inviteCode,
          username: "membro",
          displayName: "Membro",
          password: "MembroPassword123",
        },
      });
      assert.equal(regRes.status, 201);
      const viewerCookie = extractCookiePair(regRes.getHeader("set-cookie"));

      // Viewer consegue ler estatísticas, guilds, top tracks, top users, activity, recent e live
      const statsRes = await dispatchRequest(server, {
        path: "/api/stats/overview?guildId=g1&range=7d",
        headers: { "X-Forwarded-Proto": "https", Cookie: viewerCookie },
      });
      assert.equal(statsRes.status, 200);
      assert.equal(statsRes.json<{ overview: { totalPlays: number } }>().overview.totalPlays, 1);

      const liveRes = await dispatchRequest(server, {
        path: "/api/live?guildId=g1",
        headers: { "X-Forwarded-Proto": "https", Cookie: viewerCookie },
      });
      assert.equal(liveRes.status, 200);
      assert.equal(liveRes.json<LiveSnapshot>().bot.tag, "PanchLive#0001");

      // Viewer é bloqueado em rotas de administração (403)
      const forbiddenAccounts = await dispatchRequest(server, {
        path: "/api/accounts",
        headers: { "X-Forwarded-Proto": "https", Cookie: viewerCookie },
      });
      assert.equal(forbiddenAccounts.status, 403);

      const forbiddenSettings = await dispatchRequest(server, {
        method: "PATCH",
        path: "/api/settings",
        headers: { ...httpsHeaders, Cookie: viewerCookie },
        body: { dashboardTitle: "Hack" },
      });
      assert.equal(forbiddenSettings.status, 403);

      // Admin atualiza configurações com sucesso
      const patchSettings = await dispatchRequest(server, {
        method: "PATCH",
        path: "/api/settings",
        headers: { ...httpsHeaders, Cookie: adminCookie },
        body: { dashboardTitle: "PanchLive Stats", minPlaySeconds: 10 },
      });
      assert.equal(patchSettings.status, 200);
      assert.equal(
        patchSettings.json<{ settings: { dashboardTitle: string } }>().settings.dashboardTitle,
        "PanchLive Stats",
      );

      // Logout invalida sessão do viewer
      const logoutRes = await dispatchRequest(server, {
        method: "POST",
        path: "/api/auth/logout",
        headers: { ...httpsHeaders, Cookie: viewerCookie },
      });
      assert.equal(logoutRes.status, 200);

      const afterLogout = await dispatchRequest(server, {
        path: "/api/stats/overview",
        headers: { "X-Forwarded-Proto": "https", Cookie: viewerCookie },
      });
      assert.equal(afterLogout.status, 401);
    } finally {
      server.close();
      db.close();
    }
  });
});
