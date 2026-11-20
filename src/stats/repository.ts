import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_APP_SETTINGS, runInTransaction } from "../db/database.js";
import type { TrackPlatform } from "../music/resolve.js";

export type StatsRange = "7d" | "30d" | "90d" | "all";

export interface DashboardSettings {
  dashboardTitle: string;
  minPlaySeconds: number;
  ignoreLoopInRankings: boolean;
  sessionTtlDays: number;
}

export class SettingsValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export interface StatsFilter {
  guildId?: string;
  range?: StatsRange;
  tzOffsetMinutes?: number;
}

export interface GuildRecord {
  guildId: string;
  name: string;
  iconUrl: string | null;
  updatedAt: string | null;
}

export interface OverviewStats {
  totalPlays: number;
  totalListenedMs: number;
  uniqueTracks: number;
  uniqueUsers: number;
  totalCommands: number;
  completedPlays: number;
  skippedPlays: number;
  completionRate: number;
}

export interface TopTrackItem {
  trackKey: string;
  identifier: string;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  platform: TrackPlatform;
  durationMs: number;
  playCount: number;
  totalListenedMs: number;
  uniqueRequesters: number;
  lastPlayedAt: number;
}

export interface TopUserItem {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  tracksRequested: number;
  totalListenedMs: number;
  commandsUsed: number;
  favoritePlatform: TrackPlatform | null;
  lastActiveAt: number;
}

export interface ActivityStats {
  daily: Array<{
    date: string;
    plays: number;
    listenedMs: number;
    commands: number;
  }>;
  hourly: Array<{
    hour: number;
    plays: number;
    commands: number;
  }>;
  platforms: {
    youtube: { plays: number; listenedMs: number };
    spotify: { plays: number; listenedMs: number };
  };
  topCommands: Array<{
    commandName: string;
    interactionType: "slash" | "button";
    count: number;
  }>;
}

export interface RecentPlayItem {
  id: number;
  guildId: string;
  guildName: string | null;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  platform: TrackPlatform;
  durationMs: number;
  isStream: boolean;
  listenedMs: number | null;
  isLoop: boolean;
  endReason: string | null;
  startedAt: number;
  endedAt: number | null;
  requesterId: string | null;
  requesterUsername: string | null;
  requesterDisplayName: string | null;
  requesterAvatarUrl: string | null;
}

export function parseStatsRange(raw: string | null | undefined): StatsRange {
  if (raw === "7d" || raw === "30d" || raw === "90d" || raw === "all") {
    return raw;
  }
  return "30d";
}

function getRangeStartMs(range: StatsRange, now: number): number | null {
  const dayMs = 24 * 60 * 60 * 1000;
  switch (range) {
    case "7d":
      return now - 7 * dayMs;
    case "30d":
      return now - 30 * dayMs;
    case "90d":
      return now - 90 * dayMs;
    case "all":
      return null;
  }
}

export function getDashboardSettings(db: DatabaseSync): DashboardSettings {
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map<string, string>(Object.entries(DEFAULT_APP_SETTINGS));
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  const parsedMin = Number.parseInt(map.get("min_play_seconds") ?? "15", 10);
  const parsedTtl = Number.parseInt(map.get("session_ttl_days") ?? "7", 10);

  return {
    dashboardTitle: (map.get("dashboard_title") || DEFAULT_APP_SETTINGS.dashboard_title).trim(),
    minPlaySeconds: Number.isFinite(parsedMin) && parsedMin >= 0 && parsedMin <= 600 ? parsedMin : 15,
    ignoreLoopInRankings: map.get("ignore_loop_in_rankings") !== "false",
    sessionTtlDays: Number.isFinite(parsedTtl) && parsedTtl >= 1 && parsedTtl <= 90 ? parsedTtl : 7,
  };
}

