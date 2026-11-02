import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import { LavalinkManager, type Player, type Track } from "lavalink-client";
import type { AppConfig } from "../config.js";
import { recordBotError } from "../error-store.js";
import {
  buildNowPlayingControls,
  buildNowPlayingEmbed,
  consumeInitialPlayTrack,
  disablePreviousNowPlayingMessage,
  getStoredNowPlayingMessage,
  refreshNowPlayingMessage,
  saveNowPlayingMessage,
  startNowPlayingProgressTimer,
  stopNowPlayingProgressTimer,
  type RequesterInfo,
} from "./controls.js";
import { formatTrackErrorReason } from "./resolve.js";

const EMPTY_CHANNEL_TIMER_KEY = "emptyChannelTimer";

const NODE_RETRY_DELAY_MS = 5_000;
const NODE_MAX_RETRY_DELAY_MS = 10 * 60_000;
const NODE_STABLE_AFTER_MS = 60_000;
// Nós públicos fecham com 4000 quando o bot excede o limite de tentativas de conexão;
// reconectar a cada 5s mantém o bloqueio ativo indefinidamente.
const NODE_RATE_LIMIT_CLOSE_CODE = 4000;

async function sendToPlayerTextChannel(
  client: Client,
  player: Player,
  payload: Parameters<import("discord.js").TextChannel["send"]>[0],
) {
  if (!player.textChannelId) {
    return null;
  }
  try {
    const channel = await client.channels.fetch(player.textChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return null;
    }
    return await channel.send(payload);
  } catch (err) {
    console.error("[Music] Falha ao enviar mensagem no canal de texto:", err);
    return null;
  }
}

function clearEmptyChannelTimer(player: Player): void {
  const existing = player.getData<NodeJS.Timeout | undefined>(EMPTY_CHANNEL_TIMER_KEY);
  if (existing) {
    clearTimeout(existing);
    player.deleteData(EMPTY_CHANNEL_TIMER_KEY);
  }
}

function countHumanMembers(channel: VoiceBasedChannel): number {
  return channel.members.filter((member) => !member.user.bot).size;
}

export function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  lavalink: LavalinkManager,
  config: AppConfig,
): void {
  const guildId = newState.guild.id || oldState.guild.id;
  const player = lavalink.getPlayer(guildId);
  if (!player || !player.voiceChannelId) {
    return;
  }

  const guild = newState.guild ?? oldState.guild;
  const voiceChannel = guild.channels.cache.get(player.voiceChannelId);
  if (!voiceChannel || !voiceChannel.isVoiceBased()) {
    return;
  }

  const humans = countHumanMembers(voiceChannel);
  if (humans === 0) {
    const existingTimer = player.getData<NodeJS.Timeout | undefined>(EMPTY_CHANNEL_TIMER_KEY);
    if (!existingTimer) {
      const timer = setTimeout(async () => {
        const currentPlayer = lavalink.getPlayer(guildId);
        if (!currentPlayer) {
          return;
        }
        await disablePreviousNowPlayingMessage(currentPlayer, oldState.client);
        await sendToPlayerTextChannel(
          oldState.client,
          currentPlayer,
          `Saí da call após ${config.idleTimeoutMin} minutos sem ninguém por lá.`,
        );
        await currentPlayer.destroy("Call vazia por tempo limite");
      }, config.idleTimeoutMs);

      player.setData(EMPTY_CHANNEL_TIMER_KEY, timer);
    }
  } else {
    clearEmptyChannelTimer(player);
  }
}

