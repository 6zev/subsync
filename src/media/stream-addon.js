/**
 * Borrow the media source from a stream addon.
 *
 * Stremio tells a subtitle addon only `videoHash`, `videoSize` and `filename` — never the stream
 * URL it ended up playing. So a debrid addon that resolves the link for the *player* does not
 * hand that link to us.
 *
 * But a stream addon's `/stream/…` endpoint is public to us: when it is configured with debrid,
 * its entries carry a directly playable `url`. Asking it the same question Stremio asked lets the
 * audio stage reach the file without the user configuring a second debrid key here.
 *
 * When it answers with `infoHash` + `fileIdx` instead (no debrid on that addon), the caller can
 * still fall back to our own debrid resolver.
 *
 * Owned by LEAD.
 */
import { httpJson, withTimeout } from '../util/http.js';
import { releaseSimilarity } from '../util/text.js';
import { createLogger } from '../util/log.js';

const streamLog = createLogger('media');

const STREAM_LIST_TTL_MS = 3 * 60 * 1000;
const STREAM_LIST_MAX_KEYS = 200;
const streamListCache = new Map();

/** Only the host is ever logged — debrid links carry credentials in the path. */
export function safeHost(url) {
  try { return new URL(url).host; } catch { return 'invalid-url'; }
}

/** Addon base URL from its manifest URL: strip `manifest.json` and keep a trailing slash. */
export function addonBase(manifestUrl) {
  return String(manifestUrl || '').replace(/manifest\.json.*$/i, '').replace(/\/?$/, '/');
}

/**
 * @param {{manifestUrl:string, type:'movie'|'series', id:string, filename?:string, timeoutMs?:number, log?:Function}} req
 * @returns {Promise<{kind:'url'|'infohash'|'none', url?:string, infoHash?:string, fileIdx?:number,
 *          title?:string, reason:string, addon:string}>}
 */
export async function resolveFromStreamAddon({
  manifestUrl, type, id, filename, timeoutMs = 8000, log = streamLog,
}) {
  const base = addonBase(manifestUrl);
  if (!base) return { kind: 'none', reason: 'no stream addon configured', addon: '' };
  const addon = safeHost(base);

  let payload;
  try {
    payload = await withTimeout(
      httpJson(`${base}stream/${type}/${encodeURIComponent(id)}.json`, { timeoutMs }),
      timeoutMs,
      `stream addon ${addon}`,
    );
  } catch (err) {
    log('warn', `stream addon ${addon} failed: ${err.message}`);
    return { kind: 'none', reason: `stream addon unreachable: ${err.message}`, addon };
  }

  const streams = Array.isArray(payload?.streams) ? payload.streams.slice(0, 300) : [];
  if (!streams.length) return { kind: 'none', reason: 'the stream addon returned nothing', addon };

  const playable = streams.filter((stream) => typeof stream?.url === 'string' && /^https?:/i.test(stream.url));
  if (playable.length) {
    const best = pickBest(playable, filename);
    // The release name the addon reports is the ground truth for "what is actually playing",
    // which is worth more than what Stremio hands us.
    const release = candidateLabels(best)[0] || null;
    log('info', `media source from stream addon ${addon}: ${safeHost(best.url)} (${release || 'unnamed'})`);
    return {
      kind: 'url',
      url: best.url,
      title: release,
      release,
      matchScore: Number.isFinite(best.__matchScore) ? Number(best.__matchScore.toFixed(3)) : null,
      reason: `resolved by stream addon ${addon}`,
      addon,
    };
  }

  // No direct link: the addon is not debrid-configured, but it can still tell us which release
  // is being played, which lets our own debrid resolver (if any) fetch exactly that file.
  const hashed = streams.filter((stream) => /^[0-9a-f]{40}$/i.test(String(stream?.infoHash || '')));
  if (hashed.length) {
    const best = pickBest(hashed, filename);
    log('info', `stream addon ${addon} gave no direct link; using its infohash ${String(best.infoHash).slice(0, 10)}…`);
    return {
      kind: 'infohash',
      infoHash: String(best.infoHash).toLowerCase(),
      fileIdx: Number.isInteger(best.fileIdx) ? best.fileIdx : 0,
      title: best.title,
      reason: `infohash from stream addon ${addon}`,
      addon,
    };
  }

  return { kind: 'none', reason: 'the stream addon exposed no playable link or hash', addon };
}

/**
 * Everything a stream addon answers for one video, normalised for Stremio's `stream` resource.
 * @param {{manifestUrl:string, type:'movie'|'series', id:string, timeoutMs?:number, log?:Function, limit?:number}} req
 * @returns {Promise<{streams:object[], addon:string, reason:string}>}
 */
export async function fetchStreamAddonStreams({
  manifestUrl, type, id, timeoutMs = 8000, log = streamLog, limit = 300,
}) {
  const base = addonBase(manifestUrl);
  if (!base) return { streams: [], addon: '', reason: 'no stream addon configured' };
  const addon = safeHost(base);

  let payload;
  try {
    payload = await withTimeout(
      httpJson(`${base}stream/${type}/${encodeURIComponent(id)}.json`, { timeoutMs }),
      timeoutMs,
      `stream addon ${addon}`,
    );
  } catch (err) {
    log('warn', `stream addon ${addon} failed: ${err.message}`);
    return { streams: [], addon, reason: `stream addon unreachable: ${err.message}` };
  }

  const raw = Array.isArray(payload?.streams) ? payload.streams.slice(0, limit) : [];
  const streams = raw.map((stream) => normaliseStream(stream)).filter(Boolean);
  return {
    streams,
    addon,
    reason: streams.length ? `listed by stream addon ${addon}` : 'the stream addon returned nothing playable',
  };
}