export function updateDashboardSettings(
  db: DatabaseSync,
  patch: Partial<DashboardSettings>,
): DashboardSettings {
  const current = getDashboardSettings(db);
  const next: DashboardSettings = { ...current };

  if (patch.dashboardTitle !== undefined) {
    const title = String(patch.dashboardTitle).trim();
    if (title.length < 1 || title.length > 60) {
      throw new SettingsValidationError("O título do painel deve ter entre 1 e 60 caracteres.");
    }
    next.dashboardTitle = title;
  }

  if (patch.minPlaySeconds !== undefined) {
    const sec = Number(patch.minPlaySeconds);
    if (!Number.isInteger(sec) || sec < 0 || sec > 600) {
      throw new SettingsValidationError(
        "O tempo mínimo de reprodução deve ser um inteiro entre 0 e 600 segundos.",
      );
    }
    next.minPlaySeconds = sec;
  }

  if (patch.ignoreLoopInRankings !== undefined) {
    if (typeof patch.ignoreLoopInRankings !== "boolean") {
      throw new SettingsValidationError("ignoreLoopInRankings deve ser booleano.");
    }
    next.ignoreLoopInRankings = patch.ignoreLoopInRankings;
  }

  if (patch.sessionTtlDays !== undefined) {
    const days = Number(patch.sessionTtlDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new SettingsValidationError("A validade da sessão deve ficar entre 1 e 90 dias.");
    }
    next.sessionTtlDays = days;
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  runInTransaction(db, () => {
    upsert.run("dashboard_title", next.dashboardTitle, now);
    upsert.run("min_play_seconds", String(next.minPlaySeconds), now);
    upsert.run("ignore_loop_in_rankings", next.ignoreLoopInRankings ? "true" : "false", now);
    upsert.run("session_ttl_days", String(next.sessionTtlDays), now);
  });

  return next;
}

export function upsertDiscordGuild(
  db: DatabaseSync,
  guild: { guildId: string; name: string; iconUrl?: string | null },
): void {
  db.prepare(
    `INSERT INTO discord_guilds (guild_id, name, icon_url, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       name = excluded.name,
       icon_url = COALESCE(excluded.icon_url, discord_guilds.icon_url),
       updated_at = excluded.updated_at`,
  ).run(guild.guildId, guild.name, guild.iconUrl ?? null, new Date().toISOString());
}

export function upsertDiscordUser(
  db: DatabaseSync,
  user: { userId: string; username: string; displayName?: string; avatarUrl?: string | null },
): void {
  const displayName = user.displayName?.trim() || user.username;
  db.prepare(
    `INSERT INTO discord_users (user_id, username, display_name, avatar_url, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = COALESCE(excluded.avatar_url, discord_users.avatar_url),
       updated_at = excluded.updated_at`,
  ).run(user.userId, user.username, displayName, user.avatarUrl ?? null, new Date().toISOString());
}

export function insertTrackPlay(
  db: DatabaseSync,
  input: {
    guildId: string;
    trackKey: string;
    identifier: string;
    isrc?: string | null;
    title: string;
    author?: string | null;
    uri?: string | null;
    artworkUrl?: string | null;
    platform: TrackPlatform;
    durationMs: number;
    isStream: boolean;
    requesterId?: string | null;
    isLoop: boolean;
    startedAt: number;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO track_plays (
        guild_id, track_key, identifier, isrc, title, author, uri, artwork_url,
        platform, duration_ms, is_stream, requester_id, is_loop, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.guildId,
      input.trackKey,
      input.identifier,
      input.isrc ?? null,
      input.title,
      input.author ?? null,
      input.uri ?? null,
      input.artworkUrl ?? null,
      input.platform,
      Math.max(0, Math.round(input.durationMs || 0)),
      input.isStream ? 1 : 0,
      input.requesterId ?? null,
      input.isLoop ? 1 : 0,
      input.startedAt,
    );
  return Number(res.lastInsertRowid);
}

export function finishTrackPlay(
  db: DatabaseSync,
  input: {
    playId: number;
    endedAt: number;
    listenedMs: number;
    endReason: string;
  },
): void {
  db.prepare(
    `UPDATE track_plays
     SET ended_at = ?, listened_ms = ?, end_reason = ?
     WHERE id = ? AND ended_at IS NULL`,
  ).run(input.endedAt, Math.max(0, Math.round(input.listenedMs)), input.endReason, input.playId);
}

export function insertCommandEvent(
  db: DatabaseSync,
  input: {
    guildId: string;
    userId: string;
    commandName: string;
    interactionType: "slash" | "button";
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO command_events (guild_id, user_id, command_name, interaction_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.guildId, input.userId, input.commandName, input.interactionType, input.createdAt);
}

export function listGuilds(db: DatabaseSync): GuildRecord[] {
  const rows = db
    .prepare(
      `SELECT ids.guild_id,
              COALESCE(g.name, 'Servidor ' || ids.guild_id) AS name,
              g.icon_url,
              g.updated_at
       FROM (
         SELECT guild_id FROM discord_guilds
         UNION
         SELECT DISTINCT guild_id FROM track_plays
         UNION
         SELECT DISTINCT guild_id FROM command_events
       ) ids
       LEFT JOIN discord_guilds g ON g.guild_id = ids.guild_id
       ORDER BY name ASC`,
    )
    .all() as Array<{
    guild_id: string;
    name: string;
    icon_url: string | null;
    updated_at: string | null;
  }>;

  return rows.map((row) => ({
    guildId: row.guild_id,
    name: row.name,
    iconUrl: row.icon_url,
    updatedAt: row.updated_at,
  }));
}

function buildValidPlayClause(
  filter: StatsFilter,
  settings: DashboardSettings,
  now: number,
  alias = "tp",
): { whereSql: string; params: Array<string | number>; effectiveListenedExpr: string } {
  const conditions: string[] = [`(${alias}.end_reason IS NULL OR ${alias}.end_reason != 'loadFailed')`];
  const params: Array<string | number> = [];

  const guildId = filter.guildId && filter.guildId !== "all" ? filter.guildId : undefined;
  if (guildId) {
    conditions.push(`${alias}.guild_id = ?`);
    params.push(guildId);
  }

  const safeNow = Math.trunc(Number.isFinite(now) ? now : Date.now());
  const rangeStart = getRangeStartMs(filter.range ?? "30d", safeNow);
  if (rangeStart !== null) {
    conditions.push(`${alias}.started_at >= ?`);
    params.push(rangeStart);
  }

  if (settings.ignoreLoopInRankings) {
    conditions.push(`${alias}.is_loop = 0`);
  }

  const minPlayMs = settings.minPlaySeconds * 1000;
  if (minPlayMs > 0) {
    conditions.push(
      `(${alias}.end_reason = 'finished'
        OR (${alias}.ended_at IS NULL AND (? - ${alias}.started_at) >= ?)
        OR (${alias}.ended_at IS NOT NULL AND COALESCE(${alias}.listened_ms, 0) >= ?))`,
    );
    params.push(safeNow, minPlayMs, minPlayMs);
  }

  const effectiveListenedExpr = `CASE
    WHEN ${alias}.listened_ms IS NOT NULL THEN ${alias}.listened_ms
    WHEN ${alias}.ended_at IS NOT NULL THEN MAX(0, ${alias}.ended_at - ${alias}.started_at)
    WHEN ${alias}.is_stream = 0 AND ${alias}.duration_ms > 0 THEN MIN(${alias}.duration_ms, MAX(0, ${safeNow} - ${alias}.started_at))
    ELSE MAX(0, ${safeNow} - ${alias}.started_at)
  END`;

  return {
    whereSql: conditions.join(" AND "),
    params,
    effectiveListenedExpr,
  };
}

function buildCommandClause(
  filter: StatsFilter,
  now: number,
  alias = "ce",
): { whereSql: string; params: Array<string | number> } {
  const conditions: string[] = ["1 = 1"];
  const params: Array<string | number> = [];

  const guildId = filter.guildId && filter.guildId !== "all" ? filter.guildId : undefined;
  if (guildId) {
    conditions.push(`${alias}.guild_id = ?`);
    params.push(guildId);
  }

  const rangeStart = getRangeStartMs(filter.range ?? "30d", now);
  if (rangeStart !== null) {
    conditions.push(`${alias}.created_at >= ?`);
    params.push(rangeStart);
  }

  return { whereSql: conditions.join(" AND "), params };
}

export function getOverviewStats(
  db: DatabaseSync,
  filter: StatsFilter,
  now = Date.now(),
): OverviewStats {
  const settings = getDashboardSettings(db);
  const playClause = buildValidPlayClause(filter, settings, now, "tp");
  const cmdClause = buildCommandClause(filter, now, "ce");

  const playRow = db
    .prepare(
      `SELECT COUNT(*) AS total_plays,
              COALESCE(SUM(${playClause.effectiveListenedExpr}), 0) AS total_listened_ms,
              COUNT(DISTINCT tp.track_key) AS unique_tracks,
              SUM(CASE WHEN tp.end_reason = 'finished' THEN 1 ELSE 0 END) AS completed_plays,
              SUM(CASE WHEN tp.end_reason IN ('replaced', 'stopped') THEN 1 ELSE 0 END) AS skipped_plays,
              SUM(CASE WHEN tp.ended_at IS NOT NULL THEN 1 ELSE 0 END) AS ended_plays
       FROM track_plays tp
       WHERE ${playClause.whereSql}`,
    )
    .get(...playClause.params) as {
    total_plays: number;
    total_listened_ms: number;
    unique_tracks: number;
    completed_plays: number | null;
    skipped_plays: number | null;
    ended_plays: number | null;
  };

  const cmdRow = db
    .prepare(`SELECT COUNT(*) AS total_commands FROM command_events ce WHERE ${cmdClause.whereSql}`)
    .get(...cmdClause.params) as { total_commands: number };

  const uniqueUsersRow = db
    .prepare(
      `SELECT COUNT(*) AS unique_users FROM (
         SELECT tp.requester_id AS user_id FROM track_plays tp
         WHERE ${playClause.whereSql} AND tp.requester_id IS NOT NULL
         UNION
         SELECT ce.user_id AS user_id FROM command_events ce
         WHERE ${cmdClause.whereSql}
       )`,
    )
    .get(...playClause.params, ...cmdClause.params) as { unique_users: number };

  const completed = playRow.completed_plays ?? 0;
  const skipped = playRow.skipped_plays ?? 0;
  const ended = playRow.ended_plays ?? 0;
  const completionRate = ended > 0 ? Math.round((completed / ended) * 100) : 0;

  return {
    totalPlays: playRow.total_plays,
    totalListenedMs: Math.round(playRow.total_listened_ms),
    uniqueTracks: playRow.unique_tracks,
    uniqueUsers: uniqueUsersRow.unique_users,
    totalCommands: cmdRow.total_commands,
    completedPlays: completed,
    skippedPlays: skipped,
    completionRate,
  };
}

export function getTopTracks(
  db: DatabaseSync,
  filter: StatsFilter,
  limit = 20,
  now = Date.now(),
): TopTrackItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const settings = getDashboardSettings(db);
  const playClause = buildValidPlayClause(filter, settings, now, "tp");

  const rows = db
    .prepare(
      `SELECT tp.track_key,
              MAX(tp.identifier) AS identifier,
              MAX(tp.title) AS title,
              MAX(tp.author) AS author,
              MAX(tp.uri) AS uri,
              MAX(tp.artwork_url) AS artwork_url,
              MAX(tp.platform) AS platform,
              MAX(tp.duration_ms) AS duration_ms,
              COUNT(*) AS play_count,
              COALESCE(SUM(${playClause.effectiveListenedExpr}), 0) AS total_listened_ms,
              COUNT(DISTINCT tp.requester_id) AS unique_requesters,
              MAX(tp.started_at) AS last_played_at
       FROM track_plays tp
       WHERE ${playClause.whereSql}
       GROUP BY tp.track_key
       ORDER BY play_count DESC, total_listened_ms DESC, last_played_at DESC
       LIMIT ?`,
    )
    .all(...playClause.params, safeLimit) as Array<{
    track_key: string;
    identifier: string;
    title: string;
    author: string | null;
    uri: string | null;
    artwork_url: string | null;
    platform: TrackPlatform;
    duration_ms: number;
    play_count: number;
    total_listened_ms: number;
    unique_requesters: number;
    last_played_at: number;
  }>;

  return rows.map((row) => ({
    trackKey: row.track_key,
    identifier: row.identifier,
    title: row.title,
    author: row.author,
    uri: row.uri,
    artworkUrl: row.artwork_url,
    platform: row.platform,
    durationMs: row.duration_ms,
    playCount: row.play_count,
    totalListenedMs: Math.round(row.total_listened_ms),
    uniqueRequesters: row.unique_requesters,
    lastPlayedAt: row.last_played_at,
  }));
}

export function getTopUsers(
  db: DatabaseSync,
  filter: StatsFilter,
  limit = 20,
  now = Date.now(),
): TopUserItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const settings = getDashboardSettings(db);
  const playClause = buildValidPlayClause(filter, settings, now, "tp");
  const cmdClause = buildCommandClause(filter, now, "ce");

  const playAgg = db
    .prepare(
      `SELECT tp.requester_id AS user_id,
              COUNT(*) AS tracks_requested,
              COALESCE(SUM(${playClause.effectiveListenedExpr}), 0) AS total_listened_ms,
              SUM(CASE WHEN tp.platform = 'youtube' THEN 1 ELSE 0 END) AS yt_count,
              SUM(CASE WHEN tp.platform = 'spotify' THEN 1 ELSE 0 END) AS sp_count,
              MAX(tp.started_at) AS last_play_at
       FROM track_plays tp
       WHERE ${playClause.whereSql} AND tp.requester_id IS NOT NULL
       GROUP BY tp.requester_id`,
    )
    .all(...playClause.params) as Array<{
    user_id: string;
    tracks_requested: number;
    total_listened_ms: number;
    yt_count: number;
    sp_count: number;
    last_play_at: number;
  }>;

  const cmdAgg = db
    .prepare(
      `SELECT ce.user_id,
              COUNT(*) AS commands_used,
              MAX(ce.created_at) AS last_cmd_at
       FROM command_events ce
       WHERE ${cmdClause.whereSql}
       GROUP BY ce.user_id`,
    )
    .all(...cmdClause.params) as Array<{
    user_id: string;
    commands_used: number;
    last_cmd_at: number;
  }>;

  const merged = new Map<
    string,
    {
      tracksRequested: number;
      totalListenedMs: number;
      commandsUsed: number;
      favoritePlatform: TrackPlatform | null;
      lastActiveAt: number;
    }
  >();

  for (const row of playAgg) {
    const favoritePlatform: TrackPlatform | null =
      row.yt_count === 0 && row.sp_count === 0
        ? null
        : row.sp_count > row.yt_count
          ? "spotify"
          : "youtube";
    merged.set(row.user_id, {
      tracksRequested: row.tracks_requested,
      totalListenedMs: Math.round(row.total_listened_ms),
      commandsUsed: 0,
      favoritePlatform,
      lastActiveAt: row.last_play_at,
    });
  }

  for (const row of cmdAgg) {
    const existing = merged.get(row.user_id);
    if (existing) {
      existing.commandsUsed = row.commands_used;
      existing.lastActiveAt = Math.max(existing.lastActiveAt, row.last_cmd_at);
    } else {
      merged.set(row.user_id, {
        tracksRequested: 0,
        totalListenedMs: 0,
        commandsUsed: row.commands_used,
        favoritePlatform: null,
        lastActiveAt: row.last_cmd_at,
      });
    }
  }

  if (merged.size === 0) {
    return [];
  }

  const userIds = Array.from(merged.keys());
  const placeholders = userIds.map(() => "?").join(", ");
  const profileRows = db
    .prepare(
      `SELECT user_id, username, display_name, avatar_url
       FROM discord_users
       WHERE user_id IN (${placeholders})`,
    )
    .all(...userIds) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  }>;
  const profiles = new Map(profileRows.map((p) => [p.user_id, p]));

  const items: TopUserItem[] = userIds.map((userId) => {
    const stat = merged.get(userId)!;
    const profile = profiles.get(userId);
    return {
      userId,
      username: profile?.username ?? userId,
      displayName: profile?.display_name ?? profile?.username ?? `Usuário ${userId.slice(-4)}`,
      avatarUrl: profile?.avatar_url ?? null,
      tracksRequested: stat.tracksRequested,
      totalListenedMs: stat.totalListenedMs,
      commandsUsed: stat.commandsUsed,
      favoritePlatform: stat.favoritePlatform,
      lastActiveAt: stat.lastActiveAt,
    };
  });

  items.sort(
    (a, b) =>
      b.tracksRequested - a.tracksRequested ||
      b.commandsUsed - a.commandsUsed ||
      b.totalListenedMs - a.totalListenedMs ||
      b.lastActiveAt - a.lastActiveAt,
  );

  return items.slice(0, safeLimit);
}

