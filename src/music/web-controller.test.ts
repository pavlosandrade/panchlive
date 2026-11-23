import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import type { LavalinkManager, Player, RepeatMode, Track } from "lavalink-client";
import { createWebPlayerController, PlayerControlError, type ControlActor } from "./web-controller.js";

const adminActor: ControlActor = {
  id: 1,
  username: "pavlos",
  displayName: "Pavlos",
};

function makeTrack(id: string, title: string, overrides?: Partial<Track["info"]>): Track {
  return {
    info: {
      identifier: id,
      title,
      author: "Artista Teste",
      duration: 210_000,
      isStream: false,
      uri: `https://youtube.com/watch?v=${id}`,
      sourceName: "youtube",
      artworkUrl: null,
      ...overrides,
    },
    requester: { id: "111222333444555666", username: "discorduser", displayName: "Discord User" },
  } as unknown as Track;
}

interface MockPlayerState {
  player: Player;
  calls: string[];
  tracks: Track[];
}

function createMockPlayer(guildId: string, initialTracks: Track[] = []): MockPlayerState {
  const calls: string[] = [];
  const tracks = [...initialTracks];
  const dataStore = new Map<string, unknown>();

  const player = {
    guildId,
    voiceChannelId: `voice-${guildId}`,
    textChannelId: `text-${guildId}`,
    playing: true,
    paused: false,
    volume: 100,
    position: 30_000,
    repeatMode: "off" as RepeatMode,
    node: { id: "main-node", connected: true },
    queue: {
      current: makeTrack(`curr-${guildId}`, `Música Atual (${guildId})`),
      tracks,
      async add(item: Track | Track[]) {
        if (Array.isArray(item)) {
          tracks.push(...item);
        } else {
          tracks.push(item);
        }
        calls.push("queue.add");
      },
      async shuffle() {
        calls.push("queue.shuffle");
        tracks.reverse();
        return tracks.length;
      },
      async splice(index: number, count: number) {
        calls.push(`queue.splice:${index}:${count}`);
        return tracks.splice(index, count);
      },
    },
    getData(key: string) {
      return dataStore.get(key);
    },
    setData(key: string, val: unknown) {
      dataStore.set(key, val);
    },
    deleteData(key: string) {
      dataStore.delete(key);
    },
    async pause() {
      this.paused = true;
      calls.push("pause");
      return this;
    },
    async resume() {
      this.paused = false;
      calls.push("resume");
      return this;
    },
    async skip(skipTo?: number) {
      calls.push(`skip:${skipTo ?? 0}`);
      if (typeof skipTo === "number" && skipTo > 1) {
        tracks.splice(0, skipTo - 1);
      }
      this.queue.current = tracks.shift() ?? null;
      return this;
    },
    async stopPlaying(clearQueue?: boolean) {
      calls.push(`stopPlaying:${Boolean(clearQueue)}`);
      if (clearQueue) tracks.length = 0;
      this.queue.current = null;
      this.playing = false;
      return this;
    },
    async destroy(reason?: string) {
      calls.push(`destroy:${reason ?? ""}`);
      this.voiceChannelId = null;
      this.playing = false;
      return this;
    },
    async setRepeatMode(mode: RepeatMode) {
      this.repeatMode = mode;
      calls.push(`repeat:${mode}`);
      return this;
    },
    async setVolume(volume: number) {
      this.volume = volume;
      calls.push(`volume:${volume}`);
      return this;
    },
    async seek(position: number) {
      this.position = position;
      calls.push(`seek:${position}`);
      return this;
    },
    async play() {
      this.playing = true;
      this.paused = false;
      calls.push("play");
      return this;
    },
    async search(opts: { query: string; source?: string }, requester: unknown) {
      calls.push(`search:${opts.source ?? "url"}:${opts.query}`);
      if (opts.query.includes("not-found")) {
        return { loadType: "empty", tracks: [] };
      }
      if (opts.query.includes("playlist")) {
        return {
          loadType: "playlist",
          playlist: { title: "Minha Playlist", uri: "https://youtube.com/playlist?list=123" },
          tracks: [
            { ...makeTrack("pl1", "Faixa PL 1"), requester },
            { ...makeTrack("pl2", "Faixa PL 2"), requester },
          ],
        };
      }
      return {
        loadType: "search",
        tracks: [{ ...makeTrack("new1", "Nova Música"), requester }],
      };
    },
  } as unknown as Player;

  return { player, calls, tracks };
}

function createMockEnv(playersByGuild: Map<string, MockPlayerState>) {
  const sentNotices: Array<{ channelId: string; payload: unknown }> = [];
  const client = {
    channels: {
      async fetch(channelId: string) {
        return {
          isTextBased: () => true,
          async send(payload: unknown) {
            sentNotices.push({ channelId, payload });
            return { id: "msg-1" };
          },
          messages: {
            async fetch() {
              return { async edit() {} };
            },
          },
        };
      },
    },
  } as unknown as Client;

  const lavalink = {
    useable: true,
    nodeManager: {
      nodes: {
        filter: () => ({ values: () => [] }),
      },
    },
    getPlayer(guildId: string) {
      return playersByGuild.get(guildId)?.player;
    },
  } as unknown as LavalinkManager;

  const controller = createWebPlayerController({ lavalink, client });
  return { controller, sentNotices };
}

