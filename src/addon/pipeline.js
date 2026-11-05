/**
 * The addon pipeline: Stremio request -> providers -> ranked subtitle list -> (on fetch)
 * download, sync and serve an already-corrected subtitle file.
 *
 * Why syncing happens on fetch and not on listing: Stremio asks for the list while the user is
 * still browsing, but it only downloads a subtitle once the user has picked it and playback has
 * started. That is the only moment where ~9 seconds of latency is invisible.
 *
 * Owned by LEAD.
 */
import { getConfig } from '../env.js';
import { signToken, verifyToken, applyTokenPayload, configToTokenPayload } from './tokens.js';
import { searchAll, resolveTrackUrl, getProvider, scoreTrack } from '../providers/index.js';
import * as store from '../store/index.js';
import { resolveMedia, attachMedia, probeDuration } from '../media/index.js';
import {
  parseSubtitles, serializeSubtitles, syncSubtitle, applySyncResult, normalizeOffset,
} from '../sync/index.js';
import { stripSubtitleMarkup } from '../util/text.js';
import { unwrapSubtitlePayload } from '../util/zip.js';
import { fetchResponse, withTimeout, detach } from '../util/http.js';
import { toLang2, toLang3, LANG_NAMES } from '../contracts.js';
import { createLogger } from '../util/log.js';

const pipelineLog = createLogger('pipeline');

/* ── helpers ───────────────────────────────────────────────────────────── */

/**
 * Parse a Stremio content id.
 * `tt1234567` (movie) or `tt1234567:2:5` (series season 2 episode 5).
 * @param {string} type
 * @param {string} id
 */
export function parseStremioId(type, id) {
  const raw = String(id || '');
  const parts = raw.split(':');
  const imdbId = /^tt\d+/.test(parts[0]) ? parts[0] : null;
  const season = parts.length > 1 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  const episode = parts.length > 2 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
  return {
    raw,
    imdbId,
    tmdbId: null,
    type: type === 'series' ? 'series' : 'movie',
    season: type === 'series' ? season : null,
    episode: type === 'series' ? episode : null,
  };
}

/** Stremio sends the extra segment URL-encoded: `videoHash=..&videoSize=..&filename=..`. */
export function parseExtra(extraSegment, query = {}) {
  const out = { ...query };
  if (extraSegment) {
    const decoded = decodeURIComponent(String(extraSegment));
    for (const pair of decoded.split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq);
      const value = decodeURIComponent(pair.slice(eq + 1));
      out[key] = value;
    }
  }
  return {
    videoHash: out.videoHash || null,
    videoSize: out.videoSize ? Number(out.videoSize) : null,
    filename: out.filename || null,
    videoID: out.videoID || null,
    season: out.season != null ? Number(out.season) : null,
    episode: out.episode != null ? Number(out.episode) : null,
  };
}

/** @param {import('../contracts.js').SubtitleTrack} track */
function safeSlug(track) {
  const base = (track.releaseName || track.filename || track.id || 'subtitle')
    .replace(/\.(srt|vtt|ass|ssa|sub|zip|txt)$/i, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 60);
  const ext = track.format && ['srt', 'vtt', 'ass'].includes(track.format) ? track.format : 'srt';
  return `${base || 'subtitle'}.${ext}`;
}

/** Convert ASS cue markup so the same cues can be served as SRT. */
function toPlainCues(doc) {
  return {
    ...doc,
    cues: doc.cues.map((cue) => ({
      ...cue,
      text: stripSubtitleMarkup(String(cue.raw ?? cue.text ?? '').replace(/\\N/gi, '\n').replace(/\\n/gi, '\n')),
    })),
  };
}

function outputDoc(doc, targetFormat) {
  if (doc.format === 'ass' || doc.format === 'ssa') {
    return targetFormat === 'ass' ? doc : toPlainCues(doc);
  }
  return doc;
}

/* ── subtitle listing ──────────────────────────────────────────────────── */

