import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
} from "discord.js";
import type { LavalinkManager, Player, RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import {
  detectTrackPlatform,
  formatDuration,
  formatProgressBar,
  formatQueueLines,
  getPlatformTheme,
} from "./resolve.js";

export const MUSIC_BUTTON_IDS = {
  TOGGLE: "music:toggle",
  SKIP: "music:skip",
  STOP: "music:stop",
  LOOP: "music:loop",
  SHUFFLE: "music:shuffle",
  QUEUE: "music:queue",
  HELP: "music:help",
} as const;

const NOW_PLAYING_DATA_KEY = "nowPlayingMessage";
const INITIAL_PLAY_TRACK_KEY = "initialPlayTrackId";

interface StoredNowPlayingMessage {
  channelId: string;
  messageId: string;
  trackId?: string;
}

export function markInitialPlayTrack(player: Player, trackId: string | undefined): void {
  if (trackId) {
    player.setData(INITIAL_PLAY_TRACK_KEY, trackId);
  }
}

export function consumeInitialPlayTrack(player: Player, trackId: string | undefined): boolean {
  const stored = player.getData<string | undefined>(INITIAL_PLAY_TRACK_KEY);
  if (stored && trackId && stored === trackId) {
    player.deleteData(INITIAL_PLAY_TRACK_KEY);
    return true;
  }
  return false;
}

export interface RequesterInfo {
  id: string;
  username: string;
}

export function getRequesterId(track: Track | UnresolvedTrack | null | undefined): string | undefined {
  if (!track || !track.requester || typeof track.requester !== "object") {
    return undefined;
  }
  const req = track.requester as Partial<RequesterInfo>;
  return typeof req.id === "string" ? req.id : undefined;
}

export function getMemberVoiceChannelId(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): string | null {
  const fromVoiceState = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId;
  if (fromVoiceState) {
    return fromVoiceState;
  }
  const member = interaction.member;
  if (!member || !("voice" in member)) {
    return null;
  }
  return (member as GuildMember).voice.channelId;
}

/**
 * Valida se o usuário pode controlar o player atual (precisa estar na mesma call que o bot).
 * Retorna uma string de erro caso inválido, ou null se estiver tudo certo.
 */
export function validateVoiceControl(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  player: Player | undefined,
): string | null {
  const userChannelId = getMemberVoiceChannelId(interaction);
  if (!userChannelId) {
    return "Você precisa estar em um canal de voz para usar este controle.";
  }
  if (!player || !player.voiceChannelId) {
    return "Não há nada tocando no momento.";
  }
  if (player.voiceChannelId !== userChannelId) {
    return `Você precisa estar na mesma call que o bot (<#${player.voiceChannelId}>) para usar este controle.`;
  }
  return null;
}

function getNextRepeatMode(mode: RepeatMode | undefined): RepeatMode {
  switch (mode) {
    case "off":
    case undefined:
      return "track";
    case "track":
      return "queue";
    case "queue":
      return "off";
  }
}

export function getTrackBannerUrl(track: Track | UnresolvedTrack): string | null {
  const artwork = track.info.artworkUrl;
  if (artwork && artwork.includes("i.scdn.co/image/")) {
    return artwork.replace("ab67616d00001e02", "ab67616d0000b273");
  }
  const id = track.info.identifier;
  if (id && /^[\w-]{11}$/.test(id)) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  return artwork ?? null;
}

export function buildNowPlayingEmbed(track: Track, player?: Player): EmbedBuilder {
  const paused = player?.paused ?? false;
  const queueTracks = player?.queue.tracks ?? [];
  const nextTrack = queueTracks[0];

  const platform = detectTrackPlatform(track.info.sourceName, track.info.uri);
  const theme = getPlatformTheme(platform);

  const progress = formatProgressBar(player?.position ?? 0, track.info.duration, track.info.isStream);
  const requesterId = getRequesterId(track);

  const embed = new EmbedBuilder()
    .setAuthor({ name: theme.name })
    .setColor(theme.color)
    .setTitle(paused ? "Pausado" : "Tocando agora")
    .setDescription(
      track.info.uri ? `**[${track.info.title}](${track.info.uri})**` : `**${track.info.title}**`,
    )
    .addFields(
      { name: "Progresso", value: progress, inline: true },
      {
        name: "Pedido por",
        value: requesterId ? `<@${requesterId}>` : "Desconhecido",
        inline: true,
      },
    );

  if (nextTrack) {
    const nextUpValue = `${
      nextTrack.info.uri
        ? `**[${nextTrack.info.title}](${nextTrack.info.uri})**`
        : `**${nextTrack.info.title}**`
    } \`[${formatDuration(nextTrack.info.duration, nextTrack.info.isStream)}]\`${
      queueTracks.length > 1 ? ` *(+${queueTracks.length - 1} na fila)*` : ""
    }`;

    embed.addFields({ name: "Próxima música", value: nextUpValue, inline: false });
  }

  const bannerUrl = getTrackBannerUrl(track);
  if (bannerUrl) {
    embed.setImage(bannerUrl);
  }

  return embed;
}

export function buildQueuedTrackEmbed(
  track: Track | UnresolvedTrack,
  position: number,
  requesterId: string,
): EmbedBuilder {
  const duration = formatDuration(track.info.duration, track.info.isStream);
  const platform = detectTrackPlatform(track.info.sourceName, track.info.uri);
  const theme = getPlatformTheme(platform);

  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setAuthor({ name: `${theme.name} • Adicionado à fila` })
    .setDescription(
      track.info.uri ? `**[${track.info.title}](${track.info.uri})**` : `**${track.info.title}**`,
    )
    .addFields(
      { name: "Duração", value: `\`${duration}\``, inline: true },
      { name: "Posição na fila", value: `\`#${position}\``, inline: true },
      { name: "Pedido por", value: `<@${requesterId}>`, inline: true },
    );

  const thumb = track.info.artworkUrl ?? getTrackBannerUrl(track);
  if (thumb) {
    embed.setThumbnail(thumb);
  }

  return embed;
}

export function buildPlaylistLoadedEmbed(options: {
  playlistTitle: string;
  playlistUri?: string;
  tracksAdded: (Track | UnresolvedTrack)[];
  totalPlaylistTracks: number;
  requesterId: string;
  thumbnailUrl?: string | null;
}): EmbedBuilder {
  const { playlistTitle, playlistUri, tracksAdded, totalPlaylistTracks, requesterId, thumbnailUrl } =
    options;

  const firstTrack = tracksAdded[0];
  const platform = detectTrackPlatform(firstTrack?.info.sourceName, playlistUri ?? firstTrack?.info.uri);
  const theme = getPlatformTheme(platform);

  const totalDurationMs = tracksAdded.reduce((acc, t) => acc + (t.info.duration ?? 0), 0);
  const formattedTotalDuration = formatDuration(totalDurationMs, false);
  const wasCapped = totalPlaylistTracks > tracksAdded.length;

  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setAuthor({ name: `${theme.name} • Playlist adicionada à fila` })
    .setDescription(
      playlistUri ? `**[${playlistTitle}](${playlistUri})**` : `**${playlistTitle}**`,
    )
    .addFields(
      {
        name: "Músicas adicionadas",
        value: wasCapped
          ? `\`${tracksAdded.length}\` *(limite máx. de ${tracksAdded.length} de ${totalPlaylistTracks})*`
          : `\`${tracksAdded.length}\``,
        inline: true,
      },
      { name: "Duração total", value: `\`${formattedTotalDuration}\``, inline: true },
      { name: "Pedido por", value: `<@${requesterId}>`, inline: true },
    );

  const thumb =
    thumbnailUrl ??
    (firstTrack ? (firstTrack.info.artworkUrl ?? getTrackBannerUrl(firstTrack)) : null);
  if (thumb) {
    embed.setThumbnail(thumb);
  }

  return embed;
}

export function buildNowPlayingControls(
  player?: Player,
  disabled = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const paused = player?.paused ?? false;
  const repeatMode = player?.repeatMode ?? "off";
  const queueLength = player?.queue.tracks.length ?? 0;
  const currentTrack = player?.queue.current;
  const currentUri = currentTrack?.info.uri;

  const platform = detectTrackPlatform(currentTrack?.info.sourceName, currentUri);
  const theme = getPlatformTheme(platform);
  const brandButtonStyle = platform === "spotify" ? ButtonStyle.Success : ButtonStyle.Danger;

  const loopLabel =
    repeatMode === "track"
      ? "Loop: Música"
      : repeatMode === "queue"
        ? "Loop: Fila"
        : "Loop: Off";

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.TOGGLE)
      .setLabel(paused ? "Retomar" : "Pausar")
      .setStyle(brandButtonStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.SKIP)
      .setLabel("Pular")
      .setStyle(brandButtonStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.STOP)
      .setLabel("Parar")
      .setStyle(brandButtonStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.LOOP)
      .setLabel(loopLabel)
      .setStyle(repeatMode === "off" ? ButtonStyle.Secondary : brandButtonStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.SHUFFLE)
      .setLabel("Shuffle")
      .setStyle(brandButtonStyle)
      .setDisabled(disabled || queueLength < 2),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.QUEUE)
      .setLabel(`Fila (${queueLength})`)
      .setStyle(brandButtonStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(MUSIC_BUTTON_IDS.HELP)
      .setLabel("Comandos")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );

  if (currentUri && /^https?:\/\//i.test(currentUri)) {
    row2.addComponents(
      new ButtonBuilder()
        .setLabel(theme.linkLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(currentUri),
    );
  }

  return [row1, row2];
}

