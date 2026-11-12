export interface SimpleTrackSummary {
  title: string;
  uri?: string;
  author?: string;
  duration?: number;
  isStream?: boolean;
  requesterId?: string;
}

export type TrackPlatform = "spotify" | "youtube";

export interface PlatformTheme {
  platform: TrackPlatform;
  name: string;
  color: number;
  linkLabel: string;
}

export const PLATFORM_THEMES: Record<TrackPlatform, PlatformTheme> = {
  spotify: {
    platform: "spotify",
    name: "Spotify",
    color: 0x1db954,
    linkLabel: "Abrir no Spotify",
  },
  youtube: {
    platform: "youtube",
    name: "YouTube",
    color: 0xff0000,
    linkLabel: "Abrir no YouTube",
  },
};

export function detectTrackPlatform(sourceName?: string | null, uri?: string | null): TrackPlatform {
  const src = sourceName?.toLowerCase() ?? "";
  const link = uri?.toLowerCase() ?? "";
  if (src === "spotify" || link.includes("spotify.com") || link.includes("spotify.link")) {
    return "spotify";
  }
  return "youtube";
}

export function getPlatformTheme(platform: TrackPlatform): PlatformTheme {
  return PLATFORM_THEMES[platform];
}

/**
 * Converte a entrada do usuário em uma query para o Lavalink.
 * Se começar com http:// ou https://, retorna a URL direta;
 * caso contrário, prefixa com "ytsearch:" para buscar no YouTube.
 */
export function toQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("A busca não pode ser vazia.");
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `ytsearch:${trimmed}`;
}

/**
 * Verifica se a entrada é uma URL direta.
 */
export function isUrlQuery(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Formata milissegundos em mm:ss ou hh:mm:ss.
 */
export function formatDuration(ms?: number, isStream?: boolean): string {
  if (isStream) {
    return "AO VIVO";
  }
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number): string => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Renderiza uma barra de progresso visual com um indicador de posição.
 * Exemplo: ▬▬▬▬🔘▬▬▬▬▬▬▬ `01:15 / 03:08`
 */
export function formatProgressBar(
  currentMs: number,
  totalMs?: number,
  isStream?: boolean,
  barLength = 12,
): string {
  if (isStream) {
    return `${"▬".repeat(barLength)} AO VIVO`;
  }
  if (typeof totalMs !== "number" || !Number.isFinite(totalMs) || totalMs <= 0) {
    return `${"▬".repeat(barLength)} \`00:00 / 00:00\``;
  }

  const safeCurrent = Math.max(0, Math.min(totalMs, currentMs));
  const progress = safeCurrent / totalMs;
  const dotIndex = Math.min(barLength - 1, Math.max(0, Math.floor(progress * barLength)));

  const before = "▬".repeat(dotIndex);
  const after = "▬".repeat(Math.max(0, barLength - 1 - dotIndex));
  const bar = `${before}🔘${after}`;

  return `${bar} \`${formatDuration(safeCurrent)} / ${formatDuration(totalMs)}\``;
}

function truncateTitle(title: string, maxLength = 55): string {
  const clean = title.trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Formata a lista das próximas músicas na fila (até `limit` itens),
 * garantindo que o resultado nunca ultrapasse o limite de 1024 caracteres
 * de um campo de Embed do Discord.
 */
export function formatQueueLines(
  tracks: SimpleTrackSummary[],
  limit = 10,
  maxChars = 950,
): string {
  if (tracks.length === 0) {
    return "Nenhuma música na fila.";
  }

  const slice = tracks.slice(0, limit);
  const lines: string[] = [];
  let currentLength = 0;
  const footerReserve = 45;

  for (let idx = 0; idx < slice.length; idx++) {
    const track = slice[idx];
    const duration = formatDuration(track.duration, track.isStream);
    const shortTitle = truncateTitle(track.title, 55);
    const titleLink = track.uri ? `[${shortTitle}](${track.uri})` : shortTitle;
    const requester = track.requesterId ? ` • <@${track.requesterId}>` : "";
    const line = `**${idx + 1}.** ${titleLink} \`[${duration}]\`${requester}`;

    if (lines.length > 0 && currentLength + line.length + 1 > maxChars - footerReserve) {
      break;
    }

    lines.push(line);
    currentLength += line.length + 1;
  }

  const remaining = tracks.length - lines.length;
  if (remaining > 0) {
    lines.push(`\n*...e mais ${remaining} música(s) na fila.*`);
  }

  return lines.join("\n");
}

export const MAX_PLAYLIST_TRACKS = 50;

/**
 * Seleciona até `maxTracks` (padrão 50) faixas de uma playlist.
 * Se houver uma faixa selecionada (`selectedTrackId`), inicia a fatia a partir dela.
 */
export function slicePlaylistTracks<T extends { info: { identifier?: string } }>(
  tracks: T[],
  selectedTrackId?: string | null,
  maxTracks = MAX_PLAYLIST_TRACKS,
): T[] {
  if (tracks.length === 0) {
    return [];
  }
  let startIdx = 0;
  if (selectedTrackId) {
    const foundIdx = tracks.findIndex((t) => t.info.identifier === selectedTrackId);
    if (foundIdx >= 0) {
      startIdx = foundIdx;
    }
  }
  return tracks.slice(startIdx, startIdx + maxTracks);
}

export const GENERIC_TRACK_ERROR_REASON = "erro ao carregar o áudio";

/**
 * Categorias de erro conhecidas, avaliadas em ordem: a primeira que casar vence.
 * Um mesmo erro do youtube-source pode trazer motivos de vários clientes
 * (ex.: "requires login" e "unavailable"), por isso as mais específicas vêm antes.
 */
const TRACK_ERROR_CATEGORIES: Array<{ patterns: RegExp[]; reason: string }> = [
  {
    patterns: [/age[- ]restricted/i, /confirm your age/i, /inappropriate for some users/i],
    reason: "vídeo com restrição de idade no YouTube",
  },
  {
    // "requires login" NÃO indica restrição de idade: o YouTube também usa essa
    // resposta quando bloqueia IPs de data center ou exige uma conta logada.
    patterns: [/not a bot/i, /requires login/i],
    reason: "o YouTube exigiu login ou bloqueou temporariamente o servidor de áudio",
  },
  {
    patterns: [/private/i],
    reason: "o vídeo é privado",
  },
  {
    patterns: [/country/i, /region/i],
    reason: "o vídeo não está disponível na região do servidor",
  },
  {
    patterns: [/live event will begin/i, /premiere/i],
    reason: "a transmissão ainda não começou",
  },
  {
    patterns: [/unavailable/i, /removed/i, /does not exist/i],
    reason: "o vídeo está indisponível ou foi removido",
  },
  {
    patterns: [/\b429\b/, /\b403\b/, /status code/i],
    reason: "o servidor de áudio foi limitado pelo YouTube, tente de novo mais tarde",
  },
];

/**
 * Converte a exceção do Lavalink num motivo amigável para o canal.
 * Nunca devolve o texto bruto da exceção: erros não reconhecidos viram uma mensagem genérica.
 */
export function formatTrackErrorReason(message?: string | null): string {
  if (!message) {
    return GENERIC_TRACK_ERROR_REASON;
  }
  const category = TRACK_ERROR_CATEGORIES.find(({ patterns }) =>
    patterns.some((pattern) => pattern.test(message)),
  );
  return category?.reason ?? GENERIC_TRACK_ERROR_REASON;
}
