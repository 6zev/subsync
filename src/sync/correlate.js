/**
 * Interval-based lag search shared by the text and audio aligners.
 *
 * Both aligners reduce their input to a set of "something is happening here" intervals
 * (dialogue for a subtitle, speech for an audio envelope) and then ask: what time shift
 * makes the two sets overlap best?
 *
 * Complexity: for each candidate lag we merge two sorted interval lists on a two-pointer
 * walk, i.e. O(|A| + |B|) per lag. A 2-hour movie has ~1500 speech runs, and the coarse
 * scan covers ±180 s in 100 ms steps (3601 lags) -> ~11 M cheap integer ops, a few tens of
 * milliseconds. The winner is then refined at 20 ms resolution.
 *
 * Owned by LEAD.
 */

/**
 * @param {Uint8Array} mask
 * @param {number} hopMs
 * @returns {Array<{s:number,e:number}>} merged intervals in milliseconds
 */
export function maskToIntervals(mask, hopMs) {
  const out = [];
  let start = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push({ s: start * hopMs, e: i * hopMs });
      start = -1;
    }
  }
  if (start >= 0) out.push({ s: start * hopMs, e: mask.length * hopMs });
  return out;
}

/** Total covered milliseconds. */
export function intervalsDuration(intervals) {
  let total = 0;
  for (const iv of intervals) total += iv.e - iv.s;
  return total;
}

/**
 * Overlap between two interval lists, where `b` has already been shifted by `lagMs`.
 * @param {Array<{s:number,e:number}>} a
 * @param {Array<{s:number,e:number}>} b
 * @param {number} lagMs
 * @returns {number}
 */
export function intervalsOverlap(a, b, lagMs) {
  let i = 0;
  let j = 0;
  let overlap = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].s, b[j].s + lagMs);
    const e = Math.min(a[i].e, b[j].e + lagMs);
    if (e > s) overlap += e - s;
    if (a[i].e < b[j].e + lagMs) i += 1;
    else j += 1;
  }
  return overlap;
}

/**
 * Find the shift applied to `b` that best matches `a`.
 *
 * `lagMs > 0` means b must move later in time (its content belongs later), i.e. the
 * subtitle's own cues need `+lagMs`.
 *
 * @param {Array<{s:number,e:number}>} a reference intervals
 * @param {Array<{s:number,e:number}>} b intervals to be shifted
 * @param {{maxLagMs?:number, coarseStepMs?:number, refineStepMs?:number, minScore?:number}} [opts]
 * @returns {{lagMs:number, score:number, confidence:number, runnerUpScore:number, scanned:number}}
 */
export function bestIntervalLag(a, b, { maxLagMs = 180000, coarseStepMs = 100, refineStepMs = 20 } = {}) {
  const empty = { lagMs: 0, score: 0, confidence: 0, runnerUpScore: 0, scanned: 0 };
  if (!a.length || !b.length) return empty;

  const durA = intervalsDuration(a);
  const durB = intervalsDuration(b);
  const scan = (from, to, step) => {
    let best = { lag: from, score: -1 };
    let second = -1;
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let lag = from; lag <= to; lag += step) {
      const overlap = intervalsOverlap(a, b, lag);
      const union = durA + durB - overlap;
      const score = union > 0 ? overlap / union : 0;
      if (score > best.score) {
        second = best.score;
        best = { lag, score };
      } else if (score > second) {
        second = score;
      }
      sum += score;
      sumSq += score * score;
      n += 1;
    }
    const mean = n ? sum / n : 0;
    const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
    return { best, second, mean, stddev: Math.sqrt(variance), n };
  };

  const coarse = scan(-maxLagMs, maxLagMs, coarseStepMs);
  const fineFrom = Math.max(-maxLagMs, coarse.best.lag - coarseStepMs);
  const fineTo = Math.min(maxLagMs, coarse.best.lag + coarseStepMs);
  const fine = refineStepMs > 0 && refineStepMs < coarseStepMs
    ? scan(fineFrom, fineTo, refineStepMs)
    : { best: coarse.best };

  const lagMs = fine.best.lag;
  const score = fine.best.score;

  // Confidence blends two independent signals: how far the winner stands above the scan's own
  // noise floor, and how good the absolute overlap is. Both are needed — a periodic/ambiguous
  // mask can produce a huge z on a poor absolute score, and a good score on a noisy curve is
  // not trustworthy either.
  const z = coarse.stddev > 1e-6 ? (score - coarse.mean) / coarse.stddev : 0;
  const peakMargin = score > 0 ? (score - Math.max(0, coarse.second)) / score : 0;
  // The absolute overlap dominates: on real (aperiodic) dialogue a Jaccard this high already
  // means the two timelines are the same, whereas prominence alone punishes long, dense
  // subtitles whose self-similarity creates harmless alias peaks.
  const prominence = clamp01(1 - Math.exp(-Math.max(0, z) / 2.0));
  const absolute = clamp01(score * 1.15);
  const margin = clamp01(0.7 + peakMargin * 0.6);
  const confidence = clamp01((prominence * 0.3 + absolute * 0.7) * margin);

  return {
    lagMs,
    score,
    confidence,
    runnerUpScore: Math.max(0, coarse.second),
    scanned: coarse.n + (fine.n ?? 0),
  };
}

/** Convenience wrapper over two binary masks. */
export function bestMaskLag(maskA, maskB, { hopMs = 20, maxLagMs = 180000, coarseStepMs = 100, refineStepMs = 20 } = {}) {
  return bestIntervalLag(maskToIntervals(maskA, hopMs), maskToIntervals(maskB, hopMs), {
    maxLagMs, coarseStepMs, refineStepMs,
  });
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * Least-squares fit of `y = rate * x + offset` with robust outlier rejection.
 * @param {Array<{x:number,y:number}>} points
 * @param {{residualMs?:number, iterations?:number}} [opts]
 * @returns {{rate:number, offsetMs:number, inliers:number, total:number, madMs:number}}
 */
export function fitLinear(points, { residualMs = 400, iterations = 3 } = {}) {
  let active = points.slice();
  let rate = 1;
  let offset = 0;
  let mad = NaN;
  for (let pass = 0; pass < iterations; pass += 1) {
    if (active.length < 2) {
      if (active.length === 1) { rate = 1; offset = active[0].y - active[0].x; }
      break;
    }
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (const p of active) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
    const n = active.length;
    const denom = n * sxx - sx * sx;
    rate = Math.abs(denom) > 1e-6 ? (n * sxy - sx * sy) / denom : 1;
    offset = (sy - rate * sx) / n;
    const residuals = active.map((p) => Math.abs(p.y - (rate * p.x + offset)));
    const sorted = residuals.slice().sort((a, b) => a - b);
    mad = sorted.length ? sorted[sorted.length >> 1] : NaN;
    const kept = active.filter((p) => Math.abs(p.y - (rate * p.x + offset)) <= residualMs);
    if (kept.length === active.length) break;
    if (kept.length < 2) break;
    active = kept;
  }
  return { rate, offsetMs: offset, inliers: active.length, total: points.length, madMs: mad };
}
