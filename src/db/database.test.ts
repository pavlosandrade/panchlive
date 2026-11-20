import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_APP_SETTINGS, openDatabase } from "./database.js";

describe("database", () => {
  it("aplica migrations de forma idempotente e semeia configurações padrão", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panchlive-db-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    try {
      const db1 = openDatabase(dbPath);
      const migrations1 = db1.prepare("SELECT version, name FROM schema_migrations").all();
      assert.equal(migrations1.length, 1);

      const settingsRows = db1.prepare("SELECT key, value FROM app_settings").all() as Array<{
        key: string;
        value: string;
      }>;
      const settingsMap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
      assert.equal(settingsMap.dashboard_title, DEFAULT_APP_SETTINGS.dashboard_title);
      assert.equal(settingsMap.min_play_seconds, DEFAULT_APP_SETTINGS.min_play_seconds);
      assert.equal(settingsMap.ignore_loop_in_rankings, DEFAULT_APP_SETTINGS.ignore_loop_in_rankings);
      db1.close();

      // Reabrir o mesmo arquivo não deve reaplicar migrations nem sobrescrever settings
      const db2 = openDatabase(dbPath);
      db2
        .prepare("UPDATE app_settings SET value = ? WHERE key = 'dashboard_title'")
        .run("Meu Painel");
      db2.close();

      const db3 = openDatabase(dbPath);
      const titleRow = db3
        .prepare("SELECT value FROM app_settings WHERE key = 'dashboard_title'")
        .get() as { value: string };
      assert.equal(titleRow.value, "Meu Painel");
      db3.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
