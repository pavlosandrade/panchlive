import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { safeEqualString } from "../auth/crypto.js";
import { SlidingWindowRateLimiter } from "../auth/rate-limit.js";
import {
  AuthError,
  changeOwnPassword,
  cleanupExpiredSessions,
  createAccountByAdmin,
  createInvite,
  deleteAccountByAdmin,
  hasAnyAccount,
  listAccounts,
  listInvites,
  login,
  logoutSession,
  registerWithInvite,
  revokeAllSessionsForAccount,
  revokeInvite,
  setupInitialAdmin,
  updateAccountByAdmin,
  validateSession,
  type AccountRole,
  type SessionInfo,
} from "../auth/service.js";
import { getLastError } from "../error-store.js";
import {
  PlayerControlError,
  type PlayerControlService,
} from "../music/web-controller.js";
import {
  getActivityStats,
  getDashboardSettings,
  getOverviewStats,
  getRecentPlays,
  getTopTracks,
  getTopUsers,
  listGuilds,
  parseStatsRange,
  SettingsValidationError,
  updateDashboardSettings,
} from "../stats/repository.js";
import {
  applySecurityHeaders,
  buildClearSessionCookie,
  buildSessionCookie,
  getClientIp,
  HttpRequestError,
  isLoopbackAddress,
  isSecureRequest,
  parseCookies,
  readJsonBody,
  sendJson,
  serveStaticAsset,
  SESSION_COOKIE_NAME,
  verifyCsrfProtection,
} from "./http-utils.js";

export interface LiveTrackSummary {
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  platform: "youtube" | "spotify";
  durationMs: number;
  isStream: boolean;
  requesterName: string | null;
}

export interface LivePlayerSnapshot {
  guildId: string;
  guildName: string;
  voiceChannelName: string | null;
  playing: boolean;
  paused: boolean;
  volume: number;
  repeatMode: string;
  positionMs: number;
  queueLength: number;
  currentTrack: LiveTrackSummary | null;
  upcoming: LiveTrackSummary[];
}

export interface LiveSnapshot {
  bot: {
    tag: string;
    ready: boolean;
    uptimeSeconds: number;
    guildCount: number;
  };
  nodes: Array<{
    id: string;
    connected: boolean;
    players: number;
    playingPlayers: number;
  }>;
  players: LivePlayerSnapshot[];
}

export interface WebServerOptions {
  db: DatabaseSync;
  isProduction: boolean;
  trustProxy: boolean;
  requireHttps: boolean;
  publicUrl?: string;
  setupToken?: string;
  publicDir?: string;
  getBotTag: () => string;
  getLiveSnapshot: (guildId?: string) => LiveSnapshot;
  playerControl?: PlayerControlService;
}

const DEFAULT_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public",
);

function getStringField(body: Record<string, unknown>, field: string): string {
  const val = body[field];
  return typeof val === "string" ? val : "";
}

function parsePositiveId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpRequestError(400, "ID inválido.");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpRequestError(400, "ID inválido.");
  }
  return parsed;
}

function getSetupMode(
  req: http.IncomingMessage,
  options: WebServerOptions,
): "disabled" | "token" | "local" {
  if (options.setupToken) {
    return "token";
  }
  if (!options.isProduction && isLoopbackAddress(req.socket?.remoteAddress)) {
    return "local";
  }
  return "disabled";
}

const ROOT_PUBLIC_FILES: Record<string, string> = {
  "/favicon.ico": "favicon.ico",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/site.webmanifest": "site.webmanifest",
  "/robots.txt": "robots.txt",
};

