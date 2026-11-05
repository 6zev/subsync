/**
 * Sync orchestrator — the single entry point the addon pipeline calls.
 *
 * Escalation ladder (cheap -> expensive), first trustworthy answer wins:
 *   text  : align against sibling subtitles of the same video (fast, no keys)
 *   llm   : Nuvio's windowed LLM cue matching (5 lines, median of pooled offsets)
 *   audio : correlate the subtitle's dialogue envelope with the real audio track
 *
 * Owned by LEAD. Contract: src/contracts.js §3.
 */
import { NUVIO } from '../contracts.js';
import { parseSubtitles, serializeSubtitles, detectFormat, cuesToSpeechMask } from './subtitles.js';
import { shiftCues, shiftDoc, normalizeOffset, offsetFromCapture } from './shift.js';
import { alignByText } from './textAlign.js';
import { alignByLlm } from './llmMatch.js';
import { alignByAudio } from './audioAlign.js';
import { createLogger } from '../util/log.js';

const syncLog = createLogger('sync');

export const DEFAULT_SYNC_OPTIONS = Object.freeze({
  minCues: 8,
  minAnchors: 6,
  minConfidence: 0.3,
  /** Below this the result is a suggestion the user can accept, not something we apply. */
  minApplyConfidence: 0.45,
  maxOffsetMs: NUVIO.DELAY_MAX_MS,
  minOffsetMs: NUVIO.DELAY_MIN_MS,
  stepMs: NUVIO.DELAY_STEP_MS,
  reactionCompensationMs: NUVIO.REACTION_COMPENSATION_MS,
  allowRate: true,
  preferExternalAligners: true,
});

const NONE = { ok: false, method: 'none', offsetMs: 0, rate: 1, confidence: 0, samples: 0, detail: {} };

/**
 * @param {import('../contracts.js').SyncRequest} req
 * @returns {Promise<import('../contracts.js').SyncResult>}
 */
