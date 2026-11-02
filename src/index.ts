import http from "node:http";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import type { VoicePacket } from "lavalink-client";
import { commandMap } from "./commands/index.js";
import { loadConfig } from "./config.js";
import { registerAllGuildsCommands, registerGuildCommands } from "./deploy-commands.js";
import { getLastError, recordBotError } from "./error-store.js";
import { handleMusicButton, MUSIC_BUTTON_IDS } from "./music/controls.js";
import { createMusicManager, handleVoiceStateUpdate } from "./music/manager.js";

const validButtonIds = new Set<string>(Object.values(MUSIC_BUTTON_IDS));

async function main(): Promise<void> {
  const config = loadConfig();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const lavalink = createMusicManager(client, config);

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          bot: client.user?.tag ?? "starting",
          uptimeSeconds: Math.floor(process.uptime()),
          lastError: getLastError(),
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  healthServer.listen(config.httpPort, "0.0.0.0", () => {
    console.log(`[Health] Servidor HTTP ativo em 0.0.0.0:${config.httpPort}/health`);
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

    const currentGuilds = readyClient.guilds.cache.map((g) => ({ id: g.id, name: g.name }));
    await registerAllGuildsCommands(currentGuilds, config);
  });

  client.on(Events.GuildCreate, async (guild) => {
    console.log(`[Bot] Adicionado ao novo servidor "${guild.name}" (${guild.id}). Sincronizando comandos...`);
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
        await command.execute(interaction, lavalink);
        return;
      }

      if (interaction.isButton() && validButtonIds.has(interaction.customId)) {
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
    healthServer.close();
    for (const player of lavalink.players.values()) {
      await player.destroy("Servidor encerrando").catch(() => {});
    }
    client.destroy();
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