function normalizePublicOrigin(raw?: string): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createWebServer(options: WebServerOptions): http.Server {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const publicOrigin = normalizePublicOrigin(options.publicUrl);
  const authRateLimiter = new SlidingWindowRateLimiter(15, 15 * 60 * 1000);
  const setupRateLimiter = new SlidingWindowRateLimiter(10, 15 * 60 * 1000);
  const playerControlRateLimiter = new SlidingWindowRateLimiter(60, 60 * 1000);

  // Limpeza periódica de sessões expiradas (a cada 1 hora)
  const cleanupTimer = setInterval(() => {
    try {
      cleanupExpiredSessions(options.db);
    } catch {
      // Ignora erro caso o banco já esteja fechando
    }
  }, 60 * 60 * 1000);
  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (res.writableEnded) {
        return;
      }
      if (
        err instanceof HttpRequestError ||
        err instanceof AuthError ||
        err instanceof SettingsValidationError ||
        err instanceof PlayerControlError
      ) {
        sendJson(res, err.statusCode, { error: err.message });
        return;
      }
      console.error("[Web] Erro interno na requisição:", err);
      sendJson(res, 500, { error: "Erro interno no servidor." });
    });
  });

  server.on("close", () => {
    clearInterval(cleanupTimer);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const isSecure = isSecureRequest(req, options.trustProxy);
    const isApi = pathname.startsWith("/api/") || pathname === "/health";

    applySecurityHeaders(res, { isSecure, isApi });

    // Healthcheck público interno (sem dados sensíveis nem cookies)
    if (pathname === "/health" && method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        bot: options.getBotTag(),
        uptimeSeconds: Math.floor(process.uptime()),
        lastError: getLastError(),
      });
      return;
    }

    // Assets estáticos e SPA raiz
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      if (publicOrigin) {
        try {
          const rawHtml = fs.readFileSync(path.resolve(publicDir, "index.html"), "utf8");
          const renderedHtml = rawHtml
            .replaceAll('content="/assets/icon-512.png"', `content="${publicOrigin}/assets/icon-512.png"`)
            .replace(
              '<meta property="og:type" content="website" />',
              `<meta property="og:type" content="website" />\n    <meta property="og:url" content="${publicOrigin}/" />`,
            );
          const buf = Buffer.from(renderedHtml, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Content-Length", buf.length);
          res.setHeader("Cache-Control", "no-cache");
          res.end(buf);
          return;
        } catch {
          sendJson(res, 404, { error: "Interface da dashboard não encontrada." });
          return;
        }
      }
      if (!serveStaticAsset(res, publicDir, "index.html", options.isProduction)) {
        sendJson(res, 404, { error: "Interface da dashboard não encontrada." });
      }
      return;
    }

    const rootPublicFile = method === "GET" ? ROOT_PUBLIC_FILES[pathname] : undefined;
    if (rootPublicFile) {
      if (!serveStaticAsset(res, publicDir, rootPublicFile, options.isProduction)) {
        sendJson(res, 404, { error: "Arquivo não encontrado." });
      }
      return;
    }

    if (method === "GET" && pathname.startsWith("/assets/")) {
      const assetName = pathname.slice("/assets/".length);
      if (assetName && !assetName.includes("/") && !assetName.includes("\\")) {
        if (serveStaticAsset(res, publicDir, assetName, options.isProduction)) {
          return;
        }
      }
      sendJson(res, 404, { error: "Arquivo não encontrado." });
      return;
    }

    // Status de autenticação (sempre acessível para a UI saber se há bloqueio HTTPS ou setup)
    if (pathname === "/api/auth/status" && method === "GET") {
      const settings = getDashboardSettings(options.db);
      if (options.requireHttps && !isSecure) {
        sendJson(res, 200, {
          httpsRequired: true,
          isSecure: false,
          needsSetup: false,
          setupMode: "disabled",
          authenticated: false,
          account: null,
          dashboardTitle: settings.dashboardTitle,
        });
        return;
      }

      const needsSetup = !hasAnyAccount(options.db);
      const cookies = parseCookies(req);
      const session = needsSetup
        ? null
        : validateSession(options.db, cookies.get(SESSION_COOKIE_NAME));

      sendJson(res, 200, {
        httpsRequired: options.requireHttps,
        isSecure,
        needsSetup,
        setupMode: needsSetup ? getSetupMode(req, options) : "disabled",
        authenticated: Boolean(session),
        account: session?.account ?? null,
        dashboardTitle: settings.dashboardTitle,
      });
      return;
    }

    // Trava HTTPS fail-closed para todas as demais rotas /api/*
    if (pathname.startsWith("/api/")) {
      if (options.requireHttps && !isSecure) {
        sendJson(res, 426, {
          error: "HTTPS obrigatório para autenticação e acesso à dashboard.",
          code: "HTTPS_REQUIRED",
        });
        return;
      }

      // Proteção CSRF em qualquer requisição de mutação
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        verifyCsrfProtection(req, options.trustProxy);
      }

      const clientIp = getClientIp(req, options.trustProxy);
      const cookieSecure = options.requireHttps || isSecure;

      // Rotas públicas de autenticação (já protegidas pela trava HTTPS acima)
      if (pathname === "/api/auth/setup" && method === "POST") {
        const limit = setupRateLimiter.check(`setup:${clientIp}`);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            { error: "Muitas tentativas. Aguarde antes de tentar novamente." },
            { "Retry-After": String(limit.retryAfterSeconds) },
          );
          return;
        }

        const setupMode = getSetupMode(req, options);
        if (setupMode === "disabled") {
          throw new HttpRequestError(
            403,
            "Configuração inicial pela web desabilitada em produção. Defina DASHBOARD_ADMIN_USERNAME e DASHBOARD_ADMIN_PASSWORD (ou DASHBOARD_SETUP_TOKEN) no .env.",
          );
        }

        const body = await readJsonBody(req);
        if (setupMode === "token") {
          const providedToken = getStringField(body, "setupToken").trim();
          if (!providedToken || !options.setupToken || !safeEqualString(providedToken, options.setupToken)) {
            throw new AuthError(403, "Token de configuração inicial inválido.");
          }
        }

        const result = await setupInitialAdmin(options.db, {
          username: getStringField(body, "username"),
          displayName: getStringField(body, "displayName"),
          password: getStringField(body, "password"),
          userAgent: req.headers["user-agent"] ?? null,
          ipAddress: clientIp,
        });

        sendJson(
          res,
          201,
          { account: result.account },
          {
            "Set-Cookie": buildSessionCookie(result.sessionToken, result.expiresAt, cookieSecure),
          },
        );
        return;
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        const body = await readJsonBody(req);
        const usernameForKey = getStringField(body, "username").trim().toLowerCase().slice(0, 32);
        const ipLimit = authRateLimiter.check(`login:ip:${clientIp}`);
        const userLimit = usernameForKey
          ? authRateLimiter.check(`login:user:${clientIp}:${usernameForKey}`)
          : { allowed: true, retryAfterSeconds: 0 };

        if (!ipLimit.allowed || !userLimit.allowed) {
          const retry = Math.max(ipLimit.retryAfterSeconds, userLimit.retryAfterSeconds);
          sendJson(
            res,
            429,
            { error: "Muitas tentativas de login. Tente novamente em alguns minutos." },
            { "Retry-After": String(retry) },
          );
          return;
        }

        const result = await login(options.db, {
          username: getStringField(body, "username"),
          password: getStringField(body, "password"),
          userAgent: req.headers["user-agent"] ?? null,
          ipAddress: clientIp,
        });

        authRateLimiter.reset(`login:user:${clientIp}:${result.account.username}`);

        sendJson(
          res,
          200,
          { account: result.account },
          {
            "Set-Cookie": buildSessionCookie(result.sessionToken, result.expiresAt, cookieSecure),
          },
        );
        return;
      }

      if (pathname === "/api/auth/register" && method === "POST") {
        const limit = authRateLimiter.check(`register:${clientIp}`);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            { error: "Muitas tentativas de cadastro. Aguarde antes de tentar novamente." },
            { "Retry-After": String(limit.retryAfterSeconds) },
          );
          return;
        }

        const body = await readJsonBody(req);
        const result = await registerWithInvite(options.db, {
          inviteCode: getStringField(body, "inviteCode"),
          username: getStringField(body, "username"),
          displayName: getStringField(body, "displayName"),
          password: getStringField(body, "password"),
          userAgent: req.headers["user-agent"] ?? null,
          ipAddress: clientIp,
        });

        sendJson(
          res,
          201,
          { account: result.account },
          {
            "Set-Cookie": buildSessionCookie(result.sessionToken, result.expiresAt, cookieSecure),
          },
        );
        return;
      }

      if (pathname === "/api/auth/logout" && method === "POST") {
        const cookies = parseCookies(req);
        logoutSession(options.db, cookies.get(SESSION_COOKIE_NAME));
        sendJson(
          res,
          200,
          { ok: true },
          { "Set-Cookie": buildClearSessionCookie(cookieSecure) },
        );
        return;
      }

      // A partir daqui, toda rota exige sessão válida
      const session = requireSession(req);

      if (pathname === "/api/auth/logout-all" && method === "POST") {
        revokeAllSessionsForAccount(options.db, session.account.id);
        sendJson(
          res,
          200,
          { ok: true },
          { "Set-Cookie": buildClearSessionCookie(cookieSecure) },
        );
        return;
      }

      if (pathname === "/api/auth/change-password" && method === "POST") {
        const body = await readJsonBody(req);
        await changeOwnPassword(options.db, {
          accountId: session.account.id,
          currentPassword: getStringField(body, "currentPassword"),
          newPassword: getStringField(body, "newPassword"),
          currentTokenHash: session.tokenHash,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      // Rotas de leitura da Dashboard (viewer e admin)
      if (pathname === "/api/guilds" && method === "GET") {
        sendJson(res, 200, { guilds: listGuilds(options.db) });
        return;
      }

      if (pathname === "/api/live" && method === "GET") {
        const guildId = url.searchParams.get("guildId") || undefined;
        const normalizedGuildId = guildId && guildId !== "all" ? guildId : undefined;
        sendJson(res, 200, options.getLiveSnapshot(normalizedGuildId));
        return;
      }

      if (pathname === "/api/stats/overview" && method === "GET") {
        const filter = parseFilterFromUrl(url);
        sendJson(res, 200, {
          overview: getOverviewStats(options.db, filter),
          settings: getDashboardSettings(options.db),
        });
        return;
      }

      if (pathname === "/api/stats/top-tracks" && method === "GET") {
        const filter = parseFilterFromUrl(url);
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        sendJson(res, 200, { tracks: getTopTracks(options.db, filter, limit) });
        return;
      }

      if (pathname === "/api/stats/top-users" && method === "GET") {
        const filter = parseFilterFromUrl(url);
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        sendJson(res, 200, { users: getTopUsers(options.db, filter, limit) });
        return;
      }

      if (pathname === "/api/stats/activity" && method === "GET") {
        const filter = parseFilterFromUrl(url);
        sendJson(res, 200, getActivityStats(options.db, filter));
        return;
      }

      if (pathname === "/api/stats/recent" && method === "GET") {
        const guildId = url.searchParams.get("guildId") || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 30);
        sendJson(res, 200, { plays: getRecentPlays(options.db, { guildId }, limit) });
        return;
      }

      // Controles remotos do player por servidor (somente admin)
      const playerControlMatch = /^\/api\/player\/([^/]+)(\/.*)$/.exec(pathname);
      if (playerControlMatch) {
        requireAdmin(session);
        if (!options.playerControl) {
          throw new HttpRequestError(503, "Controle remoto do player indisponível.");
        }

        const controlLimit = playerControlRateLimiter.check(`player:${session.account.id}`);
        if (!controlLimit.allowed) {
          sendJson(
            res,
            429,
            { error: "Muitos comandos em sequência. Aguarde alguns segundos." },
            { "Retry-After": String(controlLimit.retryAfterSeconds) },
          );
          return;
        }

        let targetGuildId: string;
        try {
          targetGuildId = decodeURIComponent(playerControlMatch[1]).trim();
        } catch {
          throw new HttpRequestError(400, "ID do servidor inválido.");
        }
        if (!targetGuildId || targetGuildId === "all") {
          throw new HttpRequestError(400, "Selecione um servidor específico para controlar o player.");
        }

        const actionPath = playerControlMatch[2];
        const actor = {
          id: session.account.id,
          username: session.account.username,
          displayName: session.account.displayName,
        };

        if (actionPath === "/toggle" && method === "POST") {
          const result = await options.playerControl.togglePause(targetGuildId, actor);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/skip" && method === "POST") {
          const result = await options.playerControl.skip(targetGuildId, actor);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/stop" && method === "POST") {
          const result = await options.playerControl.stop(targetGuildId, actor);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/loop" && method === "POST") {
          const body = await readJsonBody(req);
          const modeRaw = body.mode !== undefined ? getStringField(body, "mode").trim() : undefined;
          const result = await options.playerControl.setLoop(
            targetGuildId,
            actor,
            modeRaw ? (modeRaw as "off" | "track" | "queue") : undefined,
          );
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/shuffle" && method === "POST") {
          const result = await options.playerControl.shuffle(targetGuildId, actor);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/volume" && method === "POST") {
          const body = await readJsonBody(req);
          const volume = typeof body.volume === "number" ? body.volume : Number(body.volume);
          const result = await options.playerControl.setVolume(targetGuildId, actor, volume);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/seek" && method === "POST") {
          const body = await readJsonBody(req);
          const positionMs =
            typeof body.positionMs === "number" ? body.positionMs : Number(body.positionMs);
          const result = await options.playerControl.seek(targetGuildId, actor, positionMs);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/queue/jump" && method === "POST") {
          const body = await readJsonBody(req);
          const index = typeof body.index === "number" ? body.index : Number(body.index);
          const result = await options.playerControl.jumpToQueueIndex(targetGuildId, actor, index);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/queue" && method === "POST") {
          const body = await readJsonBody(req);
          const query = getStringField(body, "query");
          const platformRaw = getStringField(body, "platform").trim().toLowerCase();
          const platform = platformRaw === "spotify" ? "spotify" : "youtube";
          const result = await options.playerControl.enqueue(targetGuildId, actor, query, platform);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        if (actionPath === "/queue" && method === "DELETE") {
          const result = await options.playerControl.clearQueue(targetGuildId, actor);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        const queueItemMatch = /^\/queue\/(\d+)$/.exec(actionPath);
        if (queueItemMatch && method === "DELETE") {
          const index = Number.parseInt(queueItemMatch[1], 10);
          const result = await options.playerControl.removeQueueIndex(targetGuildId, actor, index);
          sendJson(res, 200, { ok: true, message: result.message, live: options.getLiveSnapshot(targetGuildId) });
          return;
        }

        sendJson(res, 404, { error: "Ação de controle não encontrada." });
        return;
      }

      // Rotas de administração e configurações (somente admin)
      if (pathname === "/api/settings" && method === "GET") {
        requireAdmin(session);
        sendJson(res, 200, { settings: getDashboardSettings(options.db) });
        return;
      }

      if (pathname === "/api/settings" && method === "PATCH") {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const updated = updateDashboardSettings(options.db, {
          dashboardTitle:
            body.dashboardTitle !== undefined ? String(body.dashboardTitle) : undefined,
          minPlaySeconds:
            body.minPlaySeconds !== undefined ? Number(body.minPlaySeconds) : undefined,
          ignoreLoopInRankings:
            body.ignoreLoopInRankings !== undefined
              ? Boolean(body.ignoreLoopInRankings)
              : undefined,
          sessionTtlDays:
            body.sessionTtlDays !== undefined ? Number(body.sessionTtlDays) : undefined,
        });
        sendJson(res, 200, { settings: updated });
        return;
      }

      if (pathname === "/api/accounts" && method === "GET") {
        requireAdmin(session);
        sendJson(res, 200, { accounts: listAccounts(options.db) });
        return;
      }

      if (pathname === "/api/accounts" && method === "POST") {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const created = await createAccountByAdmin(options.db, {
          actorId: session.account.id,
          username: getStringField(body, "username"),
          displayName: getStringField(body, "displayName"),
          password: getStringField(body, "password"),
          role: (getStringField(body, "role") || "viewer") as AccountRole,
        });
        sendJson(res, 201, { account: created });
        return;
      }

      const accountMatch = /^\/api\/accounts\/(\d+)$/.exec(pathname);
      if (accountMatch) {
        requireAdmin(session);
        const targetId = parsePositiveId(accountMatch[1]);

        if (method === "PATCH") {
          const body = await readJsonBody(req);
          const updated = await updateAccountByAdmin(options.db, {
            actorId: session.account.id,
            targetId,
            displayName: body.displayName !== undefined ? String(body.displayName) : undefined,
            role: body.role !== undefined ? (String(body.role) as AccountRole) : undefined,
            isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
            newPassword: body.newPassword !== undefined ? String(body.newPassword) : undefined,
          });
          sendJson(res, 200, { account: updated });
          return;
        }

        if (method === "DELETE") {
          deleteAccountByAdmin(options.db, session.account.id, targetId);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      if (pathname === "/api/invites" && method === "GET") {
        requireAdmin(session);
        sendJson(res, 200, { invites: listInvites(options.db) });
        return;
      }

      if (pathname === "/api/invites" && method === "POST") {
        requireAdmin(session);
        const body = await readJsonBody(req);
        const created = createInvite(options.db, {
          actorId: session.account.id,
          role: (getStringField(body, "role") || "viewer") as AccountRole,
          expiresInHours:
            body.expiresInHours !== undefined ? Number(body.expiresInHours) : undefined,
          note: body.note !== undefined ? String(body.note) : undefined,
        });
        sendJson(res, 201, created);
        return;
      }

      const inviteMatch = /^\/api\/invites\/(\d+)$/.exec(pathname);
      if (inviteMatch && method === "DELETE") {
        requireAdmin(session);
        const inviteId = parsePositiveId(inviteMatch[1]);
        revokeInvite(options.db, inviteId);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Endpoint não encontrado." });
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  }

  function requireSession(req: http.IncomingMessage): SessionInfo {
    const cookies = parseCookies(req);
    const session = validateSession(options.db, cookies.get(SESSION_COOKIE_NAME));
    if (!session) {
      throw new AuthError(401, "Sessão expirada ou não autenticado.");
    }
    return session;
  }

  function requireAdmin(session: SessionInfo): void {
    if (session.account.role !== "admin") {
      throw new AuthError(403, "Acesso restrito a administradores.");
    }
  }

  return server;
}

function parseFilterFromUrl(url: URL) {
  const guildId = url.searchParams.get("guildId") || undefined;
  const range = parseStatsRange(url.searchParams.get("range"));
  const tzRaw = url.searchParams.get("tzOffset");
  const tzParsed = tzRaw !== null ? Number.parseInt(tzRaw, 10) : undefined;
  const tzOffsetMinutes =
    tzParsed !== undefined && Number.isFinite(tzParsed) ? tzParsed : undefined;
  return { guildId, range, tzOffsetMinutes };
}

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(100, parsed);
}