export function getStoredNowPlayingMessage(player: Player): StoredNowPlayingMessage | undefined {
  return player.getData<StoredNowPlayingMessage | undefined>(NOW_PLAYING_DATA_KEY);
}

const progressTimers = new Map<string, NodeJS.Timeout>();

/**
 * Para o timer periódico de atualização da barra de progresso da guilda.
 */
export function stopNowPlayingProgressTimer(player: Player): void {
  const existing = progressTimers.get(player.guildId);
  if (existing) {
    clearInterval(existing);
    progressTimers.delete(player.guildId);
  }
}

/**
 * Inicia o timer periódico seguro (a cada 15 segundos) para atualizar
 * a barra de progresso no card de reprodução ativo.
 * 15 segundos evita estritamente o rate limit do Discord (máx. 5 edições a cada 5s por canal).
 */
export function startNowPlayingProgressTimer(player: Player, client: Client): void {
  stopNowPlayingProgressTimer(player);

  const timer = setInterval(async () => {
    if (!player.playing || player.paused || !player.queue.current) {
      return;
    }
    await refreshNowPlayingMessage(player, client);
  }, 15_000);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  progressTimers.set(player.guildId, timer);
}

/**
 * Desativa os botões da mensagem "Tocando agora" anterior, se existir.
 */