function formatDayInOffset(epochMs: number, offsetMinutes: number): { date: string; hour: number } {
  // offsetMinutes segue a convenção de Date.getTimezoneOffset() ou deslocamento direto:
  // aqui recebemos deslocamento UTC em minutos (ex.: -180 para UTC-3).
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    date: `${year}-${month}-${day}`,
    hour: shifted.getUTCHours(),
  };
}

export function getActivityStats(
  db: DatabaseSync,
  filter: StatsFilter,
  now = Date.now(),
): ActivityStats {
  const settings = getDashboardSettings(db);
  const playClause = buildValidPlayClause(filter, settings, now, "tp");
  const cmdClause = buildCommandClause(filter, now, "ce");
  const tzOffset =
    typeof filter.tzOffsetMinutes === "number" &&
    Number.isFinite(filter.tzOffsetMinutes) &&
    filter.tzOffsetMinutes >= -720 &&
    filter.tzOffsetMinutes <= 840
      ? Math.round(filter.tzOffsetMinutes)
      : 0;

  const plays = db
    .prepare(
      `SELECT tp.started_at,
              tp.platform,
              ${playClause.effectiveListenedExpr} AS listened_ms
       FROM track_plays tp
       WHERE ${playClause.whereSql}
       ORDER BY tp.started_at ASC`,
    )
    .all(...playClause.params) as Array<{
    started_at: number;
    platform: TrackPlatform;
    listened_ms: number;
  }>;

  const cmds = db
    .prepare(
      `SELECT ce.created_at, ce.command_name, ce.interaction_type
       FROM command_events ce
       WHERE ${cmdClause.whereSql}`,
    )
    .all(...cmdClause.params) as Array<{
    created_at: number;
    command_name: string;
    interaction_type: "slash" | "button";
  }>;

  const dailyMap = new Map<string, { plays: number; listenedMs: number; commands: number }>();

  // Pré-preenche todos os dias para períodos curtos (7d / 30d) para o gráfico não ficar com buracos
  const range = filter.range ?? "30d";
  if (range === "7d" || range === "30d") {
    const daysCount = range === "7d" ? 7 : 30;
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = daysCount - 1; i >= 0; i--) {
      const { date } = formatDayInOffset(now - i * dayMs, tzOffset);
      if (!dailyMap.has(date)) {
        dailyMap.set(date, { plays: 0, listenedMs: 0, commands: 0 });
      }
    }
  }

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, plays: 0, commands: 0 }));
  const platforms = {
    youtube: { plays: 0, listenedMs: 0 },
    spotify: { plays: 0, listenedMs: 0 },
  };

  for (const play of plays) {
    const { date, hour } = formatDayInOffset(play.started_at, tzOffset);
    const bucket = dailyMap.get(date) ?? { plays: 0, listenedMs: 0, commands: 0 };
    bucket.plays += 1;
    bucket.listenedMs += Math.round(play.listened_ms || 0);
    dailyMap.set(date, bucket);

    hourly[hour].plays += 1;

    if (play.platform === "spotify") {
      platforms.spotify.plays += 1;
      platforms.spotify.listenedMs += Math.round(play.listened_ms || 0);
    } else {
      platforms.youtube.plays += 1;
      platforms.youtube.listenedMs += Math.round(play.listened_ms || 0);
    }
  }

  const commandCounts = new Map<
    string,
    { commandName: string; interactionType: "slash" | "button"; count: number }
  >();

  for (const cmd of cmds) {
    const { date, hour } = formatDayInOffset(cmd.created_at, tzOffset);
    const bucket = dailyMap.get(date) ?? { plays: 0, listenedMs: 0, commands: 0 };
    bucket.commands += 1;
    dailyMap.set(date, bucket);

    hourly[hour].commands += 1;

    const key = `${cmd.interaction_type}:${cmd.command_name}`;
    const entry = commandCounts.get(key) ?? {
      commandName: cmd.command_name,
      interactionType: cmd.interaction_type,
      count: 0,
    };
    entry.count += 1;
    commandCounts.set(key, entry);
  }

  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({
      date,
      plays: stats.plays,
      listenedMs: stats.listenedMs,
      commands: stats.commands,
    }));

  const topCommands = Array.from(commandCounts.values())
    .sort((a, b) => b.count - a.count || a.commandName.localeCompare(b.commandName))
    .slice(0, 15);

  return { daily, hourly, platforms, topCommands };
}

