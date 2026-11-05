/**
 * LLM cue matching — a faithful port of Nuvio's Auto Sync V2 stage.
 *
 * Nuvio buffers 5 consecutive lines of the video's built-in text track
 * (`AUTO_SYNC_SOURCE_LINE_COUNT`), asks an LLM (Groq `llama-3.1-8b-instant` or
 * `gemini-3.5-flash`) which addon-subtitle cue corresponds to each reference line, pools the
 * per-pair offsets over up to `AUTO_SYNC_MAX_ATTEMPTS = 3` attempts, and takes the median.
 *
 * Here the reference lines come from a *sibling subtitle file* for the same video instead of
 * the built-in track. Owned by LEAD. Contract: src/contracts.js §3.
 */
import { stripSubtitleMarkup, median, mad } from '../util/text.js';
import { normalizeOffset } from './shift.js';
import { NUVIO } from '../contracts.js';

/** @param {number} ms */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

const usable = (cue) => /[\p{L}\p{N}]/u.test(stripSubtitleMarkup(cue.text ?? ''));

/**
 * Build the prompt for one window. Kept deliberately small and index-based so weak
 * free-tier models stay reliable, exactly like Nuvio's implementation.
 * @param {import('../../contracts.js').Cue[]} refWindow  up to 5 reference lines
 * @param {import('../../contracts.js').Cue[]} candidates target subtitle candidates
 */
export function buildPrompt(refWindow, candidates) {
  const refLines = refWindow
    .map((cue, i) => `${i + 1}. [${formatClock(cue.start)}] ${stripSubtitleMarkup(cue.text).slice(0, 160)}`)
    .join('\n');
  const candLines = candidates
    .map((cue, i) => `${i + 1}. [${formatClock(cue.start)}] ${stripSubtitleMarkup(cue.text).slice(0, 160)}`)
    .join('\n');
  return [
    'You align subtitles. You are given the same moments of a film from two different subtitle files.',
    'REFERENCE lines are considered correctly timed. CANDIDATE lines come from a file whose timing is wrong.',
    'For every REFERENCE line, find the CANDIDATE line that says the same thing — it may be in another language,',
    'so match meaning, not spelling. Skip a reference line when no candidate matches it.',
    '',
    'REFERENCE:',
    refLines,
    '',
    'CANDIDATE:',
    candLines,
    '',
    'Reply with JSON only, no prose: {"matches":[{"ref":<reference number>,"target":<candidate number>}]}',
    'Numbers are 1-based indexes from the lists above.',
  ].join('\n');
}

/**
 * Parse the model reply defensively: code fences, leading prose, 0-based vs 1-based.
 * @param {string} text
 * @param {number} refLen
 * @param {number} candLen
 * @returns {Array<{ref:number, target:number}>}
 */
export function parseLlmMatches(text, refLen, candLen) {
  const raw = String(text ?? '');
  let payload = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { payload = JSON.parse(body.slice(start, end + 1)); } catch { payload = null; }
  }
  if (!payload) {
    const arrayStart = body.indexOf('[');
    const arrayEnd = body.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try { payload = { matches: JSON.parse(body.slice(arrayStart, arrayEnd + 1)) }; } catch { payload = null; }
    }
  }
  if (!payload) return [];

  const list = Array.isArray(payload) ? payload : (payload.matches || payload.pairs || payload.result || []);
  if (!Array.isArray(list)) return [];

  const pairs = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = Number(item.ref ?? item.reference ?? item.source ?? item.a);
    const t = Number(item.target ?? item.candidate ?? item.addon ?? item.b);
    if (!Number.isInteger(r) || !Number.isInteger(t)) continue;
    pairs.push({ r, t });
  }
  if (!pairs.length) return [];

  const score = (offset) => pairs.filter((p) => {
    const ri = p.r - offset;
    const ti = p.t - offset;
    return ri >= 0 && ri < refLen && ti >= 0 && ti < candLen;
  }).length;

  const oneBased = score(1);
  const zeroBased = score(0);
  const shift = zeroBased > oneBased ? 0 : 1;

  return pairs
    .map((p) => ({ ref: p.r - shift, target: p.t - shift }))
    .filter((p) => p.ref >= 0 && p.ref < refLen && p.target >= 0 && p.target < candLen);
}

/**
 * Call the configured LLM.
 * @param {{provider:string, apiKey:string, model?:string, baseUrl?:string}} llm
 * @param {string} prompt
 * @param {{fetchImpl?:Function, timeoutMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
export async function callLlm(llm, prompt, { fetchImpl, timeoutMs = 20000, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch implementation available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('llm timeout')), timeoutMs);
  if (timer.unref) timer.unref();
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  try {
    if (llm.provider === 'gemini') {
      const model = llm.model || NUVIO.GEMINI_MODEL_DEFAULT;
      const url = `${llm.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'}/models/${model}:generateContent?key=${encodeURIComponent(llm.apiKey)}`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`gemini ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      return { text, provider: 'gemini', model };
    }
    const model = llm.model || NUVIO.GROQ_MODEL_DEFAULT;
    const url = `${llm.baseUrl || 'https://api.groq.com/openai/v1'}/chat/completions`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a precise subtitle alignment engine. Reply with JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`groq ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const text = json?.choices?.[0]?.message?.content ?? '';
    return { text, provider: 'groq', model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick `attempts` windows of `lineCount` consecutive usable reference lines, spread across the file.
 * @param {import('../../contracts.js').Cue[]} refCues
 * @param {number} lineCount
 * @param {number} attempts
 */