/**
 * Merge the playable entries of every configured stream addon, de-duplicated, for our own
 * `/stream` resource. Short-lived cache: Stremio asks again on every episode open.
 *
 * The entries are the user's own stream addon's answers — the same links that addon already
 * hands to Stremio — so nothing new is exposed by relaying them.
 *
 * @param {{manifestUrls:string[], type:'movie'|'series', id:string, timeoutMs?:number, limit?:number, log?:Function, cache?:boolean}} req
 * @returns {Promise<object[]>}
 */
export async function listStreamsFromAddons({
  manifestUrls = [], type, id, timeoutMs = 8000, limit = 80, log = streamLog, cache = true,
} = {}) {
  const urls = [...new Set((manifestUrls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (!urls.length || !type || !id) return [];

  const cacheKey = `${type}:${id}:${urls.join('\n')}`;
  if (cache) {
    const hit = streamListCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.streams;
  }

  const results = await Promise.all(urls.map((manifestUrl) => fetchStreamAddonStreams({
    manifestUrl, type, id, timeoutMs, log, limit,
  })));

  const seen = new Set();
  const streams = [];
  for (const result of results) {
    for (const stream of result.streams) {
      const key = stream.url ? `u:${stream.url}` : `h:${stream.infoHash}:${stream.fileIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      streams.push(stream);
      if (streams.length >= limit) break;
    }
    if (streams.length >= limit) break;
  }

  if (cache) {
    streamListCache.set(cacheKey, { streams, expiresAt: Date.now() + STREAM_LIST_TTL_MS });
    while (streamListCache.size > STREAM_LIST_MAX_KEYS) {
      streamListCache.delete(streamListCache.keys().next().value);
    }
  }
  log('debug', `stream list ${type}/${id}: ${streams.length} entry(ies) from ${urls.length} addon(s)`);
  return streams;
}

/** Keep only what Stremio can play, and only the fields it understands. */
function normaliseStream(stream) {
  if (!stream || typeof stream !== 'object') return null;
  const url = typeof stream.url === 'string' && /^https?:\/\//i.test(stream.url) ? stream.url : null;
  const infoHash = /^[0-9a-f]{40}$/i.test(String(stream.infoHash || '')) ? String(stream.infoHash).toLowerCase() : null;
  if (!url && !infoHash) return null;

  const out = {};
  if (url) out.url = url;
  if (infoHash) {
    out.infoHash = infoHash;
    out.fileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : 0;
  }
  out.name = typeof stream.name === 'string' && stream.name.trim() ? stream.name : 'Nuvio Sync';
  if (typeof stream.title === 'string' && stream.title.trim()) out.title = stream.title;
  if (stream.behaviorHints && typeof stream.behaviorHints === 'object') out.behaviorHints = stream.behaviorHints;
  return out;
}

/** Test hook: forget cached listings so a stub can change its answer between cases. */
export function clearStreamListCache() {
  streamListCache.clear();
}

/**
 * Pull usable release/file names out of a stream entry.
 *
 * Addons decorate `title` heavily. Debrid Media Manager, for example, returns multi-line titles
 * like:
 *   "Joker.Folie.a.Deux.2024.2160p.U-HDRemux.HDR.DV-TheEqualizer.mkv\nDD 5.1 • \ud83c\uddf7\ud83c\uddfa\ud83c\uddec\ud83c\udde7\n\ud83c\udfac DMM Cast TB"
 * The first line is the real file name; the rest is decoration. Returning every plausible line as
 * a candidate and scoring the best of them is what makes the right file win.
 *
 * @param {any} stream
 * @returns {string[]}
 */
export function candidateLabels(stream) {
  const out = [];
  const push = (value) => {
    const text = cleanLabel(value);
    if (text && text.length >= 3 && !out.includes(text)) out.push(text);
  };
  const title = String(stream?.title || '');
  // Line by line: the first line usually carries the file name, later ones the specs.
  for (const line of title.split(/\r?\n/)) push(line);
  push(stream?.behaviorHints?.filename);
  push(stream?.name);
  return out;
}

/** Strip emoji, flags, bullet separators and stray markup from a stream label. */
export function cleanLabel(value) {
  return String(value ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .split(/\s[•·|]\s/)[0]
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s.\-_]+$/, '')
    .trim();
}

/** Best release match by name; a lone candidate wins by default. */
function pickBest(streams, filename) {
  if (streams.length === 1 || !filename) return streams[0];
  let best = streams[0];
  let bestScore = -1;
  for (const stream of streams) {
    const labels = candidateLabels(stream);
    const score = labels.length
      ? Math.max(...labels.map((label) => releaseSimilarity(filename, label)))
      : 0;
    stream.__matchScore = score;
    if (score > bestScore) {
      best = stream;
      bestScore = score;
    }
  }
  return best;
}

export const __internal = { pickBest, candidateLabels, cleanLabel };
