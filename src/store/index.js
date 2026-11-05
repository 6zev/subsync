/**
 * Domain store: per-video/per-track sync offsets (the Nuvio `persistTrackPreference()` port),
 * the synced-subtitle cache, the track registry and the event log.
 * Contract: src/contracts.js §4. Owned by LEAD.
 */
import { createHash } from 'node:crypto';
import * as db from './db.js';
import { getConfig } from '../env.js';
import { createLogger } from '../util/log.js';

const storeLog = createLogger('store');

/* ── video key ─────────────────────────────────────────────────────────── */

/**
 * Stable identity for "the exact file the user is playing".
 * Prefers Stremio's OpenSubtitles-style `videoHash` (exact file), falls back to
 * type+id+filename so at least the episode is stable.
 * @param {{type?:string,id?:string,videoHash?:string,videoSize?:number,filename?:string}} input
 * @returns {string}
 */
export function videoKeyOf({ type, id, videoHash, videoSize, filename } = {}) {
  if (videoHash && /^[0-9a-f]{16}$/i.test(String(videoHash).trim())) {
    return `h:${String(videoHash).toLowerCase()}:${Number(videoSize) || 0}`;
  }
  const shaLite = createHash('sha1')
    .update(`${type || ''}|${id || ''}|${filename || ''}`)
    .digest('hex')
    .slice(0, 16);
  return `i:${type || 'x'}:${id || 'x'}:${shaLite}`;
}

/* ── offsets ───────────────────────────────────────────────────────────── */

const OFFSET_SELECT =
  'SELECT video_key, track_id, offset_ms, rate, method, confidence, source, detail, updated_at FROM offsets';

function mapOffset(row) {
  if (!row) return null;
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { detail = null; }
  return {
    videoKey: row.video_key,
    trackId: row.track_id,
    offsetMs: Number(row.offset_ms) || 0,
    rate: Number.isFinite(row.rate) && Number(row.rate) > 0 ? Number(row.rate) : 1,
    method: row.method || 'manual',
    confidence: Number(row.confidence) || 0,
    source: row.source || 'manual',
    detail,
    updatedAt: Number(row.updated_at) || 0,
  };
}

/** @param {string} videoKey @param {string} trackId */
export function getOffset(videoKey, trackId) {
  if (!videoKey || !trackId) return null;
  return mapOffset(db.get(`${OFFSET_SELECT} WHERE video_key = ? AND track_id = ?`, videoKey, trackId));
}

/** Offset that applies to *any* track of this video (trackId = '*'), used as a fallback. */
export function getVideoOffset(videoKey) {
  return getOffset(videoKey, '*');
}

/**
 * @param {string} videoKey
 * @param {string} trackId
 * @param {{offsetMs:number,rate?:number,method?:string,confidence?:number,source?:string,detail?:object}} value
 */
export function putOffset(videoKey, trackId, value) {
  if (!videoKey || !trackId) return false;
  const offsetMs = Math.round(Number(value?.offsetMs) || 0);
  const rate = Number.isFinite(value?.rate) && Number(value.rate) > 0 ? Number(value.rate) : 1;
  const ok = db.run(
    `INSERT INTO offsets (video_key, track_id, offset_ms, rate, method, confidence, source, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_key, track_id) DO UPDATE SET
       offset_ms = excluded.offset_ms,
       rate = excluded.rate,
       method = excluded.method,
       confidence = excluded.confidence,
       source = excluded.source,
       detail = excluded.detail,
       updated_at = excluded.updated_at`,
    videoKey,
    trackId,
    offsetMs,
    rate,
    value?.method || 'manual',
    Number(value?.confidence) || 0,
    value?.source || 'manual',
    value?.detail ? JSON.stringify(value.detail).slice(0, 4000) : null,
    Date.now(),
  );
  if (ok) storeLog.debug(`offset saved ${videoKey}/${trackId} ${offsetMs}ms rate=${rate} (${value?.method || 'manual'})`);
  return ok;
}

/** @param {string} videoKey */
export function listOffsets(videoKey) {
  return db.all(`${OFFSET_SELECT} WHERE video_key = ? ORDER BY updated_at DESC`, videoKey).map(mapOffset);
}

export function listRecentOffsets(limit = 50) {
  return db.all(`${OFFSET_SELECT} ORDER BY updated_at DESC LIMIT ?`, Math.max(1, Math.min(500, limit))).map(mapOffset);
}

export function deleteOffset(videoKey, trackId) {
  return db.run('DELETE FROM offsets WHERE video_key = ? AND track_id = ?', videoKey, trackId);
}

/* ── subtitle cache ────────────────────────────────────────────────────── */

export function cacheKeyOf(parts) {
  return createHash('sha1').update(parts.filter((p) => p !== undefined && p !== null).join('|')).digest('hex');
}

export function getCachedSub(key) {
  const row = db.get('SELECT * FROM subs WHERE cache_key = ?', key);
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    db.run('DELETE FROM subs WHERE cache_key = ?', key);
    return null;
  }
  return { body: row.body, format: row.format, contentType: row.content_type, createdAt: Number(row.created_at) };
}

