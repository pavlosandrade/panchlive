import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Track } from "lavalink-client";
import { openDatabase } from "../db/database.js";
import { StatsCollector } from "./collector.js";
import {
  finishTrackPlay,
  getActivityStats,
  getDashboardSettings,
  getOverviewStats,
  getRecentPlays,
  getTopTracks,
  getTopUsers,
  insertCommandEvent,
  insertTrackPlay,
  listGuilds,
  updateDashboardSettings,
  upsertDiscordGuild,
  upsertDiscordUser,
} from "./repository.js";

describe("stats/repository", () => {
  it("calcula KPIs, top músicas, top usuários, atividade e respeita filtros de loop, duração mínima e guilda", () => {
    const db = openDatabase(":memory:");
    const now = Date.UTC(2026, 10, 20, 18, 0, 0);
    const hour = 60 * 60 * 1000;

    try {
      upsertDiscordGuild(db, { guildId: "g1", name: "Servidor Principal" });
      upsertDiscordGuild(db, { guildId: "g2", name: "Outro Servidor" });

      upsertDiscordUser(db, { userId: "u1", username: "alice", displayName: "Alice" });
      upsertDiscordUser(db, { userId: "u2", username: "bob", displayName: "Bob" });

      // Música A tocada 2x completas por Alice na g1
      const p1 = insertTrackPlay(db, {
        guildId: "g1",
        trackKey: "youtube:aaa111",
        identifier: "aaa111",
        title: "Música A",
        author: "Artista 1",
        uri: "https://youtube.com/watch?v=aaa111",
        platform: "youtube",
        durationMs: 180_000,
        isStream: false,
        requesterId: "u1",
        isLoop: false,
        startedAt: now - 3 * hour,
      });
      finishTrackPlay(db, {
        playId: p1,
        endedAt: now - 3 * hour + 180_000,
        listenedMs: 180_000,
        endReason: "finished",
      });

      const p2 = insertTrackPlay(db, {
        guildId: "g1",
        trackKey: "youtube:aaa111",
        identifier: "aaa111",
        title: "Música A",
        author: "Artista 1",
        uri: "https://youtube.com/watch?v=aaa111",
        platform: "youtube",
        durationMs: 180_000,
        isStream: false,
        requesterId: "u1",
        isLoop: false,
        startedAt: now - 2 * hour,
      });
      finishTrackPlay(db, {
        playId: p2,
        endedAt: now - 2 * hour + 180_000,
        listenedMs: 180_000,
        endReason: "finished",
      });

      // Repetição em loop da Música A (deve ser ignorada por padrão)
      const pLoop = insertTrackPlay(db, {
        guildId: "g1",
        trackKey: "youtube:aaa111",
        identifier: "aaa111",
        title: "Música A",
        author: "Artista 1",
        platform: "youtube",
        durationMs: 180_000,
        isStream: false,
        requesterId: "u1",
        isLoop: true,
        startedAt: now - 2 * hour + 200_000,
      });
      finishTrackPlay(db, {
        playId: pLoop,
        endedAt: now - 2 * hour + 380_000,
        listenedMs: 180_000,
        endReason: "finished",
      });

      // Skip rápido (5s) da Música B por Bob (abaixo dos 15s mínimos, não entra no ranking)
      const pSkip = insertTrackPlay(db, {
        guildId: "g1",
        trackKey: "spotify:bbb222",
        identifier: "bbb222",
        title: "Música B Skipada",
        author: "Artista 2",
        platform: "spotify",
        durationMs: 210_000,
        isStream: false,
        requesterId: "u2",
        isLoop: false,
        startedAt: now - hour,
      });
      finishTrackPlay(db, {
        playId: pSkip,
        endedAt: now - hour + 5_000,
        listenedMs: 5_000,
        endReason: "replaced",
      });

      // Música C tocada 60s por Bob (acima de 15s, entra no ranking)
      const p3 = insertTrackPlay(db, {
        guildId: "g1",
        trackKey: "spotify:ccc333",
        identifier: "ccc333",
        title: "Música C",
        author: "Artista 3",
        platform: "spotify",
        durationMs: 240_000,
        isStream: false,
        requesterId: "u2",
        isLoop: false,
        startedAt: now - 30 * 60 * 1000,
      });
      finishTrackPlay(db, {
        playId: p3,
        endedAt: now - 29 * 60 * 1000,
        listenedMs: 60_000,
        endReason: "stopped",
      });

      // Música em outra guilda g2 (não deve vazar para g1)
      const pOther = insertTrackPlay(db, {
        guildId: "g2",
        trackKey: "youtube:zzz999",
        identifier: "zzz999",
        title: "Música Outra Guilda",
        platform: "youtube",
        durationMs: 120_000,
        isStream: false,
        requesterId: "u2",
        isLoop: false,
        startedAt: now - 10 * 60 * 1000,
      });
      finishTrackPlay(db, {
        playId: pOther,
        endedAt: now - 8 * 60 * 1000,
        listenedMs: 120_000,
        endReason: "finished",
      });

      // Comandos na g1
      insertCommandEvent(db, {
        guildId: "g1",
        userId: "u1",
        commandName: "play",
        interactionType: "slash",
        createdAt: now - 3 * hour,
      });
      insertCommandEvent(db, {
        guildId: "g1",
        userId: "u2",
        commandName: "play",
        interactionType: "slash",
        createdAt: now - hour,
      });
      insertCommandEvent(db, {
        guildId: "g1",
        userId: "u2",
        commandName: "music:skip",
        interactionType: "button",
        createdAt: now - hour + 5000,
      });

      assert.equal(listGuilds(db).length, 2);

      const overview = getOverviewStats(db, { guildId: "g1", range: "7d" }, now);
      assert.equal(overview.totalPlays, 3); // p1, p2, p3 (sem loop e sem skip rápido)
      assert.equal(overview.totalListenedMs, 420_000); // 180k + 180k + 60k
      assert.equal(overview.uniqueTracks, 2);
      assert.equal(overview.uniqueUsers, 2);
      assert.equal(overview.totalCommands, 3);
      assert.equal(overview.completedPlays, 2);
      assert.equal(overview.skippedPlays, 1);

      const topTracks = getTopTracks(db, { guildId: "g1", range: "7d" }, 10, now);
      assert.equal(topTracks.length, 2);
      assert.equal(topTracks[0].title, "Música A");
      assert.equal(topTracks[0].playCount, 2);
      assert.equal(topTracks[1].title, "Música C");
      assert.equal(topTracks[1].playCount, 1);

      const topUsers = getTopUsers(db, { guildId: "g1", range: "7d" }, 10, now);
      assert.equal(topUsers.length, 2);
      assert.equal(topUsers[0].displayName, "Alice");
      assert.equal(topUsers[0].tracksRequested, 2);
      assert.equal(topUsers[0].commandsUsed, 1);
      assert.equal(topUsers[1].displayName, "Bob");
      assert.equal(topUsers[1].tracksRequested, 1);
      assert.equal(topUsers[1].commandsUsed, 2);

      const activity = getActivityStats(db, { guildId: "g1", range: "7d", tzOffsetMinutes: 0 }, now);
      assert.equal(activity.platforms.youtube.plays, 2);
      assert.equal(activity.platforms.spotify.plays, 1);
      assert.equal(activity.daily.length, 7);
      assert.equal(activity.hourly.length, 24);
      assert.equal(activity.topCommands[0].commandName, "play");
      assert.equal(activity.topCommands[0].count, 2);

      // Histórico recente mostra todas as entradas da guilda (incluindo skip e loop para auditoria)
      const recent = getRecentPlays(db, { guildId: "g1" }, 10);
      assert.equal(recent.length, 5);

      // Alterando configuração para incluir loop e minPlaySeconds = 0
      updateDashboardSettings(db, {
        ignoreLoopInRankings: false,
        minPlaySeconds: 0,
      });
      const updatedSettings = getDashboardSettings(db);
      assert.equal(updatedSettings.ignoreLoopInRankings, false);
      assert.equal(updatedSettings.minPlaySeconds, 0);

      const overviewAll = getOverviewStats(db, { guildId: "g1", range: "7d" }, now);
      assert.equal(overviewAll.totalPlays, 5);
    } finally {
      db.close();
    }
  });
});

