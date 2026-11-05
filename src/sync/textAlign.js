/**
 * Text-based alignment: match a subtitle against *other* subtitles of the same video.
 *
 * Two strategies, in order:
 *   1. anchor matching — identical or near-identical dialogue lines give (targetStart, refStart)
 *      pairs; a delta histogram finds the coarse offset and a robust least-squares fit recovers
 *      linear drift (rate). Same-language references.
 *   2. speech-mask correlation — rasterise both cue lists to dialogue intervals and search the
 *      lag that maximises overlap. Language independent, offset only.
 *
 * This is the addon's substitute for Nuvio's "use the file's built-in track as reference".
 * Owned by LEAD. Contract: src/contracts.js §3.
 */
import { foldText, stripSubtitleMarkup, lineSimilarity, median, mad } from '../util/text.js';
import { cuesToSpeechMask } from './subtitles.js';
import { bestMaskLag, fitLinear } from './correlate.js';
import { normalizeOffset } from './shift.js';

const DEFAULT_OPTIONS = {
  minCues: 8,
  minAnchors: 6,
  minSimilarity: 0.82,
  maxOffsetMs: 180000,
  rateTolerance: 1.002,
  allowRate: true,
};

/** Aggressively normalised line text used as a match key. */
export function matchKey(text) {
  return foldText(stripSubtitleMarkup(text))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for lines that carry real dialogue (skip music/SFX markers and single letters). */
function isUsable(text) {
  const key = matchKey(text);
  if (key.replace(/\s/g, '').length < 4) return false;
  if (/^(music|musique|applause|silence|laughs?|sighs?|screams?)$/i.test(key)) return false;
  return true;
}

/** Signature bucket = first 4 folded characters, used for fuzzy lookups. */
function signature(key) {
  const compact = key.replace(/\s/g, '');
  return compact.slice(0, 4) || '?';
}

/**
 * @param {import('../../contracts.js').Cue[]} targetCues subtitle that needs syncing
 * @param {import('../../contracts.js').Cue[]} refCues    reference subtitle
 * @param {{maxOffsetMs?:number, minSimilarity?:number}} [opts]
 * @returns {{pairs:Array<{refStart:number,tgtStart:number,similarity:number,refIdx:number,tgtIdx:number}>, refTotal:number, targetIndexed:number}}
 */
export function matchAnchors(targetCues, refCues, { minSimilarity = DEFAULT_OPTIONS.minSimilarity } = {}) {
  const pairs = [];
  const exact = new Map();
  const buckets = new Map();
  const indexed = [];

  for (const cue of targetCues || []) {
    if (!isUsable(cue.text)) continue;
    const key = matchKey(cue.text);
    const list = exact.get(key);
    if (list) list.push(cue);
    else exact.set(key, [cue]);
    const sig = signature(key);
    const bucket = buckets.get(sig);
    if (bucket) bucket.push(cue);
    else buckets.set(sig, [cue]);
    indexed.push(cue);
  }

  let refTotal = 0;
  for (const ref of refCues || []) {
    if (!isUsable(ref.text)) continue;
    refTotal += 1;
    const key = matchKey(ref.text);

    const exactHits = exact.get(key);
    if (exactHits?.length) {
      for (const hit of exactHits) {
        pairs.push({ refStart: ref.start, tgtStart: hit.start, similarity: 1, refIdx: ref.index, tgtIdx: hit.index });
      }
      continue;
    }

    const candidates = buckets.get(signature(key)) || [];
    let best = null;
    for (const candidate of candidates) {
      const similarity = lineSimilarity(key, matchKey(candidate.text));
      if (similarity >= minSimilarity && (!best || similarity > best.similarity)) best = { similarity, cue: candidate };
    }
    if (best) {
      pairs.push({ refStart: ref.start, tgtStart: best.cue.start, similarity: best.similarity, refIdx: ref.index, tgtIdx: best.cue.index });
    }
  }

  return { pairs, refTotal, targetIndexed: indexed.length };
}

/**
 * Coarse offset from a delta histogram (250 ms bins), then a robust linear fit.
 * @param {Array<{refStart:number,tgtStart:number,similarity:number}>} pairs
 */
export function fitFromAnchors(pairs, opts = {}) {
  const { maxOffsetMs = DEFAULT_OPTIONS.maxOffsetMs, allowRate = DEFAULT_OPTIONS.allowRate, rateTolerance = DEFAULT_OPTIONS.rateTolerance } = opts;
  if (!pairs?.length) return null;
  const deltas = pairs.map((p) => p.refStart - p.tgtStart);
  const BIN = 250;
  const hist = new Map();
  for (const delta of deltas) {
    const bin = Math.round(delta / BIN) * BIN;
    hist.set(bin, (hist.get(bin) || 0) + 1);
  }
  let mode = 0;
  let modeCount = -1;
  for (const [bin, count] of hist) {
    if (count > modeCount || (count === modeCount && Math.abs(bin) < Math.abs(mode))) {
      mode = bin;
      modeCount = count;
    }
  }
  const inliers = pairs.filter((p) => Math.abs((p.refStart - p.tgtStart) - mode) <= BIN * 2);
  const fit = fitLinear(inliers.map((p) => ({ x: p.tgtStart, y: p.refStart })), { residualMs: 400 });
  let rate = fit.rate;
  if (!allowRate || !Number.isFinite(rate) || Math.abs(rate - 1) > Math.abs(rateTolerance - 1)) rate = 1;
  const offsetMs = rate === 1
    ? median(inliers.map((p) => p.refStart - p.tgtStart))
    : inliers.reduce((acc, p) => acc + (p.refStart - rate * p.tgtStart), 0) / inliers.length;

  const residuals = inliers.map((p) => p.refStart - (rate * p.tgtStart + offsetMs));
  return {
    rate,
    offsetMs: normalizeOffset(offsetMs, { minOffsetMs: -maxOffsetMs, maxOffsetMs }),
    inliers: inliers.length,
    modeCount,
    madMs: mad(residuals),
    deltaSpreadMs: Math.max(...deltas) - Math.min(...deltas),
  };
}

/**
 * Align `doc` against one reference document.
 * @returns {{ok:boolean, offsetMs:number, rate:number, confidence:number, samples:number, detail:object}}
 */
export function alignAgainstReference(doc, reference, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const targetCues = doc?.cues ?? [];
  const refCues = reference?.cues ?? [];
  if (targetCues.length < opts.minCues || refCues.length < opts.minCues) {
    return { ok: false, offsetMs: 0, rate: 1, confidence: 0, samples: 0, detail: { reason: 'not enough cues' } };
  }

  const { pairs, refTotal } = matchAnchors(targetCues, refCues, opts);
  const fit = pairs.length >= 2 ? fitFromAnchors(pairs, opts) : null;

  const anchorConfidence = fit
    ? clamp01(
      (Math.min(1, fit.inliers / Math.max(8, refTotal * 0.2)) * 0.55)
      + (1 - Math.min(1, (Number.isFinite(fit.madMs) ? fit.madMs : 500) / 400)) * 0.3
      + Math.min(1, fit.modeCount / Math.max(4, pairs.length)) * 0.15,
    )
    : 0;

  if (fit && fit.inliers >= opts.minAnchors && anchorConfidence >= 0.35) {
    return {
      ok: true,
      offsetMs: fit.offsetMs,
      rate: fit.rate,
      confidence: anchorConfidence,
      samples: fit.inliers,
      detail: { strategy: 'anchors', pairs: pairs.length, inliers: fit.inliers, madMs: fit.madMs, modeCount: fit.modeCount },
    };
  }

  // Fallback: dialogue-envelope correlation, works across languages.
  const hopMs = 20;
  const maskTarget = cuesToSpeechMask(targetCues, { hopMs });
  const maskRef = cuesToSpeechMask(refCues, { hopMs });
  const lag = bestMaskLag(maskRef.mask, maskTarget.mask, { hopMs, maxLagMs: opts.maxOffsetMs });
  const maskConfidence = clamp01(lag.confidence * 0.85) ;
  if (lag.score > 0.12 && maskConfidence > 0.2) {
    return {
      ok: true,
      offsetMs: normalizeOffset(roundTo(lag.lagMs, 100), { minOffsetMs: -opts.maxOffsetMs, maxOffsetMs: opts.maxOffsetMs }),
      rate: 1,
      confidence: maskConfidence,
      samples: targetCues.length,
      detail: { strategy: 'speech-mask', score: Number(lag.score.toFixed(4)), runnerUp: Number(lag.runnerUpScore.toFixed(4)), anchors: pairs.length },
    };
  }

  return {
    ok: false,
    offsetMs: fit?.offsetMs ?? 0,
    rate: 1,
    confidence: Math.max(anchorConfidence, maskConfidence),
    samples: fit?.inliers ?? 0,
    detail: { strategy: 'none', anchors: pairs.length, inliers: fit?.inliers ?? 0, maskScore: Number(lag.score.toFixed(4)) },
  };
}

/**
 * Try every reference, then decide by consensus.
 *
 * One reference is never enough to know *which* of two files is the wrong one, so a single
 * opinion is diluted below the apply threshold and reported as a suggestion instead. Two or
 * more independent references that agree are treated as ground truth (this is the same idea as
 * SubSync's "compare a subtitle with the other subtitles of the film"). Contradictory references
 * that tie are resolved in favour of changing nothing.
 *
 * @param {{doc:import('../../contracts.js').SubtitleDoc, references:import('../../contracts.js').SubtitleDoc[],
 *          options?:object, log?:Function}} req
 */
export function alignByText({ doc, references, options = {}, log }) {
  const say = log || (() => {});
  const toleranceMs = options.consensusToleranceMs ?? 400;
  const verdicts = [];
  let tried = 0;

  for (const reference of references || []) {
    if (!reference?.cues?.length) continue;
    tried += 1;
    const result = alignAgainstReference(doc, reference, options);
    if (result.ok) {
      verdicts.push({ ...result, referenceHint: reference.meta?.sourceLabel });
    }
  }

  const empty = {
    ok: false, offsetMs: 0, rate: 1, confidence: 0, samples: 0,
    detail: { strategy: 'none', tried, verdicts: verdicts.length },
  };
  if (!verdicts.length) return empty;

  const clusters = [];
  for (const verdict of verdicts) {
    const cluster = clusters.find((c) => Math.abs(c.offsetMs - verdict.offsetMs) <= toleranceMs);
    if (cluster) {
      cluster.members.push(verdict);
      cluster.weight += 0.25 + verdict.confidence;
    } else {
      clusters.push({ offsetMs: verdict.offsetMs, members: [verdict], weight: 0.25 + verdict.confidence });
    }
  }
  // Most agreement wins; an exact tie is resolved towards "leave the file alone".
  clusters.sort((a, b) => b.weight - a.weight || Math.abs(a.offsetMs) - Math.abs(b.offsetMs));

  const winner = clusters[0];
  const totalWeight = clusters.reduce((sum, c) => sum + c.weight, 0);
  const share = totalWeight > 0 ? winner.weight / totalWeight : 0;
  const best = winner.members.slice().sort((a, b) => b.confidence - a.confidence)[0];
  const rate = winner.members.every((m) => Math.abs(m.rate - best.rate) < 0.002) ? best.rate : 1;

  const margin = clusters.length > 1 ? winner.weight / Math.max(1e-6, clusters[1].weight) : Infinity;
  // A single independent opinion can never prove *which* of the two files is wrong, so it is
  // deliberately held below the auto-apply threshold and reported as a suggestion instead.
  const corroboration = verdicts.length >= 2 ? 1 : 0.4;
  const confidence = clamp01(best.confidence * (0.4 + 0.6 * share) * corroboration * (margin >= 1.5 ? 1 : 0.75));

  const detail = {
    strategy: best.detail.strategy,
    tried,
    references: verdicts.length,
    consensus: {
      votes: winner.members.length,
      share: Number(share.toFixed(3)),
      clusters: clusters.map((c) => ({ offsetMs: c.offsetMs, votes: c.members.length })),
      unanimous: clusters.length === 1 && winner.members.length === verdicts.length,
    },
    ms: best.detail.ms,
  };
  const referenceHint = winner.members.find((m) => m.referenceHint)?.referenceHint;

  if (confidence < (options.consensusFloor ?? 0.02)) {
    say('debug', `text alignment inconclusive (share ${share.toFixed(2)})`);
    return { ...empty, confidence, detail };
  }

  return {
    ok: true,
    offsetMs: winner.offsetMs,
    rate,
    confidence,
    samples: winner.members.reduce((sum, m) => sum + (m.samples || 0), 0),
    detail: { ...detail, referenceHint },
  };
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}
