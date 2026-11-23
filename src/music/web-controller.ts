import type { Client, TextChannel } from "discord.js";
import type { LavalinkManager, Player, RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import {
  buildPlaylistLoadedEmbed,
  buildQueuedTrackEmbed,
  disablePreviousNowPlayingMessage,
  getNextRepeatMode,
  refreshNowPlayingMessage,
  startNowPlayingProgressTimer,
  stopNowPlayingProgressTimer,
} from "./controls.js";
import { isUrlQuery, MAX_PLAYLIST_TRACKS, slicePlaylistTracks, toQuery } from "./resolve.js";

export class PlayerControlError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PlayerControlError";
    this.statusCode = statusCode;
  }
}

export interface ControlActor {
  id: number;
  username: string;
  displayName: string;
}

export interface PlayerControlResult {
  message: string;
}

export interface PlayerControlService {
  togglePause(guildId: string, actor: ControlActor): Promise<PlayerControlResult>;
  skip(guildId: string, actor: ControlActor): Promise<PlayerControlResult>;
  stop(guildId: string, actor: ControlActor): Promise<PlayerControlResult>;
  setLoop(guildId: string, actor: ControlActor, mode?: RepeatMode): Promise<PlayerControlResult>;
  shuffle(guildId: string, actor: ControlActor): Promise<PlayerControlResult>;
  setVolume(guildId: string, actor: ControlActor, volume: number): Promise<PlayerControlResult>;
  seek(guildId: string, actor: ControlActor, positionMs: number): Promise<PlayerControlResult>;
  jumpToQueueIndex(guildId: string, actor: ControlActor, index: number): Promise<PlayerControlResult>;
  removeQueueIndex(guildId: string, actor: ControlActor, index: number): Promise<PlayerControlResult>;
  clearQueue(guildId: string, actor: ControlActor): Promise<PlayerControlResult>;
  enqueue(
    guildId: string,
    actor: ControlActor,
    query: string,
    platform?: "youtube" | "spotify",
  ): Promise<PlayerControlResult>;
}

const VALID_REPEAT_MODES = new Set<RepeatMode>(["off", "track", "queue"]);
const MAX_QUERY_LENGTH = 300;

async function sendTextChannelNotice(
  client: Client,
  player: Player,
  payload: Parameters<TextChannel["send"]>[0],
): Promise<void> {
  if (!player.textChannelId) {
    return;
  }
  try {
    const channel = await client.channels.fetch(player.textChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return;
    }
    await channel.send(payload);
  } catch (err) {
    console.error("[WebControl] Falha ao enviar aviso no canal de texto do Discord:", err);
  }
}

function actorLabel(actor: ControlActor): string {
  return `**${actor.displayName || actor.username}** *(via Dashboard)*`;
}

function translateRepeatMode(mode: RepeatMode): string {
  if (mode === "track") return "Loop: Música";
  if (mode === "queue") return "Loop: Fila";
  return "Loop desativado";
}