export function createMusicManager(client: Client, config: AppConfig): LavalinkManager {
  const nodes = [
    {
      id: "main-node",
      host: config.lavalinkHost,
      port: config.lavalinkPort,
      authorization: config.lavalinkPassword,
      secure: config.lavalinkSecure,
      retryAmount: 10,
      retryDelay: NODE_RETRY_DELAY_MS,
    },
  ];

  if (config.lavalinkFallbackNodes && config.lavalinkHost !== "lavalinkv4.serenetia.com") {
    nodes.push({
      id: "fallback-serenetia",
      host: "lavalinkv4.serenetia.com",
      port: 443,
      authorization: "https://seretia.link/discord",
      secure: true,
      retryAmount: 10,
      retryDelay: NODE_RETRY_DELAY_MS,
    });
  }

  const lavalink = new LavalinkManager({
    nodes,
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard?.send(payload);
    },
    autoSkip: true,
    client: {
      id: config.discordClientId,
      username: "panchat",
    },
    playerOptions: {
      defaultSearchPlatform: "ytmsearch",
      onDisconnect: {
        autoReconnect: true,
        destroyPlayer: false,
      },
      onEmptyQueue: {
        destroyAfterMs: config.idleTimeoutMs,
      },
      requesterTransformer: (requester: unknown): RequesterInfo => {
        if (requester && typeof requester === "object" && "id" in requester) {
          const r = requester as { id: string; username?: string };
          return { id: r.id, username: r.username ?? "Usuário" };
        }
        return { id: String(requester ?? ""), username: "Usuário" };
      },
    },
  });

  const stableTimers = new Map<string, NodeJS.Timeout>();

  lavalink.nodeManager.on("connect", (node) => {
    console.log(`[Lavalink] Conectado ao nó "${node.id}" (${node.options.host}:${node.options.port})`);
    clearTimeout(stableTimers.get(node.id));
    stableTimers.set(
      node.id,
      setTimeout(() => {
        stableTimers.delete(node.id);
        if (node.connected) {
          node.options.retryDelay = NODE_RETRY_DELAY_MS;
        }
      }, NODE_STABLE_AFTER_MS),
    );
  });

  lavalink.nodeManager.on("disconnect", (node, { code, reason }) => {
    clearTimeout(stableTimers.get(node.id));
    stableTimers.delete(node.id);

    if (code === NODE_RATE_LIMIT_CLOSE_CODE) {
      const current = node.options.retryDelay ?? NODE_RETRY_DELAY_MS;
      node.options.retryDelay = Math.min(current * 2, NODE_MAX_RETRY_DELAY_MS);
    }

    const retryInSec = Math.round((node.options.retryDelay ?? NODE_RETRY_DELAY_MS) / 1000);
    console.warn(
      `[Lavalink] Nó "${node.id}" desconectado (code ${code ?? "?"}: ${reason ?? "sem motivo"}). Nova tentativa em ${retryInSec}s.`,
    );
    recordBotError({
      type: "lavalink",
      message: `Node "${node.id}" disconnected (code ${code ?? "?"}): ${reason ?? "no reason"}`,
    });
  });

  lavalink.nodeManager.on("error", (node, error) => {
    console.error(`[Lavalink] Erro no nó "${node.id}":`, error.message);
    recordBotError({
      type: "lavalink",
      message: `Node "${node.id}": ${error.message}`,
      stack: error.stack,
    });
  });

  lavalink.on("trackStart", async (player, track) => {
    if (!track) {
      return;
    }
    if (consumeInitialPlayTrack(player, track.info.identifier)) {
      await refreshNowPlayingMessage(player, client);
      startNowPlayingProgressTimer(player, client);
      return;
    }
    const existing = getStoredNowPlayingMessage(player);
    if (existing && existing.trackId === track.info.identifier) {
      await refreshNowPlayingMessage(player, client);
      startNowPlayingProgressTimer(player, client);
      return;
    }

    await disablePreviousNowPlayingMessage(player, client);
    const sent = await sendToPlayerTextChannel(client, player, {
      embeds: [buildNowPlayingEmbed(track as Track, player)],
      components: buildNowPlayingControls(player, false),
    });
    if (sent && player.textChannelId) {
      saveNowPlayingMessage(player, player.textChannelId, sent.id, track.info.identifier);
    }
    startNowPlayingProgressTimer(player, client);
  });

  lavalink.on("trackError", async (player, track, payload) => {
    stopNowPlayingProgressTimer(player);
    const title = track?.info?.title ?? "faixa desconhecida";
    const reason = payload.exception?.message ?? "erro desconhecido ao reproduzir";
    console.error(`[Music] Erro na faixa "${title}":`, reason);
    recordBotError({
      type: "lavalink",
      message: `Track "${title}" error: ${reason}`,
    });
    await sendToPlayerTextChannel(
      client,
      player,
      `Não foi possível reproduzir **${title}** (${formatTrackErrorReason(reason)}). Pulando para a próxima...`,
    );
  });

  lavalink.on("trackStuck", async (player, track) => {
    stopNowPlayingProgressTimer(player);
    const title = track?.info?.title ?? "faixa desconhecida";
    console.warn(`[Music] Faixa travou: "${title}"`);
    await sendToPlayerTextChannel(
      client,
      player,
      `A reprodução de **${title}** travou. Pulando para a próxima...`,
    );
    if (player.queue.tracks.length > 0) {
      await player.skip();
    } else {
      await player.stopPlaying(true, false);
    }
  });

  lavalink.on("queueEnd", async (player) => {
    stopNowPlayingProgressTimer(player);
    await disablePreviousNowPlayingMessage(player, client);
    await sendToPlayerTextChannel(
      client,
      player,
      `A fila terminou. Se ninguém adicionar mais músicas em ${config.idleTimeoutMin} minutos, sairei da call.`,
    );
  });

  lavalink.on("playerQueueEmptyEnd", async (player) => {
    stopNowPlayingProgressTimer(player);
    await sendToPlayerTextChannel(
      client,
      player,
      `Saí da call após ${config.idleTimeoutMin} minutos de inatividade.`,
    );
  });

  lavalink.on("playerDestroy", async (player) => {
    stopNowPlayingProgressTimer(player);
    clearEmptyChannelTimer(player);
    await disablePreviousNowPlayingMessage(player, client);
  });

  return lavalink;
}
