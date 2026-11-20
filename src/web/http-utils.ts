import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

export const SESSION_COOKIE_NAME = "panchlive_session";
const MAX_JSON_BODY_BYTES = 32 * 1024;

export class HttpRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
  }
}

export function isSecureRequest(req: http.IncomingMessage, trustProxy: boolean): boolean {
  const socket = req.socket as { encrypted?: boolean } | undefined;
  if (socket?.encrypted === true) {
    return true;
  }
  if (trustProxy) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const firstProto = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(",")[0];
    if (firstProto?.trim().toLowerCase() === "https") {
      return true;
    }
  }
  return false;
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

export function getClientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = req.headers["x-forwarded-for"];
    const firstIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0];
    if (firstIp && firstIp.trim()) {
      return firstIp.trim().slice(0, 64);
    }
  }
  return (req.socket?.remoteAddress ?? "unknown").slice(0, 64);
}

export function parseCookies(req: http.IncomingMessage): Map<string, string> {
  const map = new Map<string, string>();
  const raw = req.headers.cookie;
  if (!raw) {
    return map;
  }
  for (const part of raw.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (name) {
      try {
        map.set(name, decodeURIComponent(value));
      } catch {
        map.set(name, value);
      }
    }
  }
  return map;
}

export function buildSessionCookie(
  token: string,
  expiresAtIso: string,
  secure: boolean,
): string {
  const expiresUtc = new Date(expiresAtIso).toUTCString();
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresUtc}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function applySecurityHeaders(
  res: http.ServerResponse,
  options: { isSecure: boolean; isApi: boolean },
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (options.isSecure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (options.isApi) {
    res.setHeader("Cache-Control", "no-store");
  }
}

export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders?: Record<string, string | string[]>,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      res.setHeader(key, value);
    }
  }
  res.end(body);
}

export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpRequestError(413, "Corpo da requisição excede o limite permitido.");
    }
    chunks.push(buf);
  }

  if (totalBytes === 0) {
    return {};
  }

  const rawText = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawText) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpRequestError(400, "O corpo JSON deve ser um objeto.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpRequestError) {
      throw err;
    }
    throw new HttpRequestError(400, "JSON inválido no corpo da requisição.");
  }
}

export function verifyCsrfProtection(req: http.IncomingMessage, trustProxy: boolean): void {
  const requestedWith = req.headers["x-requested-with"];
  if (!requestedWith || (Array.isArray(requestedWith) ? !requestedWith[0] : !requestedWith.trim())) {
    throw new HttpRequestError(403, "Cabeçalho anti-CSRF ausente.");
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpRequestError(403, "Origem inválida.");
    }

    const forwardedHost = trustProxy ? req.headers["x-forwarded-host"] : undefined;
    const rawExpectedHost =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost?.split(",")[0]) ??
      req.headers.host;

    if (!rawExpectedHost || originHost !== rawExpectedHost.trim().toLowerCase()) {
      throw new HttpRequestError(403, "Origem não autorizada.");
    }
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function serveStaticAsset(
  res: http.ServerResponse,
  publicDir: string,
  relativeFilePath: string,
  cacheAssets = process.env.NODE_ENV === "production",
): boolean {
  const root = path.resolve(publicDir);
  const resolved = path.resolve(root, relativeFilePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return false;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    return false;
  }

  try {
    const content = fs.readFileSync(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", content.length);
    if (ext === ".html" || !cacheAssets) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