export async function disablePreviousNowPlayingMessage(
  player: Player,
  client: Client,
): Promise<void> {
  stopNowPlayingProgressTimer(player);
  const previous = getStoredNowPlayingMessage(player);
  if (!previous) {
    return;
  }
  player.deleteData(NOW_PLAYING_DATA_KEY);

  try {
    const channel = await client.channels.fetch(previous.channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      return;
    }
    const message = await channel.messages.fetch(previous.messageId);
    await message.edit({
      components: buildNowPlayingControls(player, true),
    });
  } catch {
    // Mensagem ou canal pode ter sido apagado; ignoramos com segurança.
  }
}

export function saveNowPlayingMessage(
  player: Player,
  channelId: string,
  messageId: string,
  trackId?: string,
): void {
  player.setData(NOW_PLAYING_DATA_KEY, {
    channelId,
    messageId,
    trackId,
  } satisfies StoredNowPlayingMessage);
}

/**
 * Atualiza o embed e os botões na mensagem "Tocando agora" ativa.
 */
export async function refreshNowPlayingMessage(
  player: Player,
  client: Client,
): Promise<void> {
  const stored = getStoredNowPlayingMessage(player);
  const currentTrack = player.queue.current;
  if (!stored || !currentTrack) {
    return;
  }

  try {
    const channel = await client.channels.fetch(stored.channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      return;
    }
    const message = await channel.messages.fetch(stored.messageId);
    await message.edit({
      embeds: [buildNowPlayingEmbed(currentTrack, player)],
      components: buildNowPlayingControls(player, false),
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 10008 || code === 10003) {
      stopNowPlayingProgressTimer(player);
      player.deleteData(NOW_PLAYING_DATA_KEY);
    }
  }
}

export function buildQueueEmbedForPlayer(player: Player): EmbedBuilder {
  const current = player.queue.current;
  const platform = detectTrackPlatform(current?.info.sourceName, current?.info.uri);
  const theme = getPlatformTheme(platform);

  const currentLine = current
    ? `**[${current.info.title}](${current.info.uri})** \`[${formatDuration(current.info.duration, current.info.isStream)}]\`${
        getRequesterId(current) ? ` • <@${getRequesterId(current)}>` : ""
      }`
    : "Nenhuma música tocando agora.";

  const upcomingSummaries = player.queue.tracks.map((t) => ({
    title: t.info.title,
    uri: t.info.uri,
    author: t.info.author,
    duration: t.info.duration,
    isStream: t.info.isStream,
    requesterId: getRequesterId(t),
  }));

  return new EmbedBuilder()
    .setColor(theme.color)
    .setTitle("Fila de reprodução")
    .addFields(
      {
        name: player.paused ? "Pausado agora" : "Tocando agora",
        value: currentLine,
      },
      {
        name: `Próximas na fila (${player.queue.tracks.length})`,
        value: formatQueueLines(upcomingSummaries, 10),
      },
    );
}

function buildCommandsHelpEmbed(color: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Comandos e Controles — PanchLive")
    .setDescription("Você pode controlar o bot pelos botões abaixo do player ou pelos comandos `/`:")
    .addFields(
      {
        name: "Comandos de Barra (/)",
        value: [
          "• `/play musica:<nome ou link> [plataforma]` — Toca música ou playlist do YouTube ou Spotify",
          "• `/nowplaying` — Mostra a música atual e a barra de progresso",
          "• `/queue` — Mostra a música atual e as próximas da fila",
          "• `/skip` — Pula para a próxima música",
          "• `/pause` — Pausa a reprodução atual",
          "• `/resume` — Retoma a música pausada",
          "• `/stop` — Para a música, limpa a fila e desconecta da call",
        ].join("\n"),
      },
      {
        name: "Botões do Painel",
        value: [
          "• **Pausar / Retomar:** Pausa ou continua a música atual",
          "• **Pular / Parar:** Avança de faixa ou encerra a sessão",
          "• **Loop:** Alterna entre *Off*, *Música* e *Fila*",
          "• **Shuffle:** Embaralha a ordem das músicas na fila",
          "• **Fila:** Exibe a fila atual sem precisar digitar `/queue`",
        ].join("\n"),
      },
    );
}

export async function handleMusicButton(
  interaction: ButtonInteraction,
  lavalink: LavalinkManager,
): Promise<void> {
  if (!interaction.guildId) {
    return;
  }

  const player = lavalink.getPlayer(interaction.guildId);
  const currentPlatform = detectTrackPlatform(
    player?.queue.current?.info.sourceName,
    player?.queue.current?.info.uri,
  );
  const currentTheme = getPlatformTheme(currentPlatform);

  if (interaction.customId === MUSIC_BUTTON_IDS.HELP) {
    await interaction.reply({
      embeds: [buildCommandsHelpEmbed(currentTheme.color)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === MUSIC_BUTTON_IDS.QUEUE) {
    if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
      await interaction.reply({
        content: "A fila está vazia no momento.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      embeds: [buildQueueEmbedForPlayer(player)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const validationError = validateVoiceControl(interaction, player);
  if (validationError || !player) {
    await interaction.reply({
      content: validationError ?? "Não há nada tocando no momento.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentTrack = player.queue.current;

  switch (interaction.customId) {
    case MUSIC_BUTTON_IDS.TOGGLE: {
      if (player.paused) {
        await player.resume();
        startNowPlayingProgressTimer(player, interaction.client);
      } else {
        await player.pause();
        stopNowPlayingProgressTimer(player);
      }

      const embeds = currentTrack ? [buildNowPlayingEmbed(currentTrack, player)] : undefined;
      await interaction.update({
        ...(embeds ? { embeds } : {}),
        components: buildNowPlayingControls(player, false),
      });
      return;
    }

    case MUSIC_BUTTON_IDS.LOOP: {
      const nextMode = getNextRepeatMode(player.repeatMode);
      await player.setRepeatMode(nextMode);

      const embeds = currentTrack ? [buildNowPlayingEmbed(currentTrack, player)] : undefined;
      await interaction.update({
        ...(embeds ? { embeds } : {}),
        components: buildNowPlayingControls(player, false),
      });
      return;
    }

    case MUSIC_BUTTON_IDS.SHUFFLE: {
      if (player.queue.tracks.length >= 2) {
        await player.queue.shuffle();
      }
      const embeds = currentTrack ? [buildNowPlayingEmbed(currentTrack, player)] : undefined;
      await interaction.update({
        ...(embeds ? { embeds } : {}),
        components: buildNowPlayingControls(player, false),
      });
      return;
    }

    case MUSIC_BUTTON_IDS.SKIP: {
      stopNowPlayingProgressTimer(player);
      const skippedTitle = currentTrack?.info.title ?? "a música atual";
      if (player.queue.tracks.length === 0) {
        await player.stopPlaying(true, false);
      } else {
        await player.skip();
      }
      await interaction.reply({
        content: `<@${interaction.user.id}> pulou **${skippedTitle}**.`,
      });
      return;
    }

    case MUSIC_BUTTON_IDS.STOP: {
      stopNowPlayingProgressTimer(player);
      await disablePreviousNowPlayingMessage(player, interaction.client);
      await player.destroy("Parado pelo botão");
      await interaction.reply({
        content: `<@${interaction.user.id}> parou a reprodução e limpou a fila.`,
      });
      return;
    }
  }
}