describe("stats/collector", () => {
  it("desconta tempo pausado, marca repetição em loop e finaliza faixas abertas no shutdown", () => {
    const db = openDatabase(":memory:");
    const collector = new StatsCollector(db);

    const mockTrack = {
      info: {
        identifier: "abc12345678",
        title: "Faixa Coletor",
        author: "Banda",
        duration: 180_000,
        artworkUrl: null,
        uri: "https://youtube.com/watch?v=abc12345678",
        sourceName: "youtube",
        isSeekable: true,
        isStream: false,
        isrc: null,
      },
      requester: { id: "u10", username: "carol", displayName: "Carol" },
    } as unknown as Track;

    try {
      collector.recordTrackStart("g1", mockTrack, { repeatMode: "track" });
      const firstRow = getRecentPlays(db, { guildId: "g1" }, 5)[0];
      assert.equal(firstRow.isLoop, false);

      // Pausa por 30s após 10s, depois retoma e para após mais 10s -> ~20s ouvidos (sem os 30s pausados)
      const t0 = firstRow.startedAt;
      collector.recordTrackPause("g1", t0 + 10_000);
      collector.recordTrackResume("g1", t0 + 40_000);
      collector.recordTrackEnd("g1", "stopped", t0 + 50_000);

      const afterStop = getRecentPlays(db, { guildId: "g1" }, 5)[0];
      assert.equal(afterStop.endReason, "stopped");
      assert.equal(afterStop.listenedMs, 20_000);

      // Segunda execução imediata da mesma faixa em repeatMode="track" -> isLoop=true
      collector.recordTrackStart("g1", mockTrack, { repeatMode: "track" });
      collector.flushOnShutdown();

      const recent = getRecentPlays(db, { guildId: "g1" }, 5);
      assert.equal(recent.length, 2);
      assert.equal(recent[0].isLoop, true);
      assert.equal(recent[0].endReason, "shutdown");
    } finally {
      db.close();
    }
  });
});