describe("music/web-controller", () => {
  it("isola estritamente controles por servidor quando há múltiplos servidores tocando", async () => {
    const guildA = createMockPlayer("guild-A", [makeTrack("a1", "Fila A1"), makeTrack("a2", "Fila A2")]);
    const guildB = createMockPlayer("guild-B", [makeTrack("b1", "Fila B1"), makeTrack("b2", "Fila B2")]);
    const { controller, sentNotices } = createMockEnv(
      new Map([
        ["guild-A", guildA],
        ["guild-B", guildB],
      ]),
    );

    await controller.togglePause("guild-A", adminActor);
    assert.equal(guildA.player.paused, true);
    assert.equal(guildB.player.paused, false);
    assert.equal(guildB.calls.length, 0);
    // Toggle pause é silencioso no chat (apenas atualiza embed)
    assert.equal(sentNotices.length, 0);

    await controller.skip("guild-A", adminActor);
    assert.deepEqual(guildA.calls, ["pause", "skip:0"]);
    assert.equal(guildB.calls.length, 0);
    // Skip envia aviso apenas no canal de texto da guild-A
    assert.equal(sentNotices.length, 1);
    assert.equal(sentNotices[0].channelId, "text-guild-A");
    assert.match(String(sentNotices[0].payload), /Pavlos.*via Dashboard.*pulou/);

    await controller.stop("guild-A", adminActor);
    assert.equal(guildB.player.playing, true);
    assert.equal(guildB.calls.length, 0);
    assert.equal(sentNotices.length, 2);
    assert.equal(sentNotices[1].channelId, "text-guild-A");
  });

  it("executa loop, shuffle, volume, seek, jump (1-based) e remove/clear com validações", async () => {
    const guildA = createMockPlayer("guild-A", [
      makeTrack("t1", "Faixa 1"),
      makeTrack("t2", "Faixa 2"),
      makeTrack("t3", "Faixa 3"),
    ]);
    const { controller, sentNotices } = createMockEnv(new Map([["guild-A", guildA]]));

    await controller.setLoop("guild-A", adminActor);
    assert.equal(guildA.player.repeatMode, "track");
    await controller.setLoop("guild-A", adminActor, "queue");
    assert.equal(guildA.player.repeatMode, "queue");

    await controller.shuffle("guild-A", adminActor);
    assert.ok(guildA.calls.includes("queue.shuffle"));

    await controller.setVolume("guild-A", adminActor, 150);
    assert.equal(guildA.player.volume, 100);

    await controller.seek("guild-A", adminActor, 90_000);
    assert.equal(guildA.player.position, 90_000);

    // Ações não disruptivas não enviam aviso no chat
    assert.equal(sentNotices.length, 0);

    // Jump para índice 1 -> skip(2) (1-based)
    await controller.jumpToQueueIndex("guild-A", adminActor, 1);
    assert.ok(guildA.calls.includes("skip:2"));
    assert.equal(sentNotices.length, 1);

    await controller.removeQueueIndex("guild-A", adminActor, 0);
    assert.ok(guildA.calls.includes("queue.splice:0:1"));

    await controller.clearQueue("guild-A", adminActor);
    assert.equal(guildA.tracks.length, 0);

    await assert.rejects(
      () => controller.shuffle("guild-A", adminActor),
      (err: unknown) => err instanceof PlayerControlError && err.statusCode === 409,
    );
  });

  it("bloqueia seek em live stream e rejeita servidor sem player ativo", async () => {
    const guildLive = createMockPlayer("guild-live");
    guildLive.player.queue.current = makeTrack("live1", "Rádio 24h", { isStream: true, duration: 0 });
    const { controller } = createMockEnv(new Map([["guild-live", guildLive]]));

    await assert.rejects(
      () => controller.seek("guild-live", adminActor, 10_000),
      (err: unknown) => err instanceof PlayerControlError && err.statusCode === 409,
    );

    await assert.rejects(
      () => controller.togglePause("guild-inexistente", adminActor),
      (err: unknown) => err instanceof PlayerControlError && err.statusCode === 404,
    );
  });

  it("adiciona faixa única e playlist pela dashboard com embed de aviso no Discord", async () => {
    const guildA = createMockPlayer("guild-A");
    const { controller, sentNotices } = createMockEnv(new Map([["guild-A", guildA]]));

    const single = await controller.enqueue("guild-A", adminActor, "daft punk", "youtube");
    assert.match(single.message, /Nova Música/);
    assert.equal(guildA.tracks.length, 1);
    assert.equal(sentNotices.length, 1);

    const playlist = await controller.enqueue("guild-A", adminActor, "minha playlist", "spotify");
    assert.match(playlist.message, /Minha Playlist.*2 faixas/);
    assert.equal(guildA.tracks.length, 3);
    assert.equal(sentNotices.length, 2);

    await assert.rejects(
      () => controller.enqueue("guild-A", adminActor, "not-found", "youtube"),
      (err: unknown) => err instanceof PlayerControlError && err.statusCode === 404,
    );
  });
});
