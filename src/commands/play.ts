import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Track, UnresolvedTrack } from "lavalink-client";
import { recordBotError } from "../error-store.js";
import {
  buildNowPlayingControls,
  buildNowPlayingEmbed,
  buildPlaylistLoadedEmbed,
  buildQueuedTrackEmbed,
  disablePreviousNowPlayingMessage,
  getMemberVoiceChannelId,
  markInitialPlayTrack,
  refreshNowPlayingMessage,
  saveNowPlayingMessage,
  startNowPlayingProgressTimer,
} from "../music/controls.js";
import { formatDuration, isUrlQuery, MAX_PLAYLIST_TRACKS, slicePlaylistTracks, toQuery } from "../music/resolve.js";
import type { SlashCommand } from "./types.js";

export const playCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Toca uma música ou playlist do YouTube ou Spotify")
    .addStringOption((opt) =>
      opt
        .setName("musica")
        .setDescription("Nome da música ou link do YouTube / Spotify")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("plataforma")
        .setDescription("Plataforma para busca por nome (padrão: YouTube)")
        .setRequired(false)
        .addChoices(
          { name: "YouTube", value: "youtube" },
          { name: "Spotify", value: "spotify" },
        ),
    ),

  async execute(interaction, lavalink) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        content:
          "O bot ainda não foi adicionado como membro (`bot`) neste servidor. Use o link de convite com escopo `bot`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userVoiceId = getMemberVoiceChannelId(interaction);
    if (!userVoiceId) {
      await interaction.reply({
        content: "Você precisa entrar em um canal de voz antes de usar `/play`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const existingPlayer = lavalink.getPlayer(interaction.guildId);
    if (existingPlayer?.voiceChannelId && existingPlayer.voiceChannelId !== userVoiceId) {
      await interaction.reply({
        content: `Já estou tocando em <#${existingPlayer.voiceChannelId}>. Entre lá para adicionar músicas.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!lavalink.useable) {
      await interaction.reply({
        content: "O servidor de áudio ainda está iniciando. Tente novamente em alguns segundos.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const rawInput = interaction.options.getString("musica", true);
      const platformOption = interaction.options.getString("plataforma") ?? "youtube";
      const query = toQuery(rawInput);

      const player =
        existingPlayer ??
        lavalink.createPlayer({
          guildId: interaction.guildId,
          voiceChannelId: userVoiceId,
          textChannelId: interaction.channelId,
          selfDeaf: true,
          selfMute: false,
          volume: 100,
        });

      player.textChannelId = interaction.channelId;

      if (!player.connected) {
        await player.connect();
      }

      const memberDisplayName =
        interaction.member && "displayName" in interaction.member && typeof interaction.member.displayName === "string"
          ? interaction.member.displayName
          : interaction.user.displayName;
      const requester = {
        id: interaction.user.id,
        username: interaction.user.username,
        displayName: memberDisplayName,
        avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
      };
      const primarySource = platformOption === "spotify" ? "spsearch" : "ytmsearch";

      let result: Awaited<ReturnType<typeof player.search>> | undefined;

      try {
        if (isUrlQuery(rawInput)) {
          result = await player.search({ query }, requester);
        } else {
          result = await player.search({ query: rawInput.trim(), source: primarySource }, requester);
          if (
            !result ||
            result.loadType === "empty" ||
            result.loadType === "error" ||
            result.tracks.length === 0
          ) {
            const fallbackSource = platformOption === "spotify" ? "ytmsearch" : "ytsearch";
            result = await player.search({ query: rawInput.trim(), source: fallbackSource }, requester);
          }
        }
      } catch (searchError) {
        console.warn("[Play] Falha na busca primária, tentando failover nos nós:", searchError);
      }

      // Failover para nós alternativos se a busca falhou ou retornou vazia
      if (!result || result.loadType === "empty" || result.loadType === "error" || result.tracks.length === 0) {
        const otherNodes = lavalink.nodeManager.nodes.filter(
          (n) => n.connected && n.id !== player.node?.id,
        );
        for (const altNode of otherNodes.values()) {
          try {
            const altResult = isUrlQuery(rawInput)
              ? await altNode.search({ query }, requester)
              : await altNode.search({ query: rawInput.trim(), source: primarySource }, requester);

            if (altResult && altResult.tracks.length > 0 && altResult.loadType !== "error") {
              result = altResult;
              player.node = altNode;
              break;
            }
          } catch {
            // Continua tentando próximo nó
          }
        }
      }

      if (!result || result.loadType === "empty" || result.loadType === "error" || result.tracks.length === 0) {
        if (!player.playing && !player.paused && player.queue.tracks.length === 0) {
          await player.destroy("Nenhum resultado encontrado").catch(() => {});
        }
        await interaction.editReply({
          content: `Não encontrei nenhum resultado para **${rawInput}**. Tente buscar pelo nome da música ou link do Spotify/YouTube.`,
        });
        return;
      }

      if (result.loadType === "playlist" && result.tracks.length > 1) {
        const selectedId = result.playlist?.selectedTrack?.info.identifier;
        const tracksToAdd = slicePlaylistTracks(
          result.tracks as (Track | UnresolvedTrack)[],
          selectedId,
          MAX_PLAYLIST_TRACKS,
        );
        const firstTrack = tracksToAdd[0];

        await player.queue.add(tracksToAdd);

        const playlistEmbed = buildPlaylistLoadedEmbed({
          playlistTitle: result.playlist?.title || result.playlist?.name || "Playlist",
          playlistUri: result.playlist?.uri || (isUrlQuery(rawInput) ? rawInput.trim() : undefined),
          tracksAdded: tracksToAdd,
          totalPlaylistTracks: result.tracks.length,
          requesterId: interaction.user.id,
          thumbnailUrl: result.playlist?.thumbnail,
        });

        if (!player.playing && !player.paused) {
          await disablePreviousNowPlayingMessage(player, interaction.client);
          markInitialPlayTrack(player, firstTrack.info.identifier);
          await player.play();
          const sent = await interaction.editReply({
            embeds: [playlistEmbed, buildNowPlayingEmbed(firstTrack as Track, player)],
            components: buildNowPlayingControls(player, false),
          });
          saveNowPlayingMessage(player, interaction.channelId, sent.id, firstTrack.info.identifier);
          startNowPlayingProgressTimer(player, interaction.client);
        } else {
          await interaction.editReply({
            embeds: [playlistEmbed],
          });
          await refreshNowPlayingMessage(player, interaction.client);
        }
        return;
      }

      const track = result.tracks[0];
      await player.queue.add(track);

      const position = player.queue.tracks.length;

      if (!player.playing && !player.paused) {
        await disablePreviousNowPlayingMessage(player, interaction.client);
        markInitialPlayTrack(player, track.info.identifier);
        await player.play();
        const sent = await interaction.editReply({
          embeds: [buildNowPlayingEmbed(track as Track, player)],
          components: buildNowPlayingControls(player, false),
        });
        saveNowPlayingMessage(player, interaction.channelId, sent.id, track.info.identifier);
        startNowPlayingProgressTimer(player, interaction.client);
      } else {
        await interaction.editReply({
          embeds: [buildQueuedTrackEmbed(track, position, interaction.user.id)],
        });
        await refreshNowPlayingMessage(player, interaction.client);
      }
    } catch (error) {
      console.error("[Play] Falha durante execução de /play:", error);
      recordBotError({
        type: "interaction",
        command: "play",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      const userMessage =
        error instanceof Error && error.message.includes("not connected")
          ? "O servidor de áudio está reconectando no momento. Tente novamente em alguns segundos."
          : "Não foi possível reproduzir a faixa selecionada. O servidor de áudio pode estar instável no momento. Tente novamente.";

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: userMessage }).catch(() => {});
      } else {
        await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },

  async autocomplete(interaction, lavalink) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "musica") {
      await interaction.respond([]);
      return;
    }

    const query = focused.value.trim();
    if (!query || isUrlQuery(query) || query.length < 2) {
      await interaction.respond([]);
      return;
    }

    const platform = interaction.options.getString("plataforma") ?? "youtube";
    const source = platform === "spotify" ? "spsearch" : "ytmsearch";

    const node = lavalink.nodeManager.leastUsedNodes()[0];
    if (!node) {
      await interaction.respond([]);
      return;
    }

    try {
      let result = await node.search({ query, source }, interaction.user);
      if (!result || !result.tracks || result.tracks.length === 0) {
        const otherNodes = lavalink.nodeManager.nodes.filter((n) => n.connected && n.id !== node.id);
        for (const altNode of otherNodes.values()) {
          try {
            const altRes = await altNode.search({ query, source }, interaction.user);
            if (altRes && altRes.tracks && altRes.tracks.length > 0) {
              result = altRes;
              break;
            }
          } catch {
            // Continua
          }
        }
      }

      if (!result || !result.tracks || result.tracks.length === 0) {
        await interaction.respond([]);
        return;
      }

      const choices = result.tracks.slice(0, 10).map((t) => {
        const title = t.info.title.length > 55 ? `${t.info.title.slice(0, 54)}…` : t.info.title;
        const author = t.info.author ? ` - ${t.info.author}` : "";
        const duration = formatDuration(t.info.duration, t.info.isStream);
        const name = `${title} [${duration}]${author}`.slice(0, 100);
        const value = t.info.uri && t.info.uri.length <= 100 ? t.info.uri : t.info.title.slice(0, 100);
        return { name, value };
      });

      await interaction.respond(choices);
    } catch {
      await interaction.respond([]).catch(() => {});
    }
  },
};