/**
 * @param {{type:string, id:string, extra:object, config:object, baseUrl:string, embedConfig?:boolean, log?:Function}} req
 * @returns {Promise<{subtitles:Array<object>, videoKey:string, count:number}>}
 */
export async function handleSubtitlesRequest(req) {
  const started = Date.now();
  const log = req.log || pipelineLog;
  const config = req.config || getConfig();
  const parsed = parseStremioId(req.type, req.id);
  const videoKey = store.videoKeyOf({
    type: req.type,
    id: req.id,
    videoHash: req.extra?.videoHash,
    videoSize: req.extra?.videoSize,
    filename: req.extra?.filename,
  });

  const ctx = {
    type: parsed.type,
    imdbId: parsed.imdbId,
    tmdbId: parsed.tmdbId,
    season: req.extra?.season ?? parsed.season,
    episode: req.extra?.episode ?? parsed.episode,
    query: req.query || null,
    year: req.year || null,
    langs: (config.PREFERRED_LANGS || []).map(toLang2),
    filename: req.extra?.filename || null,
    videoHash: req.extra?.videoHash || null,
    videoSize: req.extra?.videoSize || null,
    config,
    log,
  };

  const tracks = await searchAll(ctx, { limit: config.MAX_SUBTITLES || 40 });
  for (const track of tracks) store.putTrack(track, videoKey, 'primary');
  store.kvSet(`video:${videoKey}`, {
    title: req.title || req.query || req.extra?.filename || req.id,
    filename: req.extra?.filename || null,
    videoHash: req.extra?.videoHash || null,
    videoSize: req.extra?.videoSize || null,
    type: req.type,
    id: req.id,
    at: Date.now(),
  });

  const wanted = (config.PREFERRED_LANGS || []).map(toLang2);
  const visible = config.SHOW_ONLY_PREFERRED
    ? tracks.filter((t) => wanted.includes(toLang2(t.lang)))
    : tracks;

  const subtitles = visible.map((track) => {
    const token = signToken({
      v: videoKey,
      i: track.id,
      ...(req.embedConfig ? { c: configToTokenPayload(config) } : {}),
      ...(req.extra?.videoHash ? { h: req.extra.videoHash } : {}),
      ...(req.extra?.videoSize ? { s: Number(req.extra.videoSize) } : {}),
      ...(req.extra?.filename ? { f: String(req.extra.filename).slice(0, 180) } : {}),
    }, { ttlMs: 30 * 24 * 3600 * 1000 });
    return {
      id: track.id,
      url: `${req.baseUrl}/s/${token}/${encodeURIComponent(safeSlug(track))}`,
      lang: toLang3(track.lang),
      ...(LANG_NAMES[toLang2(track.lang)] ? { label: `${LANG_NAMES[toLang2(track.lang)]}` } : {}),
    };
  });

  log('info', `subtitles: ${subtitles.length}/${tracks.length} tracks for ${req.type}/${req.id} in ${Date.now() - started}ms`);
  return { subtitles, videoKey, count: subtitles.length };
}

/* ── download ──────────────────────────────────────────────────────────── */

/**
 * Download a subtitle through its provider (handling lazy links and zip archives).
 * @returns {Promise<{text:string, format:string, fromZip:boolean, name:string}>}
 */
