/**
 * Sync Lab API — the endpoints the web UI drives. Mirrors Nuvio's SubtitleTimingDialog:
 * the same `position - cueStart - 300ms` arithmetic, the same clamp, the same "remembered"
 * delay, plus the auto paths.
 *
 * Owned by LEAD. Contract: src/contracts.js §6.
 */
import { getConfig } from '../env.js';
import * as store from '../store/index.js';
import { verifyToken, applyTokenPayload } from '../addon/tokens.js';
import { runSyncNow } from '../addon/pipeline.js';
import { attachMedia, resolveMedia } from '../media/index.js';
import {
  parseSubtitles, serializeSubtitles, applySyncResult, normalizeOffset, offsetFromCapture, shiftDoc,
} from '../sync/index.js';
import { fetchSubtitleBody } from '../addon/pipeline.js';
import { NUVIO, LANG_NAMES, toLang2 } from '../contracts.js';
import { createLogger } from '../util/log.js';

const labLog = createLogger('synclab');

const json = (status, payload) => ({
  status,
  body: JSON.stringify(payload),
  contentType: 'application/json; charset=utf-8',
  headers: { 'cache-control': 'no-store' },
});

const fail = (status, error) => json(status, { ok: false, error });

function resolveSession(token, baseConfig) {
  const payload = verifyToken(token);
  if (!payload?.v) return { error: 'invalid or expired token — open the Sync Lab from Stremio again' };
  const config = payload.c ? applyTokenPayload(baseConfig, payload.c) : baseConfig;
  return { videoKey: payload.v, trackId: payload.i || null, payload, config };
}

function trackView(track) {
  const offset = store.getOffset(track.videoKey, track.id) || store.getOffset(track.videoKey, '*');
  return {
    id: track.id,
    provider: track.provider,
    lang: toLang2(track.lang),
    langName: LANG_NAMES[toLang2(track.lang)] || track.langName || track.lang,
    label: track.releaseName || track.filename || track.id,
    offsetMs: offset?.offsetMs ?? 0,
    rate: offset?.rate ?? 1,
    method: offset?.method ?? null,
    confidence: offset?.confidence ?? 0,
    updatedAt: offset?.updatedAt ?? null,
    hasOffset: Boolean(offset),
  };
}

/* ── routes ────────────────────────────────────────────────────────────── */

