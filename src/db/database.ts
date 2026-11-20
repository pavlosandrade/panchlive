import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_APP_SETTINGS: Record<string, string> = {
  dashboard_title: "PanchLive Dashboard",
  min_play_seconds: "15",
  ignore_loop_in_rankings: "true",
  session_ttl_days: "7",
};

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_by INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_agent TEXT NULL,
        ip_address TEXT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS invite_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        code_prefix TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        note TEXT NULL,
        created_by INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
        used_by INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
        used_at TEXT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invites_expires ON invite_codes(expires_at);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discord_guilds (
        guild_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon_url TEXT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discord_users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS track_plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        track_key TEXT NOT NULL,
        identifier TEXT NOT NULL,
        isrc TEXT NULL,
        title TEXT NOT NULL,
        author TEXT NULL,
        uri TEXT NULL,
        artwork_url TEXT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('youtube', 'spotify')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        is_stream INTEGER NOT NULL DEFAULT 0 CHECK (is_stream IN (0, 1)),
        requester_id TEXT NULL,
        is_loop INTEGER NOT NULL DEFAULT 0 CHECK (is_loop IN (0, 1)),
        started_at INTEGER NOT NULL,
        ended_at INTEGER NULL,
        listened_ms INTEGER NULL,
        end_reason TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_track_plays_guild_started ON track_plays(guild_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_track_plays_key_started ON track_plays(track_key, started_at);
      CREATE INDEX IF NOT EXISTS idx_track_plays_requester_started ON track_plays(requester_id, started_at);

      CREATE TABLE IF NOT EXISTS command_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        command_name TEXT NOT NULL,
        interaction_type TEXT NOT NULL CHECK (interaction_type IN ('slash', 'button')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_command_events_guild_created ON command_events(guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_command_events_user_created ON command_events(user_id, created_at);
    `,
  },
];

export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignora erro de rollback se a transação já foi revertida pelo SQLite.
    }
    throw err;
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");

  applyMigrations(db);
  seedDefaultSettings(db);

  return db;
}

export function openAppDatabase(dataDir: string): DatabaseSync {
  const dbPath = path.join(dataDir, "panchlive.sqlite");
  return openDatabase(dbPath);
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    runInTransaction(db, () => {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    });
  }
}

function seedDefaultSettings(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
  );
  for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
    stmt.run(key, value, now);
  }
}
