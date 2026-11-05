/**
 * Timestamp shifting: `newStart = round(oldStart * rate) + offsetMs`.
 * This is how an addon applies Nuvio's subtitle delay, because Stremio gives an addon no
 * way to set the player's own delay — we emit the file already shifted.
 * Contract: src/contracts.js §3. Owned by LEAD.
 */

/**
 * @param {import('../../contracts.js').Cue} cue
 * @param {{offsetMs?:number, rate?:number, minStartMs?:number}} opts
 * @returns {import('../../contracts.js').Cue|null} null when the cue falls out of the timeline
 */
export function shiftCue(cue, { offsetMs = 0, rate = 1, minStartMs = 0 } = {}) {
  const start = cue.start * rate + offsetMs;
  const end = cue.end * rate + offsetMs;
  if (end <= minStartMs) return null;
  const clampedStart = Math.max(minStartMs, Math.round(start));
  const clampedEnd = Math.max(clampedStart + 40, Math.round(end));
  return { ...cue, start: clampedStart, end: clampedEnd };
}

/**
 * @param {import('../../contracts.js').Cue[]} cues
 * @param {{offsetMs?:number, rate?:number, minStartMs?:number, keepEmpty?:boolean}} opts
 * @returns {import('../../contracts.js').Cue[]}
 */
export function shiftCues(cues, opts = {}) {
  const out = [];
  for (const cue of cues || []) {
    const shifted = shiftCue(cue, opts);
    if (shifted) out.push(shifted);
  }
  return out.map((cue, index) => ({ ...cue, index }));
}

/**
 * @param {import('../../contracts.js').SubtitleDoc} doc
 * @param {{offsetMs?:number, rate?:number, minStartMs?:number}} opts
 * @returns {import('../../contracts.js').SubtitleDoc}
 */
export function shiftDoc(doc, opts = {}) {
  return { ...doc, cues: shiftCues(doc?.cues, opts) };
}

/**
 * Nuvio's handling of a raw delay value: clamp into [-180000, 180000] and (for the manual
 * slider path) quantise to 100 ms.
 * @param {number} offsetMs
 * @param {{minOffsetMs?:number, maxOffsetMs?:number, stepMs?:number, quantize?:boolean}} [opts]
 * @returns {number}
 */
export function normalizeOffset(offsetMs, { minOffsetMs = -180000, maxOffsetMs = 180000, stepMs = 100, quantize = false } = {}) {
  let value = Number(offsetMs);
  if (!Number.isFinite(value)) return 0;
  value = Math.max(minOffsetMs, Math.min(maxOffsetMs, value));
  if (quantize && stepMs > 0) value = Math.round(value / stepMs) * stepMs;
  return Math.round(value);
}

/**
 * Nuvio's manual calibration formula: delay = capturePosition - cueStart - reactionCompensation.
 * @param {{videoPositionMs:number, cueStartMs:number, reactionCompensationMs?:number}} input
 */
export function offsetFromCapture({ videoPositionMs, cueStartMs, reactionCompensationMs = 300 }) {
  return normalizeOffset(Number(videoPositionMs) - Number(cueStartMs) - Number(reactionCompensationMs));
}

/** Average absolute correction applied, in ms — useful for logging/telemetry. */
export function meanShift(cues, opts = {}) {
  if (!cues?.length) return 0;
  let total = 0;
  for (const cue of cues) total += Math.abs(cue.start * (opts.rate ?? 1) + (opts.offsetMs ?? 0) - cue.start);
  return total / cues.length;
}