/** GET /api/synclab/session?t= */
export async function getSession({ token, baseConfig = getConfig() }) {
  const resolved = resolveSession(token, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const { videoKey, trackId, config } = resolved;
  const info = store.kvGet(`video:${videoKey}`) || {};
  const tracks = store.listTracks(videoKey, { kind: 'primary', limit: 60 }).map(trackView);
  const media = await resolveMedia({ videoKey, videoHash: info.videoHash, videoSize: info.videoSize, filename: info.filename, allowDebrid: false }).catch(() => ({ kind: 'none' }));
  return json(200, {
    ok: true,
    videoKey,
    title: info.title || info.filename || videoKey,
    filename: info.filename || null,
    selectedTrackId: trackId || tracks[0]?.id || null,
    tracks,
    media: { kind: media.kind, path: media.kind === 'none' ? null : media.path, reason: media.reason || null },
    settings: {
      clampMinMs: NUVIO.DELAY_MIN_MS,
      clampMaxMs: NUVIO.DELAY_MAX_MS,
      stepMs: NUVIO.DELAY_STEP_MS,
      reactionCompensationMs: NUVIO.REACTION_COMPENSATION_MS,
      allowRate: config.ALLOW_RATE !== false,
      autoSyncMode: config.SYNC_MODE,
      audioEnabled: Boolean(config.AUDIO_SYNC_ENABLED),
      minApplyConfidence: 0.45,
      consensusRequired: true,
    },
    llm: {
      configured: Boolean(config.LLM_PROVIDER && config.LLM_API_KEY),
      provider: config.LLM_PROVIDER || null,
      model: config.LLM_MODEL || (config.LLM_PROVIDER === 'gemini' ? NUVIO.GEMINI_MODEL_DEFAULT : NUVIO.GROQ_MODEL_DEFAULT),
    },
  });
}

/** GET /api/synclab/cues?t=&trackId=&fromMs=&toMs=&limit= */
export async function getCues({ token, trackId, fromMs, toMs, limit = 60, baseConfig = getConfig() }) {
  const resolved = resolveSession(token, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const id = trackId || resolved.trackId;
  if (!id) return fail(400, 'no track selected');
  const track = store.getTrack(id);
  if (!track) return fail(404, 'this track is not cached on the addon anymore — pick the subtitle again in Stremio');

  let doc;
  try {
    doc = await rawDocFor(track, resolved.config);
  } catch (err) {
    return fail(502, `cannot read the subtitle: ${err.message}`);
  }
  const all = doc.cues;
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : null;
  let window = all;
  if (from !== null) window = all.filter((c) => c.start >= from - 2000);
  if (Number.isFinite(Number(toMs))) window = window.filter((c) => c.start <= Number(toMs));
  const size = Math.max(1, Math.min(300, Number(limit) || 60));
  return json(200, {
    ok: true,
    trackId: id,
    total: all.length,
    fromMs: from ?? all[0]?.start ?? 0,
    cues: window.slice(0, size).map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
  });
}

/** POST /api/synclab/apply */
export async function postApply({ body, baseConfig = getConfig() }) {
  const resolved = resolveSession(body?.t, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const { videoKey } = resolved;
  const trackId = body?.trackId || resolved.trackId;
  if (!trackId) return fail(400, 'no track selected');

  const mode = body?.mode || 'offset';

  if (mode === 'reset') {
    store.deleteOffset(videoKey, trackId);
    store.logEvent({ kind: 'sync-reset', videoKey, trackId, method: 'manual' });
    return json(200, { ok: true, trackId, offsetMs: 0, rate: 1, method: 'none', confidence: 0, message: 'đã xóa đồng bộ / offset cleared' });
  }

  let offsetMs;
  if (mode === 'tap') {
    const videoPositionMs = Number(body?.videoPositionMs);
    const cueStartMs = Number(body?.cueStartMs);
    if (!Number.isFinite(videoPositionMs) || !Number.isFinite(cueStartMs)) return fail(400, 'videoPositionMs and cueStartMs are required');
    offsetMs = offsetFromCapture({
      videoPositionMs,
      cueStartMs,
      reactionCompensationMs: resolved.config.REACTION_COMPENSATION_MS ?? NUVIO.REACTION_COMPENSATION_MS,
    });
  } else {
    offsetMs = normalizeOffset(Number(body?.offsetMs) || 0, { maxOffsetMs: NUVIO.DELAY_MAX_MS });
  }

  const rate = Number.isFinite(Number(body?.rate)) && Number(body.rate) > 0.9 && Number(body.rate) < 1.1 ? Number(body.rate) : 1;
  store.putOffset(videoKey, trackId, {
    offsetMs,
    rate,
    method: mode === 'tap' ? 'manual-tap' : 'manual',
    confidence: 1,
    source: 'manual',
    detail: mode === 'tap' ? { videoPositionMs: body.videoPositionMs, cueStartMs: body.cueStartMs, reactionCompensationMs: 300 } : { mode },
  });
  store.logEvent({ kind: 'sync', videoKey, trackId, method: mode, offsetMs, rate, confidence: 1 });
  labLog.info(`manual ${mode}: ${offsetMs}ms for ${videoKey}`);
  return json(200, {
    ok: true,
    trackId,
    offsetMs,
    rate,
    method: mode === 'tap' ? 'manual-tap' : 'manual',
    confidence: 1,
    message: `đã áp dụng ${offsetMs}ms`,
  });
}

/** POST /api/synclab/auto  {t, trackId, mode:'fast'|'full'} */
export async function postAuto({ body, baseConfig = getConfig() }) {
  const resolved = resolveSession(body?.t, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const { videoKey, config } = resolved;
  const trackId = body?.trackId || resolved.trackId;
  if (!trackId) return fail(400, 'no track selected');
  const info = store.kvGet(`video:${videoKey}`) || {};
  const mode = body?.mode === 'full' ? 'full' : 'fast';
  if (mode === 'full' && !config.AUDIO_SYNC_ENABLED) {
    // Still allowed explicitly: the user pressed the button.
    labLog.info('full sync requested while AUDIO_SYNC_ENABLED is off — running it anyway');
  }

  // An explicit user action always applies, even when the evidence is a single reference.
  const result = await runSyncNow({
    videoKey,
    trackId,
    videoHash: info.videoHash,
    videoSize: info.videoSize,
    filename: info.filename,
    config,
    log: labLog,
    allowAudio: mode === 'full',
    options: {
      minApplyConfidence: 0,
      ...(Array.isArray(body?.methods) && body.methods.length ? { onlyMethods: body.methods.filter((m) => ['text', 'llm', 'audio'].includes(m)) } : {}),
    },
  });

  if (!result) {
    return json(200, { ok: true, result: { ok: false, method: 'none', offsetMs: 0, rate: 1, confidence: 0, error: 'không tìm được cách đồng bộ / no sync method succeeded' } });
  }
  return json(200, {
    ok: true,
    result: {
      ok: Boolean(result.ok),
      method: result.method,
      offsetMs: result.suggestion?.offsetMs ?? result.offsetMs,
      rate: result.rate ?? 1,
      confidence: result.confidence ?? 0,
      samples: result.samples ?? result.suggestion?.samples ?? 0,
      detail: result.detail,
      error: result.ok ? undefined : result.error,
    },
  });
}

/** GET /api/synclab/preview?t=&trackId= */
export async function getPreview({ token, trackId, baseConfig = getConfig() }) {
  const resolved = resolveSession(token, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const id = trackId || resolved.trackId;
  const track = id ? store.getTrack(id) : null;
  if (!track) return fail(404, 'unknown track');
  let doc;
  try {
    doc = await rawDocFor(track, resolved.config);
  } catch (err) {
    return fail(502, `cannot read the subtitle: ${err.message}`);
  }
  const offset = store.getOffset(resolved.videoKey, id) || store.getOffset(resolved.videoKey, '*');
  const synced = offset ? applySyncResult(doc, offset) : doc;
  return {
    status: 200,
    body: serializeSubtitles(synced, 'srt'),
    contentType: 'text/plain; charset=utf-8',
    headers: {
      'cache-control': 'no-store',
      'content-disposition': `inline; filename="synced.${track.lang || 'und'}.srt"`,
    },
  };
}

/** POST /api/synclab/media  {t, value} */
export async function postMedia({ body, baseConfig = getConfig() }) {
  const resolved = resolveSession(body?.t, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  const value = String(body?.value || '').trim();
  if (!value) return fail(400, 'empty value');
  const input = /^magnet:/i.test(value)
    ? { magnet: value }
    : /^https?:\/\//i.test(value)
      ? { url: value }
      : { path: value };
  const result = await attachMedia(resolved.videoKey, input);
  return json(result.ok ? 200 : 400, { ...result, videoKey: resolved.videoKey });
}

/** GET /api/synclab/tracks?t= — used by the debug view. */
export async function getTracks({ token, baseConfig = getConfig() }) {
  const resolved = resolveSession(token, baseConfig);
  if (resolved.error) return fail(400, resolved.error);
  return json(200, { ok: true, videoKey: resolved.videoKey, tracks: store.listTracks(resolved.videoKey, { limit: 60 }).map(trackView) });
}

/* ── shared ────────────────────────────────────────────────────────────── */

const docCache = new Map();

async function rawDocFor(track, config) {
  const key = `${track.id}:${track.createdAt || 0}`;
  const hit = docCache.get(key);
  if (hit) return hit;
  const fetched = await fetchSubtitleBody({ track, config, log: labLog });
  const doc = parseSubtitles(fetched.text, { url: track.url, format: fetched.format });
  if (docCache.size > 200) docCache.clear();
  docCache.set(key, doc);
  return doc;
}

export { shiftDoc, resolveSession };