export async function syncSubtitle(req = {}) {
  const started = Date.now();
  const options = { ...DEFAULT_SYNC_OPTIONS, ...(req.options || {}) };
  const say = req.log || ((level, msg, extra) => syncLog[level === 'warn' ? 'warn' : 'debug'](msg, extra));
  const doc = req.doc;
  if (!doc?.cues?.length) return { ...NONE, error: 'no cues to sync' };
  if (doc.cues.length < options.minCues) {
    return { ...NONE, error: `only ${doc.cues.length} cues — below the ${options.minCues} cue minimum`, detail: { cues: doc.cues.length } };
  }

  // `onlyMethods` pins the escalation ladder (diagnostics + the Sync Lab's per-stage buttons).
  const only = Array.isArray(options.onlyMethods) && options.onlyMethods.length ? new Set(options.onlyMethods) : null;
  const wants = (stage) => !only || only.has(stage);
  const candidates = [];

  if (wants('text') && req.references?.length) {
    const result = alignByText({ doc, references: req.references, options, log: say });
    candidates.push({ ...result, method: 'text' });
  }

  const bestSoFar = () => candidates.filter((c) => c.ok).sort((a, b) => b.confidence - a.confidence)[0] || null;
  let current = bestSoFar();

  if (wants('llm') && req.llm?.apiKey && (only || !current || current.confidence < 0.75)) {
    const result = await alignByLlm({
      refCues: pickReferenceCues(req.references),
      targetCues: doc.cues,
      llm: req.llm,
      options: { ...options, attempts: req.llm.attempts ?? NUVIO.MAX_ATTEMPTS, lineCount: NUVIO.SOURCE_LINE_COUNT },
      fetchImpl: req.fetchImpl,
      log: say,
      signal: req.signal,
    });
    if (result.ok) candidates.push({ ...result, method: 'llm' });
    else if (result.error) say('debug', `llm stage: ${result.error}`);
    current = bestSoFar();
  }

  const wantAudio = wants('audio') && req.audio?.enabled && req.audio?.mediaPath
    && (only ? true : (!current || current.confidence < (req.audio.threshold ?? 0.8)));
  if (wantAudio) {
    const result = await alignByAudio({
      mediaPath: req.audio.mediaPath,
      doc,
      options: { ...options, ...(req.audio.options || {}), headers: req.audio.headers, referencePath: req.audio.referencePath },
      log: say,
    });
    if (result.ok) candidates.push({ ...result, method: 'audio' });
    else if (result.error) say('debug', `audio stage: ${result.error}`);
  }

  const winner = candidates.filter((c) => c.ok).sort((a, b) => b.confidence - a.confidence)[0];
  if (!winner) {
    return {
      ...NONE,
      confidence: Math.max(0, ...candidates.map((c) => c.confidence || 0)),
      detail: { attempts: candidates.map((c) => ({ method: c.method, ok: c.ok, confidence: c.confidence, error: c.error })), ms: Date.now() - started },
      error: candidates.length ? 'no method produced a confident alignment' : 'no sync method was available',
    };
  }

  if (winner.confidence < (options.minApplyConfidence ?? 0.45)) {
    const suggestion = {
      method: winner.method,
      offsetMs: normalizeOffset(winner.offsetMs, { minOffsetMs: options.minOffsetMs, maxOffsetMs: options.maxOffsetMs }),
      rate: clampRate(winner.rate),
      confidence: winner.confidence,
      samples: winner.samples ?? 0,
      detail: winner.detail,
    };
    say('debug', `sync confidence ${winner.confidence.toFixed(2)} is below the apply threshold — suggesting instead`);
    return {
      ...NONE,
      method: /** @type {any} */ (winner.method),
      confidence: winner.confidence,
      suggestion,
      detail: { ...(winner.detail || {}), ms: Date.now() - started, suggestedOnly: true },
      error: 'confidence below the auto-apply threshold — shown as a suggestion',
    };
  }

  const offsetMs = normalizeOffset(winner.offsetMs, {
    minOffsetMs: options.minOffsetMs,
    maxOffsetMs: options.maxOffsetMs,
    stepMs: options.stepMs,
    quantize: false, // auto-sync keeps millisecond precision; only the manual UI quantises
  });
  const rate = options.allowRate ? clampRate(winner.rate) : 1;

  return {
    ok: true,
    method: /** @type {any} */ (winner.method),
    offsetMs,
    rate,
    confidence: Math.max(0, Math.min(1, winner.confidence || 0)),
    samples: winner.samples ?? 0,
    detail: { ...(winner.detail || {}), ms: Date.now() - started, candidates: candidates.map((c) => ({ method: c.method, ok: c.ok, confidence: Number((c.confidence || 0).toFixed(3)) })) },
  };
}

/** Use the densest reference (most cues) — more anchors means a better LLM window. */
function pickReferenceCues(references) {
  if (!references?.length) return [];
  return references
    .slice()
    .sort((a, b) => (b?.cues?.length ?? 0) - (a?.cues?.length ?? 0))[0]?.cues ?? [];
}

function clampRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0.95 || rate >= 1.05) return 1;
  return Math.abs(rate - 1) < 0.0004 ? 1 : Number(rate.toFixed(6));
}

/** Apply a SyncResult to a document, returning a new document. */
export function applySyncResult(doc, result) {
  const offsetMs = normalizeOffset(result?.offsetMs ?? 0, {});
  const rate = Number.isFinite(result?.rate) && result.rate > 0 ? result.rate : 1;
  if (!offsetMs && rate === 1) return doc;
  return shiftDoc(doc, { offsetMs, rate });
}

export {
  parseSubtitles, serializeSubtitles, detectFormat, cuesToSpeechMask,
  shiftCues, shiftDoc, normalizeOffset, offsetFromCapture,
  alignByText, alignByLlm, alignByAudio,
};

export default { syncSubtitle, applySyncResult, normalizeOffset, shiftDoc };
