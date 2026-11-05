/**
 * SQLite storage (node:sqlite, zero dependencies).
 *
 * An I/O error must never take the addon down: every call degrades to an in-memory
 * fallback with a warning. Owned by LEAD. Contract: src/contracts.js §4.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../env.js';
import { createLogger } from '../util/log.js';

const dbLog = createLogger('store');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS offsets (
  video_key  TEXT NOT NULL,
  track_id   TEXT NOT NULL,
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  rate       REAL NOT NULL DEFAULT 1,
  method     TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  source     TEXT,
  detail     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (video_key, track_id)
);

CREATE TABLE IF NOT EXISTS subs (
  cache_key    TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  format       TEXT,
  content_type TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  video_key    TEXT NOT NULL,
  provider     TEXT,
  lang         TEXT,
  lang_name    TEXT,
  url          TEXT NOT NULL,
  headers      TEXT,
  format       TEXT,
  release_name TEXT,
  filename     TEXT,
  kind         TEXT,
  payload      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_video ON tracks (video_key, created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  kind       TEXT,
  video_key  TEXT,
  track_id   TEXT,
  method     TEXT,
  offset_ms  INTEGER,
  rate       REAL,
  confidence REAL,
  duration_ms INTEGER,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
`;

let db = null;
let dbError = null;

/** @returns {DatabaseSync|null} */
export function getDb() {
  if (db) return db;
  if (dbError) return null;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, 'nuvio-sync.sqlite');
    if (!existsSync(file)) dbLog.info(`creating database at ${file}`);
    db = new DatabaseSync(file);
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    dbError = err;
    dbLog.error(`sqlite unavailable, continuing without persistence: ${err.message}`);
    return null;
  }
}

/** Run a statement, swallowing errors. @returns {any[]} */
export function all(sql, ...params) {
  const handle = getDb();
  if (!handle) return [];
  try {
    return handle.prepare(sql).all(...params);
  } catch (err) {
    dbLog.warn(`query failed: ${err.message} :: ${sql}`);
    return [];
  }
}

/** @returns {object|null} */
export function get(sql, ...params) {
  return all(sql, ...params)[0] ?? null;
}

/** @returns {boolean} */
export function run(sql, ...params) {
  const handle = getDb();
  if (!handle) return false;
  try {
    handle.prepare(sql).run(...params);
    return true;
  } catch (err) {
    dbLog.warn(`exec failed: ${err.message} :: ${sql}`);
    return false;
  }
}

/** Escape a value for `LIKE`. */
export function likeValue(value) {
  return `%${String(value).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

/** Delete expired rows; call periodically. */
export function prune() {
  const now = Date.now();
  run('DELETE FROM subs WHERE expires_at < ?', now);
  run('DELETE FROM tracks WHERE created_at < ?', now - 30 * 24 * 3600 * 1000);
  run('DELETE FROM events WHERE ts < ?', now - 90 * 24 * 3600 * 1000);
}

export function closeDb() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}