export function getRecentPlays(
  db: DatabaseSync,
  filter: { guildId?: string },
  limit = 30,
): RecentPlayItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const guildId = filter.guildId && filter.guildId !== "all" ? filter.guildId : undefined;
  const whereSql = guildId ? "WHERE tp.guild_id = ?" : "";
  const params: Array<string | number> = guildId ? [guildId, safeLimit] : [safeLimit];

  const rows = db
    .prepare(
      `SELECT tp.id, tp.guild_id, g.name AS guild_name, tp.title, tp.author, tp.uri, tp.artwork_url,
              tp.platform, tp.duration_ms, tp.is_stream, tp.listened_ms, tp.is_loop, tp.end_reason,
              tp.started_at, tp.ended_at, tp.requester_id,
              u.username AS requester_username, u.display_name AS requester_display_name,
              u.avatar_url AS requester_avatar_url
       FROM track_plays tp
       LEFT JOIN discord_users u ON u.user_id = tp.requester_id
       LEFT JOIN discord_guilds g ON g.guild_id = tp.guild_id
       ${whereSql}
       ORDER BY tp.started_at DESC, tp.id DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    guild_id: string;
    guild_name: string | null;
    title: string;
    author: string | null;
    uri: string | null;
    artwork_url: string | null;
    platform: TrackPlatform;
    duration_ms: number;
    is_stream: number;
    listened_ms: number | null;
    is_loop: number;
    end_reason: string | null;
    started_at: number;
    ended_at: number | null;
    requester_id: string | null;
    requester_username: string | null;
    requester_display_name: string | null;
    requester_avatar_url: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    title: row.title,
    author: row.author,
    uri: row.uri,
    artworkUrl: row.artwork_url,
    platform: row.platform,
    durationMs: row.duration_ms,
    isStream: row.is_stream === 1,
    listenedMs: row.listened_ms,
    isLoop: row.is_loop === 1,
    endReason: row.end_reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    requesterId: row.requester_id,
    requesterUsername: row.requester_username,
    requesterDisplayName: row.requester_display_name,
    requesterAvatarUrl: row.requester_avatar_url,
  }));
}