export function putCachedSub(key, { body, format, contentType, ttlMs } = {}) {
  const ttl = Number(ttlMs) || getConfig().CACHE_TTL_MS;
  const now = Date.now();
  return db.run(
    `INSERT INTO subs (cache_key, body, format, content_type, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       body = excluded.body, format = excluded.format,
       content_type = excluded.content_type,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
    key,
    String(body ?? ''),
    format || 'srt',
    contentType || 'text/plain; charset=utf-8',
    now,
    now + ttl,
  );
}

export function deleteCachedSub(key) {
  return db.run('DELETE FROM subs WHERE cache_key = ?', key);
}

export function invalidateSubCache(videoKey, trackId) {
  return db.run("DELETE FROM subs WHERE cache_key LIKE ?", `%${trackId}%`) || true;
}

/* ── track registry ────────────────────────────────────────────────────── */

/**
 * Remember a resolved provider track so /s/<token> can download it later and so the
 * sync engine can use sibling tracks for the same video as reference text.
 * @param {import('../contracts.js').SubtitleTrack} track
 */
export function putTrack(track, videoKey, kind = 'primary') {
  if (!track?.id || !track?.url) return false;
  return db.run(
    `INSERT INTO tracks (id, video_key, provider, lang, lang_name, url, headers, format, release_name, filename, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       video_key = excluded.video_key, url = excluded.url, headers = excluded.headers,
       format = excluded.format, release_name = excluded.release_name,
       filename = excluded.filename, kind = excluded.kind, payload = excluded.payload,
       created_at = excluded.created_at`,
    track.id,
    videoKey,
    track.provider || null,
    track.lang || null,
    track.langName || null,
    track.url,
    track.headers ? JSON.stringify(track.headers) : null,
    track.format || null,
    track.releaseName || null,
    track.filename || null,
    kind,
    JSON.stringify({
      score: track.score, downloads: track.downloads, hash: track.hash,
      hearingImpaired: track.hearingImpaired, machineTranslated: track.machineTranslated,
      season: track.season, episode: track.episode, source: track.source,
    }).slice(0, 4000),
    Date.now(),
  );
}

function mapTrackRow(row) {
  if (!row) return null;
  let headers = null;
  let payload = null;
  try { headers = row.headers ? JSON.parse(row.headers) : null; } catch { headers = null; }
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  return {
    id: row.id,
    provider: row.provider,
    lang: row.lang,
    langName: row.lang_name,
    url: row.url,
    headers,
    format: row.format,
    releaseName: row.release_name,
    filename: row.filename,
    source: payload?.source || 'api',
    videoKey: row.video_key,
    kind: row.kind,
    createdAt: Number(row.created_at),
    ...(payload || {}),
  };
}

export function getTrack(id) {
  return mapTrackRow(db.get('SELECT * FROM tracks WHERE id = ?', id));
}

/** @param {string} videoKey */
export function listTracks(videoKey, { kind, limit = 60 } = {}) {
  const rows = kind
    ? db.all('SELECT * FROM tracks WHERE video_key = ? AND kind = ? ORDER BY created_at DESC LIMIT ?', videoKey, kind, limit)
    : db.all('SELECT * FROM tracks WHERE video_key = ? ORDER BY created_at DESC LIMIT ?', videoKey, limit);
  return rows.map(mapTrackRow);
}

export function prunTracksOlderThan(ms) {
  return db.run('DELETE FROM tracks WHERE created_at < ?', Date.now() - ms);
}

/* ── kv + events ───────────────────────────────────────────────────────── */

export function kvGet(key, fallback = null) {
  const row = db.get('SELECT v FROM kv WHERE k = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return fallback; }
}

export function kvSet(key, value) {
  return db.run(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), Date.now(),
  );
}

export function logEvent(event) {
  return db.run(
    `INSERT INTO events (ts, kind, video_key, track_id, method, offset_ms, rate, confidence, duration_ms, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    event.kind || 'sync',
    event.videoKey || null,
    event.trackId || null,
    event.method || null,
    Number.isFinite(event.offsetMs) ? Math.round(event.offsetMs) : null,
    Number.isFinite(event.rate) ? event.rate : null,
    Number.isFinite(event.confidence) ? event.confidence : null,
    Number.isFinite(event.durationMs) ? Math.round(event.durationMs) : null,
    event.detail ? JSON.stringify(event.detail).slice(0, 4000) : null,
  );
}

export function recentEvents(limit = 50) {
  return db.all('SELECT * FROM events ORDER BY ts DESC LIMIT ?', Math.max(1, Math.min(500, limit)));
}

export function stats() {
  const one = (sql, ...p) => Number(Object.values(db.get(sql, ...p) ?? { n: 0 })[0]) || 0;
  return {
    offsets: one('SELECT COUNT(*) AS n FROM offsets'),
    cachedSubs: one('SELECT COUNT(*) AS n FROM subs'),
    tracks: one('SELECT COUNT(*) AS n FROM tracks'),
    events: one('SELECT COUNT(*) AS n FROM events'),
    last24h: one('SELECT COUNT(*) AS n FROM events WHERE ts > ?', Date.now() - 86400000),
  };
}

export { prune } from './db.js';
export { closeDb } from './db.js';
