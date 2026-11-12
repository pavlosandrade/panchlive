import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. Copie .env.example para .env e preencha os valores.`,
    );
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value || !value.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Variável de ambiente inválida: ${name} deve ser um número inteiro positivo.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value || !value.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  lavalinkHost: string;
  lavalinkPort: number;
  lavalinkPassword: string;
  lavalinkSecure: boolean;
  lavalinkFallbackNodes: boolean;
  httpPort: number;
  idleTimeoutMin: number;
  idleTimeoutMs: number;
}

export function loadConfig(): AppConfig {
  const idleTimeoutMin = parsePositiveInt(process.env.IDLE_TIMEOUT_MIN, 5, "IDLE_TIMEOUT_MIN");
  const discordGuildId = process.env.DISCORD_GUILD_ID?.trim() || undefined;

  return {
    discordToken: requireEnv("DISCORD_TOKEN"),
    discordClientId: requireEnv("DISCORD_CLIENT_ID"),
    discordGuildId,
    lavalinkHost: process.env.LAVALINK_HOST?.trim() || "localhost",
    lavalinkPort: parsePositiveInt(process.env.LAVALINK_PORT, 2333, "LAVALINK_PORT"),
    lavalinkPassword: process.env.LAVALINK_PASSWORD?.trim() || "panchlive-lavalink-secret",
    lavalinkSecure: parseBoolean(process.env.LAVALINK_SECURE, false),
    lavalinkFallbackNodes: parseBoolean(process.env.LAVALINK_FALLBACK_NODES, false),
    httpPort: parsePositiveInt(process.env.PORT, 3000, "PORT"),
    idleTimeoutMin,
    idleTimeoutMs: idleTimeoutMin * 60 * 1000,
  };
}