export async function fetchSubtitleBody({ track, config, log = pipelineLog }) {
  const ctx = { config, log, httpJson: (await import('../util/http.js')).httpJson };
  const resolved = await resolveTrackUrl(track, ctx);
  if (!resolved) throw new Error(`cannot resolve a download URL for ${track.id}`);

  if (resolved.filePath) {
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(resolved.filePath);
    const unwrapped = unwrapSubtitlePayload(body);
    return { text: decodeBody(unwrapped.body), format: formatOf(track, unwrapped.name), fromZip: unwrapped.fromZip, name: unwrapped.name };
  }

  const response = await fetchResponse(resolved.url, {
    headers: { ...(track.headers || {}), ...(resolved.headers || {}) },
    timeoutMs: 20000,
    retries: 2,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${track.provider} subtitle`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const unwrapped = unwrapSubtitlePayload(buffer);
  return {
    text: decodeBody(unwrapped.body),
    format: formatOf(track, unwrapped.name),
    fromZip: unwrapped.fromZip,
    name: unwrapped.name || track.filename || '',
  };
}

/**
 * Free-tier mirrors inject an advertisement cue into the subtitle (observed live:
 * `osdb.link`, `sub.wyzie.io`). It is not dialogue, it is always the first thing the viewer sees,
 * and it would otherwise be served verbatim.
 * @param {import('../contracts.js').SubtitleDoc} doc
 */
const PROMO_PATTERNS = [
  /osdb\.link/i,
  /wyzie\.io/i,
  /watch online movies and series for free/i,
  /advertise your product or brand here/i,
  /free plan\.?\s*unlock/i,
  /opensubtitles\.(com|org)\/[a-z]{2}\/?ad/i,
];

export function stripPromoCues(doc) {
  if (!doc?.cues?.length) return doc;
  const kept = doc.cues.filter((cue) => !PROMO_PATTERNS.some((re) => re.test(String(cue.text || ''))));
  if (kept.length === doc.cues.length) return doc;
  pipelineLog.debug(`stripped ${doc.cues.length - kept.length} promotional cue(s)`);
  return { ...doc, cues: kept.map((cue, index) => ({ ...cue, index })) };
}

function decodeBody(buffer) {
  let text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\uFFFD') || /[\u00c2-\u00c3][\u0080-\u00bf]/.test(text)) {
    const latin = Buffer.from(text, 'utf8').toString('latin1');
    if (!latin.includes('\uFFFD')) text = latin;
  }
  return text;
}

function formatOf(track, fromZipName) {
  for (const candidate of [fromZipName, track.filename, track.url, track.releaseName]) {
    const m = String(candidate || '').match(/\.(srt|vtt|ass|ssa)(\?|$)/i);
    if (m) return m[1].toLowerCase();
  }
  return track.format && track.format !== 'unknown' ? track.format : 'srt';
}

/* ── sync orchestration ────────────────────────────────────────────────── */

/** @type {Map<string, Promise<object|null>>} */
const inflight = new Map();

/**
 * Fetch, align and cache a synced variant of one track.
 * Memoised per (videoKey, trackId) so a subtitle picked twice does not sync twice.
 *
 * @param {{videoKey:string, trackId:string, videoHash?:string, videoSize?:number, filename?:string,
 *          config:object, log?:Function, allowAudio?:boolean}} req
 * @returns {Promise<{offsetMs:number, rate:number, method:string, confidence:number, doc:object, ms:number}|null>}
 */
export function ensureSynced(req) {
  const key = `${req.videoKey}|${req.trackId}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = runSync(req)
    .catch((err) => {
      (req.log || pipelineLog)('warn', `auto-sync failed: ${err.message}`);
      return null;
    })
    .finally(() => { setTimeout(() => inflight.delete(key), 30000).unref?.(); });
  inflight.set(key, promise);
  return promise;
}

export async function runSyncNow({ videoKey, trackId, videoHash, videoSize, filename, config, log = pipelineLog, allowAudio = true, options = {} }) {
  return runSync({ videoKey, trackId, videoHash, videoSize, filename, config, log, allowAudio, options });
}

/** Rank sibling tracks and keep a diverse, high-quality reference set. */
export function selectReferences(tracks, { excludeId, targetLang, filename, videoHash, langs, limit = 4 } = {}) {
  const scored = (tracks || [])
    .filter((t) => t.id !== excludeId && t.url)
    .map((t) => ({ track: t, score: scoreTrack(t, { filename, videoHash, langs, type: null }) }))
    .sort((a, b) => b.score - a.score);
  const ownLang = toLang2(targetLang);
  const perLang = new Map();
  const picked = [];
  // Own language first: identical dialogue is the strongest anchor signal.
  for (const wantOwn of [true, false]) {
    for (const { track } of scored) {
      if (picked.length >= limit) break;
      const lang = toLang2(track.lang);
      if (wantOwn !== (lang === ownLang)) continue;
      const used = perLang.get(lang) || 0;
      if (used >= 2) continue;
      if (picked.some((p) => p.id === track.id)) continue;
      perLang.set(lang, used + 1);
      picked.push(track);
    }
  }
  return picked;
}

async function runSync({ videoKey, trackId, videoHash, videoSize, filename, config, log = pipelineLog, allowAudio = true, options = {} }) {
  const started = Date.now();
  const track = store.getTrack(trackId);
  if (!track) return null;

  const { doc } = await loadSubtitleDoc({ videoKey, trackId, track, config, log });

  // References: other subtitles already known for this video. Pick them by rank (best release
  // match first), at most two per language, so a 12-track list does not bury a good reference
  // under four near-duplicates.
  const siblings = selectReferences(
    store.listTracks(videoKey, { kind: 'primary', limit: 30 }),
    { excludeId: trackId, targetLang: track.lang, filename, videoHash, langs: config.PREFERRED_LANGS },
  );
  const references = [];
  await Promise.all(siblings.map(async (sibling) => {
    try {
      const body = await withTimeout(fetchSubtitleBody({ track: sibling, config, log }), 6000, 'reference download');
      const refDoc = stripPromoCues(parseSubtitles(body.text, { url: sibling.url, format: body.format }));
      if (refDoc.cues.length >= 8) {
        refDoc.meta = { ...refDoc.meta, sourceLabel: `${sibling.provider}:${sibling.lang}` };
        references.push(refDoc);
      }
    } catch (err) {
      log('debug', `reference ${sibling.id} unusable: ${err.message}`);
    }
  }));

  let mediaPath = null;
  let mediaHeaders = null;
  let referencePath = null;
  if (allowAudio && config.AUDIO_SYNC_ENABLED) {
    const media = await resolveMedia({ videoKey, videoHash, videoSize, filename }).catch(() => ({ kind: 'none' }));
    if (media.kind !== 'none') {
      mediaPath = media.path;
      mediaHeaders = media.headers;
      log('info', `audio source: ${media.reason} (${media.kind})`);
    } else {
      log('debug', `no audio source: ${media.reason}`);
    }
  }

  const llm = config.LLM_PROVIDER && config.LLM_API_KEY
    ? { provider: config.LLM_PROVIDER, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL || undefined, attempts: config.LLM_ATTEMPTS }
    : null;

  const result = await syncSubtitle({
    doc,
    target: { filename, videoHash, videoSize, lang: track.lang },
    references,
    llm,
    audio: {
      enabled: Boolean(mediaPath),
      mediaPath,
      headers: mediaHeaders,
      referencePath,
      options: { analyzeWindowMs: config.AUDIO_ANALYZE_WINDOW_MS || 0 },
    },
    options: {
      allowRate: config.ALLOW_RATE !== false,
      maxOffsetMs: config.SYNC_MODE === 'full' ? 180000 : 120000,
      minApplyConfidence: options.minApplyConfidence ?? 0.45,
      ...(options.onlyMethods ? { onlyMethods: options.onlyMethods } : {}),
    },
    log,
  });

  if (!result.ok) {
    log('debug', `auto-sync produced nothing to apply: ${result.error}`);
    store.logEvent({
      kind: result.suggestion ? 'sync-suggestion' : 'sync-miss',
      videoKey, trackId, method: result.method,
      offsetMs: result.suggestion?.offsetMs, confidence: result.confidence,
      durationMs: Date.now() - started, detail: result.detail,
    });
    return { ...result, doc: null, body: null, ms: Date.now() - started };
  }

  store.putOffset(videoKey, trackId, {
    offsetMs: result.offsetMs,
    rate: result.rate,
    method: result.method,
    confidence: result.confidence,
    source: 'auto',
    detail: result.detail,
  });
  store.logEvent({
    kind: 'sync', videoKey, trackId, method: result.method,
    offsetMs: result.offsetMs, rate: result.rate, confidence: result.confidence,
    durationMs: Date.now() - started, detail: result.detail,
  });

  const synced = outputDoc(applySyncResult(doc, result), 'srt');
  const body = serializeSubtitles(synced, 'srt');
  store.putCachedSub(store.cacheKeyOf(['sync', videoKey, trackId, result.offsetMs, result.rate]), {
    body, format: 'srt', contentType: 'text/plain; charset=utf-8',
  });
  log('info', `auto-sync ${result.method}: ${result.offsetMs}ms rate=${result.rate} conf=${result.confidence.toFixed(2)} in ${Date.now() - started}ms`);
  return { ...result, doc: synced, body, ms: Date.now() - started };
}

/* ── serving a subtitle to Stremio ─────────────────────────────────────── */

/**
 * @param {{token:string, filename:string, baseConfig:object, log?:Function}} req
 * @returns {Promise<{status:number, body:string, contentType:string, headers:object}>}
 */
export async function serveSubtitle(req) {
  const log = req.log || pipelineLog;
  const payload = verifyToken(req.token);
  if (!payload?.v || !payload?.i) {
    return textResponse(400, 'invalid or expired subtitle token — re-select the subtitle in Stremio\n');
  }
  const baseConfig = req.baseConfig || getConfig();
  const config = payload.c ? applyTokenPayload(baseConfig, payload.c) : baseConfig;

  const videoKey = payload.v;
  const trackId = payload.i;
  const meta = { videoKey, trackId, videoHash: payload.h, videoSize: payload.s, filename: payload.f };

  const track = store.getTrack(trackId);
  if (!track) {
    return textResponse(404, 'this subtitle is no longer cached on the addon — go back in Stremio and pick it again\n');
  }

  // 1. an offset we already know (manual or from a previous auto run)
  const known = store.getOffset(videoKey, trackId) || store.getVideoOffset(videoKey);
  if (known) {
    const cacheKey = store.cacheKeyOf(['sync', videoKey, trackId, known.offsetMs, known.rate]);
    const cached = store.getCachedSub(cacheKey);
    if (cached) return serve(cached.body, cached.format, track, log, known);
    const raw = await downloadOrFail({ videoKey, trackId, track, config, log });
    if (raw.error) return raw.error;
    const synced = outputDoc(applySyncResult(raw.doc, known), 'srt');
    const body = serializeSubtitles(synced, 'srt');
    store.putCachedSub(cacheKey, { body, format: 'srt', contentType: 'text/plain; charset=utf-8' });
    return serve(body, 'srt', track, log, known);
  }

  // 2. no offset yet: try to compute one, but never make the user wait longer than the budget
  if (config.SYNC_MODE && config.SYNC_MODE !== 'off') {
    const budgetMs = config.AUTO_SYNC_BUDGET_MS ?? 9000;
    const syncing = ensureSynced({ ...meta, config, log, allowAudio: config.SYNC_MODE === 'full' });
    if (budgetMs > 0) {
      const outcome = await Promise.race([
        syncing.then((r) => ({ done: true, r })),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ done: false }), budgetMs);
          if (t.unref) t.unref();
        }),
      ]);
      if (outcome.done && outcome.r?.body) {
        return serve(outcome.r.body, 'srt', track, log, outcome.r);
      }
      if (outcome.done) {
        log('debug', outcome.r?.suggestion
          ? `auto-sync only produced a suggestion (${outcome.r.suggestion.offsetMs}ms, confidence ${outcome.r.confidence.toFixed(2)}) — serving the original timing; confirm it in the Sync Lab`
          : 'auto-sync returned nothing within budget — serving the original timing');
      } else {
        log('info', `auto-sync still running after ${budgetMs}ms — serving the original timing, the next fetch will be synced`);
        detach(syncing, 'background-sync');
      }
    } else {
      const result = await syncing;
      if (result?.body) return serve(result.body, 'srt', track, log, result);
    }
  }

  // 3. raw fallback
  const raw = await downloadOrFail({ videoKey, trackId, track, config, log });
  if (raw.error) return raw.error;
  const body = serializeSubtitles(outputDoc(raw.doc, 'srt'), 'srt');
  return serve(body, 'srt', track, log, { offsetMs: 0, rate: 1, method: 'none', confidence: 0 }, true);
}

