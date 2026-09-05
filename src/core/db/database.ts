/**
 * SQLite database layer (spec §11, §18).
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — zero native addons,
 * available in Electron 37 and Node ≥ 22.13. The engine is isolated behind
 * this module so it can be swapped without touching repositories.
 *
 * Reliability: WAL journal, FK enforcement, transactional multi-statement
 * writes, rolling `VACUUM INTO` backups, crash-safe migrations.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, pathExists } from '../util/fsutil';
import { rootLogger } from '../util/logger';

const log = rootLogger.child('db');

/** Minimal statement surface we rely on (decouples from node:sqlite typings). */
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  readonly isOpen: boolean;
}

// node:sqlite is a Node/Electron built-in (Electron 37 embeds Node ≥22.13).
// Resolved via createRequire so bundlers never try to resolve it statically.
// (The anchor path only matters for relative requires; we only load builtins.)
const nodeRequire = createRequire(path.join(process.cwd(), 'ugah-runtime.cjs'));
type DatabaseSyncT = import('node:sqlite').DatabaseSync;

export class SqliteDatabase implements Database {
  private db?: DatabaseSyncT;
  private closed = false;

  constructor(readonly file: string) {}

  open(): void {
    if (this.db) return;
    ensureDirSync(path.dirname(this.file));
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    migrate(this); // idempotent: CREATE TABLE IF NOT EXISTS + version stamps
    log.info('database opened', { file: this.file });
  }

  get isOpen(): boolean { return !!this.db && !this.closed; }

  prepare(sql: string): Statement {
    this.requireOpen();
    return this.db!.prepare(sql) as unknown as Statement;
  }

  exec(sql: string): void {
    this.requireOpen();
    this.db!.exec(sql);
  }

  /** Run fn inside BEGIN/COMMIT; roll back on throw (spec §18). */
  transaction<T>(fn: () => T): T {
    this.requireOpen();
    this.db!.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      this.db!.exec('COMMIT;');
      return out;
    } catch (e) {
      try { this.db!.exec('ROLLBACK;'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  async backup(backupDir: string, keep = 7): Promise<string> {
    this.requireOpen();
    await ensureDir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `UGAH-${stamp}.db`);
    this.db!.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
    // rolling prune
    const files = (await fs.promises.readdir(backupDir)).filter((f) => f.startsWith('UGAH-') && f.endsWith('.db')).sort();
    while (files.length > keep) {
      const victim = files.shift()!;
      await fs.promises.unlink(path.join(backupDir, victim)).catch(() => {});
    }
    log.info('database backup created', { dest });
    return dest;
  }

  close(): void {
    if (this.db && !this.closed) {
      try { this.db.close(); } catch (e) { log.warn('db close error', { error: String(e) }); }
      this.closed = true;
    }
  }

  private requireOpen(): void {
    if (!this.db || this.closed) throw new Error('database is not open');
  }
}

function ensureDirSync(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
}

// ---------------------------------------------------------------- migrations

export const SCHEMA_VERSION = 1;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator TEXT,
  provider_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  download_url TEXT,
  license_id TEXT NOT NULL,
  license_raw TEXT,
  license_url TEXT,
  license_checked_at TEXT NOT NULL,
  attribution_text TEXT,
  downloaded_at TEXT NOT NULL,
  last_used_at TEXT,
  sha256 TEXT,
  md5 TEXT,
  format TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  poly_count INTEGER,
  texture_resolution INTEGER,
  category TEXT NOT NULL DEFAULT 'Other',
  category_override TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  local_path TEXT NOT NULL,
  original_dir TEXT NOT NULL,
  processed_dir TEXT,
  game_ready_dir TEXT,
  preview_path TEXT,
  processing_status TEXT NOT NULL DEFAULT 'original',
  engine_compatibility_json TEXT NOT NULL DEFAULT '{}',
  current_version INTEGER NOT NULL DEFAULT 1,
  favorite INTEGER NOT NULL DEFAULT 0,
  animated INTEGER,
  rigged INTEGER,
  pbr INTEGER,
  geometry_fingerprint TEXT,
  phash TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);
CREATE INDEX IF NOT EXISTS idx_assets_provider ON assets(provider_id);
CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_assets_downloaded ON assets(downloaded_at);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  cover_asset_id TEXT
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, asset_id)
);

CREATE TABLE IF NOT EXISTS download_tasks (
  task_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  option_json TEXT,
  option_id TEXT,
  url TEXT NOT NULL,
  dest_path TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  state TEXT NOT NULL DEFAULT 'queued',
  bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  error TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON download_tasks(state);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  group_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS duplicate_members (
  group_id TEXT NOT NULL REFERENCES duplicate_groups(group_id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  PRIMARY KEY (group_id, asset_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_export_at TEXT
);

CREATE TABLE IF NOT EXISTS export_history (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  engine TEXT NOT NULL,
  export_root TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT
);
`,
  },
];

export function migrate(db: SqliteDatabase): number {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  let current = 0;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    current = row ? Number(row.value) : 0;
  } catch { current = 0; }
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      log.info('applying migration', { version: m.version });
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('schema_version', String(m.version));
      });
    }
  }
  return SCHEMA_VERSION;
}

/** Open + migrate in one step. */
export async function openDatabase(file: string, backupDir?: string): Promise<SqliteDatabase> {
  if (!(await pathExists(file))) log.info('creating new database', { file });
  const db = new SqliteDatabase(file);
  db.open();
  migrate(db);
  if (backupDir) {
    // Daily backup on start (spec §18).
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_backup_at');
    const last = row ? String(row.value) : null;
    const today = new Date().toISOString().slice(0, 10);
    if (!last || last.slice(0, 10) !== today) {
      try {
        await db.backup(backupDir);
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('last_backup_at', new Date().toISOString());
      } catch (e) { log.warn('startup backup failed', { error: String(e) }); }
    }
  }
  return db;
}
