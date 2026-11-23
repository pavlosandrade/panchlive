import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import type { Track, UnresolvedTrack, VoicePacket } from "lavalink-client";
import { bootstrapAdminFromEnv, hasAnyAccount } from "./auth/service.js";
import { commandMap } from "./commands/index.js";
import { loadConfig } from "./config.js";
import { openAppDatabase } from "./db/database.js";
import { registerAllGuildsCommands, registerGuildCommands } from "./deploy-commands.js";
import { recordBotError } from "./error-store.js";
import {
  getTrackBannerUrl,
  handleMusicButton,
  MUSIC_BUTTON_IDS,
  type RequesterInfo,
} from "./music/controls.js";
import { createMusicManager, handleVoiceStateUpdate } from "./music/manager.js";
import { detectTrackPlatform } from "./music/resolve.js";
import { createWebPlayerController } from "./music/web-controller.js";
import { StatsCollector } from "./stats/collector.js";
import {
  createWebServer,
  type LivePlayerSnapshot,
  type LiveSnapshot,
  type LiveTrackSummary,
} from "./web/server.js";

const validButtonIds = new Set<string>(Object.values(MUSIC_BUTTON_IDS));

function toLiveTrackSummary(track: Track | UnresolvedTrack): LiveTrackSummary {
  const requester = track.requester as Partial<RequesterInfo> | null | undefined;
  const requesterName = requester?.displayName || requester?.username || null;
  return {
    title: track.info.title,
    author: track.info.author ?? null,
    uri: track.info.uri ?? null,
    artworkUrl: track.info.artworkUrl ?? getTrackBannerUrl(track),
    platform: detectTrackPlatform(track.info.sourceName, track.info.uri),
    durationMs: typeof track.info.duration === "number" ? track.info.duration : 0,
    isStream: Boolean(track.info.isStream),
    requesterName,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openAppDatabase(config.dataDir);
  const stats = new StatsCollector(db);

  const createdBootstrapAdmin = await bootstrapAdminFromEnv(
    db,
    config.dashboardAdminUsername,
    config.dashboardAdminPassword,
  );
  if (createdBootstrapAdmin) {
    console.log(`[Dashboard] Conta administradora inicial "${config.dashboardAdminUsername}" criada via .env.`);
  } else if (!hasAnyAccount(db) && config.isProduction && !config.dashboardSetupToken) {
    console.warn(
      "[Dashboard] Nenhuma conta configurada e setup web bloqueado em produção. Defina DASHBOARD_ADMIN_USERNAME + DASHBOARD_ADMIN_PASSWORD ou DASHBOARD_SETUP_TOKEN no .env.",
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const lavalink = createMusicManager(client, config, stats);

  const getLiveSnapshot = (guildId?: string): LiveSnapshot => {
    const players: LivePlayerSnapshot[] = [];

    for (const player of lavalink.players.values()) {
      if (guildId && player.guildId !== guildId) {
        continue;
      }
      const guild = client.guilds.cache.get(player.guildId);
      const voiceChannel = player.voiceChannelId
        ? guild?.channels.cache.get(player.voiceChannelId)
        : undefined;

      players.push({
        guildId: player.guildId,
        guildName: guild?.name ?? `Servidor ${player.guildId}`,
        voiceChannelName: voiceChannel?.name ?? null,
        playing: player.playing,
        paused: player.paused,
        volume: typeof player.volume === "number" ? player.volume : 100,
        repeatMode: player.repeatMode ?? "off",
        positionMs: player.position ?? 0,
        queueLength: player.queue.tracks.length,
        currentTrack: player.queue.current ? toLiveTrackSummary(player.queue.current) : null,
        upcoming: player.queue.tracks.slice(0, 25).map(toLiveTrackSummary),
      });
    }

    const nodes = Array.from(lavalink.nodeManager.nodes.values()).map((node) => ({
      id: node.id,
      connected: node.connected,
      players: node.stats?.players ?? 0,
      playingPlayers: node.stats?.playingPlayers ?? 0,
    }));

    return {
      bot: {
        tag: client.user?.tag ?? "starting",
        ready: client.isReady(),
        uptimeSeconds: Math.floor(process.uptime()),
        guildCount: client.guilds.cache.size,
      },
      nodes,
      players,
    };
  };

  const playerControl = createWebPlayerController({ lavalink, client });

  const webServer = createWebServer({
    db,
    isProduction: config.isProduction,
    trustProxy: config.trustProxy,
    requireHttps: config.dashboardRequireHttps,
    publicUrl: config.dashboardPublicUrl,
    setupToken: config.dashboardSetupToken,
    getBotTag: () => client.user?.tag ?? "starting",
    getLiveSnapshot,
    playerControl,
  });

  webServer.listen(config.httpPort, "0.0.0.0", () => {
    console.log(
      `[Web] Dashboard e Healthcheck ativos em 0.0.0.0:${config.httpPort} (HTTPS obrigatório: ${config.dashboardRequireHttps}, trustProxy: ${config.trustProxy})`,
    );
  });

  client.on("raw", (data) => {
    void lavalink.sendRawData(data as VoicePacket);
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Bot] Logado como ${readyClient.user.tag}`);
    await lavalink.init({
      id: readyClient.user.id,
      username: readyClient.user.username,
    });

    const currentGuilds = readyClient.guilds.cache.map((g) => {
      stats.syncGuild({
        guildId: g.id,
        name: g.name,
        iconUrl: g.iconURL({ size: 128 }),
      });
      return { id: g.id, name: g.name };
    });
    await registerAllGuildsCommands(currentGuilds, config);
  });

  client.on(Events.GuildCreate, async (guild) => {
    console.log(`[Bot] Adicionado ao novo servidor "${guild.name}" (${guild.id}). Sincronizando comandos...`);
    stats.syncGuild({
      guildId: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128 }),
    });
    try {
      await registerGuildCommands(guild.id, config, guild.name);
    } catch (err) {
      console.error(`[Bot] Falha ao registrar comandos no novo servidor ${guild.id}:`, err);
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState, lavalink, config);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        const command = commandMap.get(interaction.commandName);
        if (command?.autocomplete) {
          await command.autocomplete(interaction, lavalink);
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        const command = commandMap.get(interaction.commandName);
        if (!command) {
          return;
        }
        if (interaction.guildId) {
          const memberDisplayName =
            interaction.member &&
            "displayName" in interaction.member &&
            typeof interaction.member.displayName === "string"
              ? interaction.member.displayName
              : interaction.user.displayName;
          stats.recordCommand({
            guildId: interaction.guildId,
            guildName: interaction.guild?.name,
            guildIconUrl: interaction.guild?.iconURL({ size: 128 }),
            userId: interaction.user.id,
            username: interaction.user.username,
            displayName: memberDisplayName,
            avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
            commandName: interaction.commandName,
            interactionType: "slash",
          });
        }
        await command.execute(interaction, lavalink);
        return;
      }

      if (interaction.isButton() && validButtonIds.has(interaction.customId)) {
        if (interaction.guildId) {
          const memberDisplayName =
            interaction.member &&
            "displayName" in interaction.member &&
            typeof interaction.member.displayName === "string"
              ? interaction.member.displayName
              : interaction.user.displayName;
          stats.recordCommand({
            guildId: interaction.guildId,
            guildName: interaction.guild?.name,
            guildIconUrl: interaction.guild?.iconURL({ size: 128 }),
            userId: interaction.user.id,
            username: interaction.user.username,
            displayName: memberDisplayName,
            avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
            commandName: interaction.customId,
            interactionType: "button",
          });
        }
        await handleMusicButton(interaction, lavalink);
      }
    } catch (error) {
      console.error("[Bot] Erro ao processar interação:", error);
      recordBotError({
        type: "interaction",
        command: interaction.isChatInputCommand()
          ? interaction.commandName
          : interaction.isButton()
            ? interaction.customId
            : undefined,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      const message = "Ocorreu um erro ao executar essa ação. Tente novamente.";
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[Bot] Recebido ${signal}. Encerrando conexões...`);
    stats.flushOnShutdown();
    webServer.close();
    for (const player of lavalink.players.values()) {
      await player.destroy("Servidor encerrando").catch(() => {});
    }
    client.destroy();
    try {
      db.close();
    } catch {
      // Ignora caso o banco já esteja fechado
    }
    process.exit(0);
  };

  // lavalink-client lança erros em handlers assíncronos (ex.: nó sem /v4/info) que viram
  // rejeições não tratadas; sem este handler o Node encerra o processo.
  process.on("unhandledRejection", (reason) => {
    console.error("[Bot] Rejeição não tratada:", reason);
    recordBotError({
      type: "fatal",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error("[Bot] Erro fatal ao iniciar:", err);
  process.exit(1);
});
