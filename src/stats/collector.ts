import type { DatabaseSync } from "node:sqlite";
import type { Track, UnresolvedTrack } from "lavalink-client";
import type { RequesterInfo } from "../music/controls.js";
import { detectTrackPlatform } from "../music/resolve.js";
import {
  finishTrackPlay,
  insertCommandEvent,
  insertTrackPlay,
  upsertDiscordGuild,
  upsertDiscordUser,
} from "./repository.js";

interface ActiveTrackSession {
  playId: number;
  trackKey: string;
  startedAt: number;
  pausedAt: number | null;
  pausedAccumulatedMs: number;
  durationMs: number;
  isStream: boolean;
}

export class StatsCollector {
  private readonly db: DatabaseSync;
  private readonly activeTracks = new Map<string, ActiveTrackSession>();
  private readonly lastStartedTrackByGuild = new Map<string, string>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  syncGuild(guild: { guildId: string; name: string; iconUrl?: string | null }): void {
    try {
      upsertDiscordGuild(this.db, guild);
    } catch (err) {
      console.error("[Stats] Falha ao sincronizar servidor:", err);
    }
  }

  syncUser(user: {
    userId: string;
    username: string;
    displayName?: string;
    avatarUrl?: string | null;
  }): void {
    try {
      upsertDiscordUser(this.db, user);
    } catch (err) {
      console.error("[Stats] Falha ao sincronizar usuário:", err);
    }
  }

  recordCommand(input: {
    guildId: string;
    guildName?: string;
    guildIconUrl?: string | null;
    userId: string;
    username: string;
    displayName?: string;
    avatarUrl?: string | null;
    commandName: string;
    interactionType: "slash" | "button";
  }): void {
    try {
      if (input.guildName) {
        upsertDiscordGuild(this.db, {
          guildId: input.guildId,
          name: input.guildName,
          iconUrl: input.guildIconUrl,
        });
      }
      upsertDiscordUser(this.db, {
        userId: input.userId,
        username: input.username,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      });
      insertCommandEvent(this.db, {
        guildId: input.guildId,
        userId: input.userId,
        commandName: input.commandName,
        interactionType: input.interactionType,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error("[Stats] Falha ao registrar comando:", err);
    }
  }

  recordTrackStart(
    guildId: string,
    track: Track | UnresolvedTrack,
    options?: { repeatMode?: string },
  ): void {
    try {
      const now = Date.now();
      // Se havia uma faixa ainda aberta nessa guilda, finaliza como substituída
      if (this.activeTracks.has(guildId)) {
        this.recordTrackEnd(guildId, "replaced", now);
      }

      const platform = detectTrackPlatform(track.info.sourceName, track.info.uri);
      const identifier = track.info.identifier || track.info.uri || track.info.title;
      const trackKey = `${platform}:${identifier}`;

      const previousKey = this.lastStartedTrackByGuild.get(guildId);
      const isLoop = options?.repeatMode === "track" && previousKey === trackKey;
      this.lastStartedTrackByGuild.set(guildId, trackKey);

      const requester = extractRequester(track.requester);
      if (requester) {
        upsertDiscordUser(this.db, {
          userId: requester.id,
          username: requester.username,
          displayName: requester.displayName,
          avatarUrl: requester.avatarUrl,
        });
      }

      const durationMs = typeof track.info.duration === "number" ? track.info.duration : 0;
      const isStream = Boolean(track.info.isStream);

      const playId = insertTrackPlay(this.db, {
        guildId,
        trackKey,
        identifier,
        isrc: track.info.isrc ?? null,
        title: track.info.title || "Faixa desconhecida",
        author: track.info.author ?? null,
        uri: track.info.uri ?? null,
        artworkUrl: track.info.artworkUrl ?? null,
        platform,
        durationMs,
        isStream,
        requesterId: requester?.id ?? null,
        isLoop,
        startedAt: now,
      });

      this.activeTracks.set(guildId, {
        playId,
        trackKey,
        startedAt: now,
        pausedAt: null,
        pausedAccumulatedMs: 0,
        durationMs,
        isStream,
      });
    } catch (err) {
      console.error("[Stats] Falha ao registrar início de faixa:", err);
    }
  }

  recordTrackPause(guildId: string, now = Date.now()): void {
    const active = this.activeTracks.get(guildId);
    if (active && active.pausedAt === null) {
      active.pausedAt = now;
    }
  }

  recordTrackResume(guildId: string, now = Date.now()): void {
    const active = this.activeTracks.get(guildId);
    if (active && active.pausedAt !== null) {
      active.pausedAccumulatedMs += Math.max(0, now - active.pausedAt);
      active.pausedAt = null;
    }
  }

  recordTrackEnd(guildId: string, reason: string, now = Date.now()): void {
    const active = this.activeTracks.get(guildId);
    if (!active) {
      return;
    }
    this.activeTracks.delete(guildId);

    try {
      const currentPauseMs = active.pausedAt !== null ? Math.max(0, now - active.pausedAt) : 0;
      const rawElapsed = Math.max(0, now - active.startedAt - active.pausedAccumulatedMs - currentPauseMs);
      let listenedMs = rawElapsed;

      if (!active.isStream && active.durationMs > 0) {
        if (reason === "finished") {
          listenedMs = active.durationMs;
        } else {
          listenedMs = Math.min(active.durationMs, rawElapsed);
        }
      }

      finishTrackPlay(this.db, {
        playId: active.playId,
        endedAt: now,
        listenedMs,
        endReason: reason,
      });
    } catch (err) {
      console.error("[Stats] Falha ao finalizar faixa:", err);
    }
  }

  clearGuildState(guildId: string, reason = "cleanup"): void {
    this.recordTrackEnd(guildId, reason);
    this.lastStartedTrackByGuild.delete(guildId);
  }

  flushOnShutdown(): void {
    const now = Date.now();
    for (const guildId of Array.from(this.activeTracks.keys())) {
      this.recordTrackEnd(guildId, "shutdown", now);
    }
    this.lastStartedTrackByGuild.clear();
  }
}

function extractRequester(raw: unknown): RequesterInfo | null {
  if (!raw || typeof raw !== "object" || !("id" in raw)) {
    return null;
  }
  const obj = raw as Partial<RequesterInfo>;
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    return null;
  }
  return {
    id: obj.id,
    username: typeof obj.username === "string" && obj.username.trim() ? obj.username : "Usuário",
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
    avatarUrl: typeof obj.avatarUrl === "string" ? obj.avatarUrl : null,
  };
}