export function createWebPlayerController(deps: {
  lavalink: LavalinkManager;
  client: Client;
}): PlayerControlService {
  const { lavalink, client } = deps;

  function requireActivePlayer(guildId: string): Player {
    const trimmed = guildId.trim();
    if (!trimmed) {
      throw new PlayerControlError(400, "Servidor inválido.");
    }
    const player = lavalink.getPlayer(trimmed);
    if (!player || !player.voiceChannelId) {
      throw new PlayerControlError(
        404,
        "O bot não está conectado em nenhum canal de voz neste servidor.",
      );
    }
    return player;
  }

  return {
    async togglePause(guildId) {
      const player = requireActivePlayer(guildId);
      if (!player.queue.current) {
        throw new PlayerControlError(409, "Não há nenhuma música tocando neste servidor.");
      }

      if (player.paused) {
        await player.resume();
        startNowPlayingProgressTimer(player, client);
        await refreshNowPlayingMessage(player, client);
        return { message: "Reprodução retomada." };
      }

      await player.pause();
      stopNowPlayingProgressTimer(player);
      await refreshNowPlayingMessage(player, client);
      return { message: "Reprodução pausada." };
    },

    async skip(guildId, actor) {
      const player = requireActivePlayer(guildId);
      const currentTrack = player.queue.current;
      if (!currentTrack) {
        throw new PlayerControlError(409, "Não há nenhuma música tocando para pular.");
      }

      stopNowPlayingProgressTimer(player);
      const skippedTitle = currentTrack.info.title || "a música atual";
      if (player.queue.tracks.length === 0) {
        await player.stopPlaying(true, false);
      } else {
        await player.skip();
      }

      await sendTextChannelNotice(client, player, `${actorLabel(actor)} pulou **${skippedTitle}**.`);
      return { message: `Pulou "${skippedTitle}".` };
    },

    async stop(guildId, actor) {
      const player = requireActivePlayer(guildId);
      stopNowPlayingProgressTimer(player);
      await disablePreviousNowPlayingMessage(player, client);
      await sendTextChannelNotice(
        client,
        player,
        `${actorLabel(actor)} parou a reprodução e limpou a fila.`,
      );
      await player.destroy("Parado pela dashboard");
      return { message: "Reprodução encerrada e bot desconectado da call." };
    },

    async setLoop(guildId, _actor, mode) {
      const player = requireActivePlayer(guildId);
      let nextMode: RepeatMode;
      if (mode !== undefined) {
        if (!VALID_REPEAT_MODES.has(mode)) {
          throw new PlayerControlError(400, "Modo de loop inválido. Use off, track ou queue.");
        }
        nextMode = mode;
      } else {
        nextMode = getNextRepeatMode(player.repeatMode);
      }

      await player.setRepeatMode(nextMode);
      await refreshNowPlayingMessage(player, client);
      return { message: `${translateRepeatMode(nextMode)}.` };
    },

    async shuffle(guildId) {
      const player = requireActivePlayer(guildId);
      if (player.queue.tracks.length < 2) {
        throw new PlayerControlError(409, "É necessário ter pelo menos 2 músicas na fila para embaralhar.");
      }
      await player.queue.shuffle();
      await refreshNowPlayingMessage(player, client);
      return { message: "Fila embaralhada." };
    },

    async setVolume(guildId, _actor, volume) {
      const player = requireActivePlayer(guildId);
      if (typeof volume !== "number" || !Number.isFinite(volume)) {
        throw new PlayerControlError(400, "Volume inválido.");
      }
      const clamped = Math.round(Math.max(0, Math.min(100, volume)));
      await player.setVolume(clamped);
      return { message: `Volume ajustado para ${clamped}%.` };
    },

    async seek(guildId, _actor, positionMs) {
      const player = requireActivePlayer(guildId);
      const currentTrack = player.queue.current;
      if (!currentTrack) {
        throw new PlayerControlError(409, "Não há nenhuma música tocando neste servidor.");
      }
      if (currentTrack.info.isStream) {
        throw new PlayerControlError(409, "Não é possível avançar ou voltar em transmissões ao vivo.");
      }
      if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) {
        throw new PlayerControlError(400, "Posição de tempo inválida.");
      }
      const durationMs = typeof currentTrack.info.duration === "number" ? currentTrack.info.duration : 0;
      const clamped = durationMs > 0 ? Math.min(durationMs, Math.round(positionMs)) : Math.round(positionMs);
      await player.seek(clamped);
      await refreshNowPlayingMessage(player, client);
      return { message: "Posição atualizada." };
    },

    async jumpToQueueIndex(guildId, actor, index) {
      const player = requireActivePlayer(guildId);
      if (!Number.isInteger(index) || index < 0 || index >= player.queue.tracks.length) {
        throw new PlayerControlError(400, "Posição na fila inválida.");
      }
      const target = player.queue.tracks[index];
      const title = target?.info.title || "a música selecionada";
      stopNowPlayingProgressTimer(player);
      // player.skip(skipTo) é 1-based no lavalink-client (skip(1) toca tracks[0], skip(2) toca tracks[1]...).
      await player.skip(index + 1);
      await sendTextChannelNotice(client, player, `${actorLabel(actor)} pulou para **${title}**.`);
      return { message: `Tocando "${title}".` };
    },

    async removeQueueIndex(guildId, _actor, index) {
      const player = requireActivePlayer(guildId);
      if (!Number.isInteger(index) || index < 0 || index >= player.queue.tracks.length) {
        throw new PlayerControlError(400, "Posição na fila inválida.");
      }
      const removedTrack = player.queue.tracks[index];
      await player.queue.splice(index, 1);
      await refreshNowPlayingMessage(player, client);
      const title = removedTrack?.info.title || "música";
      return { message: `"${title}" removida da fila.` };
    },

    async clearQueue(guildId) {
      const player = requireActivePlayer(guildId);
      const count = player.queue.tracks.length;
      if (count === 0) {
        return { message: "A fila já estava vazia." };
      }
      await player.queue.splice(0, count);
      await refreshNowPlayingMessage(player, client);
      return { message: `${count} música(s) removida(s) da fila.` };
    },

    async enqueue(guildId, actor, rawQuery, platform = "youtube") {
      const player = requireActivePlayer(guildId);
      if (!lavalink.useable) {
        throw new PlayerControlError(503, "O servidor de áudio está offline ou reconectando.");
      }

      const trimmed = rawQuery.trim();
      if (!trimmed) {
        throw new PlayerControlError(400, "Informe o nome da música ou um link do YouTube/Spotify.");
      }
      if (trimmed.length > MAX_QUERY_LENGTH) {
        throw new PlayerControlError(400, `A busca deve ter no máximo ${MAX_QUERY_LENGTH} caracteres.`);
      }

      const safePlatform = platform === "spotify" ? "spotify" : "youtube";
      const primarySource = safePlatform === "spotify" ? "spsearch" : "ytmsearch";
      const query = toQuery(trimmed);
      const requester = {
        id: `dashboard:${actor.username}`,
        username: actor.username,
        displayName: actor.displayName || actor.username,
        avatarUrl: null,
      };

      let result: Awaited<ReturnType<typeof player.search>> | undefined;
      try {
        if (isUrlQuery(trimmed)) {
          result = await player.search({ query }, requester);
        } else {
          result = await player.search({ query: trimmed, source: primarySource }, requester);
          if (
            !result ||
            result.loadType === "empty" ||
            result.loadType === "error" ||
            result.tracks.length === 0
          ) {
            const fallbackSource = safePlatform === "spotify" ? "ytmsearch" : "ytsearch";
            result = await player.search({ query: trimmed, source: fallbackSource }, requester);
          }
        }
      } catch (err) {
        console.warn("[WebControl] Falha na busca primária, tentando failover nos nós:", err);
      }

      if (!result || result.loadType === "empty" || result.loadType === "error" || result.tracks.length === 0) {
        const otherNodes = lavalink.nodeManager.nodes.filter(
          (n) => n.connected && n.id !== player.node?.id,
        );
        for (const altNode of otherNodes.values()) {
          try {
            const altResult = isUrlQuery(trimmed)
              ? await altNode.search({ query }, requester)
              : await altNode.search({ query: trimmed, source: primarySource }, requester);
            if (altResult && altResult.tracks.length > 0 && altResult.loadType !== "error") {
              result = altResult;
              player.node = altNode;
              break;
            }
          } catch {
            // Tenta próximo nó
          }
        }
      }

      if (!result || result.loadType === "empty" || result.loadType === "error" || result.tracks.length === 0) {
        throw new PlayerControlError(404, `Nenhum resultado encontrado para "${trimmed}".`);
      }

      if (result.loadType === "playlist" && result.tracks.length > 1) {
        const selectedId = result.playlist?.selectedTrack?.info.identifier;
        const tracksToAdd = slicePlaylistTracks(
          result.tracks as (Track | UnresolvedTrack)[],
          selectedId,
          MAX_PLAYLIST_TRACKS,
        );
        await player.queue.add(tracksToAdd);

        const playlistTitle = result.playlist?.title || result.playlist?.name || "Playlist";
        const playlistEmbed = buildPlaylistLoadedEmbed({
          playlistTitle,
          playlistUri: result.playlist?.uri || (isUrlQuery(trimmed) ? trimmed : undefined),
          tracksAdded: tracksToAdd,
          totalPlaylistTracks: result.tracks.length,
          requesterId: requester.id,
          requesterName: requester.displayName,
          thumbnailUrl: result.playlist?.thumbnail,
        });

        if (!player.playing && !player.paused) {
          await player.play();
        } else {
          await refreshNowPlayingMessage(player, client);
        }
        await sendTextChannelNotice(client, player, { embeds: [playlistEmbed] });
        return { message: `Playlist "${playlistTitle}" (${tracksToAdd.length} faixas) adicionada à fila.` };
      }

      const track = result.tracks[0];
      await player.queue.add(track);
      const position = player.queue.tracks.length;

      if (!player.playing && !player.paused) {
        await player.play();
      } else {
        await refreshNowPlayingMessage(player, client);
        await sendTextChannelNotice(client, player, {
          embeds: [buildQueuedTrackEmbed(track, position, requester.id, requester.displayName)],
        });
      }

      return { message: `"${track.info.title}" adicionada à fila.` };
    },
  };
}