/** Download, but turn an upstream failure into a clean 502 for the player. */
async function downloadOrFail(args) {
  try {
    return await loadSubtitleDoc(args);
  } catch (err) {
    args.log.warn(`cannot serve ${args.track?.id}: ${err.message}`);
    return {
      error: textResponse(502, `could not download this subtitle from ${args.track?.provider || 'the provider'}: ${err.message}\n`),
    };
  }
}

/**
 * THE single entry point for "give me this track's cues".
 *
 * Serving, syncing and the Sync Lab all go through here, because the two rules that must never
 * be bypassed live here: an upstream that answers 200 with an error page must not become an
 * empty subtitle, and the promotional cue that free mirrors inject must not reach the viewer.
 * (Both were real bugs: the sync path used to hand the promo cue straight through.)
 *
 * @returns {Promise<{doc:import('../contracts.js').SubtitleDoc, text:string, format:string, fromZip:boolean, cached:boolean}>}
 */
export async function loadSubtitleDoc({ videoKey, trackId, track, config, log = pipelineLog }) {
  const rawKey = store.cacheKeyOf(['raw', videoKey || 'any', trackId || track?.id]);

  const cached = store.getCachedSub(rawKey);
  if (cached) {
    const doc = parseSubtitles(cached.body, { url: track?.url, format: cached.format });
    if (doc.cues.length) {
      // Strip here too: entries cached by an older build still carry the promo cue, and a
      // persisted /data volume means they survive a redeploy.
      const cleaned = stripPromoCues(doc);
      return {
        doc: cleaned,
        text: cleaned === doc ? cached.body : serializeSubtitles(cleaned, cached.format || 'srt'),
        format: cached.format || 'srt',
        fromZip: false,
        cached: true,
      };
    }
    store.deleteCachedSub?.(rawKey);
    log.debug(`dropped an unusable cached subtitle for ${track?.id}`);
  }

  const fetched = await fetchSubtitleBody({ track, config, log });
  const parsed = parseSubtitles(fetched.text, { url: track?.url, format: fetched.format });
  if (!parsed.cues.length) {
    throw new Error(`${track?.provider || 'upstream'} returned no usable subtitle (${fetched.text.length} bytes${fetched.fromZip ? ', from a zip' : ''})`);
  }

  const doc = stripPromoCues(parsed);
  const format = fetched.format === 'ass' || fetched.format === 'ssa' ? 'srt' : fetched.format;
  const text = serializeSubtitles(doc, format);
  store.putCachedSub(rawKey, {
    body: text,
    format,
    contentType: 'text/plain; charset=utf-8',
    ttlMs: config?.CACHE_TTL_MS,
  });
  return { doc, text, format, fromZip: fetched.fromZip, cached: false };
}

function serve(body, format, track, log, sync, degraded = false) {
  const contentType = format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8';
  log('debug', `serving ${track.id} (${sync?.method || 'none'}${degraded ? ', unsynced' : ''})`);
  return {
    status: 200,
    body,
    contentType,
    headers: {
      'cache-control': 'public, max-age=3600',
      'x-nuvio-sync-method': String(sync?.method || 'none'),
      'x-nuvio-sync-offset-ms': String(sync?.offsetMs ?? 0),
      'x-nuvio-sync-rate': String(sync?.rate ?? 1),
      'x-nuvio-sync-confidence': String(Number(sync?.confidence ?? 0).toFixed(3)),
    },
  };
}

function textResponse(status, body) {
  return { status, body, contentType: 'text/plain; charset=utf-8', headers: { 'cache-control': 'no-store' } };
}

export { attachMedia, probeDuration, getProvider, normalizeOffset };