export function pickWindows(refCues, lineCount, attempts) {
  const pool = (refCues || []).filter(usable);
  if (pool.length < lineCount) return [];
  const windows = [];
  const seen = new Set();
  for (let i = 0; i < attempts; i += 1) {
    const ratio = attempts === 1 ? 0.5 : 0.12 + (0.76 * i) / Math.max(1, attempts - 1);
    const startIdx = Math.min(pool.length - lineCount, Math.max(0, Math.round(ratio * pool.length)));
    const key = `${startIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ startIdx, cues: pool.slice(startIdx, startIdx + lineCount) });
  }
  return windows;
}

/**
 * Nuvio's AI pipeline: windowed reference lines -> LLM -> pooled per-pair offsets -> median.
 *
 * @param {{refCues:import('../../contracts.js').Cue[], targetCues:import('../../contracts.js').Cue[],
 *          llm:{provider:string,apiKey:string,model?:string,baseUrl?:string},
 *          options?:object, fetchImpl?:Function, log?:Function, signal?:AbortSignal}} req
 * @returns {Promise<{ok:boolean, offsetMs:number, rate:number, confidence:number, samples:number, detail:object, error?:string}>}
 */
export async function alignByLlm({ refCues, targetCues, llm, options = {}, fetchImpl, log, signal } = {}) {
  const say = log || (() => {});
  const maxOffsetMs = options.maxOffsetMs ?? NUVIO.DELAY_MAX_MS;
  const attempts = Math.max(1, Math.min(5, options.attempts ?? NUVIO.MAX_ATTEMPTS));
  const lineCount = options.lineCount ?? NUVIO.SOURCE_LINE_COUNT;
  const searchWindowMs = options.searchWindowMs ?? 150000;
  const empty = { ok: false, offsetMs: 0, rate: 1, confidence: 0, samples: 0, detail: { strategy: 'llm', attempts: 0 } };

  if (!llm?.apiKey) return { ...empty, error: 'no LLM API key configured' };
  if (!refCues?.length || !targetCues?.length) return { ...empty, error: 'missing cues' };

  const windows = pickWindows(refCues, lineCount, attempts);
  if (!windows.length) return { ...empty, error: `reference has fewer than ${lineCount} dialogue lines` };

  const pooled = [];
  const attemptsRun = [];
  for (const window of windows) {
    const anchor = window.cues[0].start;
    let candidates = targetCues.filter((c) => c.start >= anchor - searchWindowMs && c.start <= anchor + searchWindowMs);
    if (candidates.length > 70) {
      const stride = candidates.length / 70;
      candidates = Array.from({ length: 70 }, (_v, i) => candidates[Math.floor(i * stride)]);
    }
    if (candidates.length < 2) {
      attemptsRun.push({ window: formatClock(anchor), candidates: candidates.length, matched: 0, skipped: 'too few candidates' });
      continue;
    }
    let reply;
    try {
      reply = await callLlm(llm, buildPrompt(window.cues, candidates), { fetchImpl, signal, timeoutMs: options.llmTimeoutMs });
    } catch (err) {
      say('warn', `llm attempt failed: ${err.message}`);
      attemptsRun.push({ window: formatClock(anchor), error: err.message });
      continue;
    }
    const matches = parseLlmMatches(reply.text, window.cues.length, candidates.length);
    const offsets = matches.map((m) => window.cues[m.ref].start - candidates[m.target].start);
    pooled.push(...offsets);
    attemptsRun.push({
      window: formatClock(anchor),
      model: reply.model,
      candidates: candidates.length,
      matched: matches.length,
      offsets: offsets.slice(0, 10),
    });
    if (pooled.length >= 12) break;
  }

  if (!pooled.length) {
    return { ...empty, detail: { strategy: 'llm', attempts: attemptsRun }, error: 'the model returned no usable matches' };
  }

  const centre = median(pooled);
  const filtered = pooled.filter((v) => Math.abs(v - centre) <= 3000);
  const offsetMs = normalizeOffset(median(filtered), { minOffsetMs: -maxOffsetMs, maxOffsetMs });
  const spread = mad(filtered);
  const confidence = clamp01(
    Math.min(1, filtered.length / 10) * 0.5
    + (1 - Math.min(1, (Number.isFinite(spread) ? spread : 2000) / 1500)) * 0.4
    + Math.min(1, attemptsRun.filter((a) => a.matched).length / attempts) * 0.1,
  );

  return {
    ok: filtered.length >= 1,
    offsetMs,
    rate: 1,
    confidence,
    samples: filtered.length,
    detail: { strategy: 'llm', provider: llm.provider, attempts: attemptsRun, spreadMs: spread, pooled: pooled.length },
  };
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
