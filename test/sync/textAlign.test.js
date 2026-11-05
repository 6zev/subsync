import test from 'node:test';
import assert from 'node:assert/strict';
import { alignAgainstReference, alignByText, matchAnchors, fitFromAnchors, matchKey } from '../../src/sync/textAlign.js';
import { applySyncResult } from '../../src/sync/index.js';
import { bestIntervalLag, maskToIntervals, intervalsOverlap } from '../../src/sync/correlate.js';

/** Build a deterministic synthetic subtitle with `count` dialogue cues. */
function makeDoc(count = 60, { start = 10_000, step = 3000, prefix = '' } = {}) {
  const cues = [];
  let t = start;
  for (let i = 0; i < count; i += 1) {
    const text = `${prefix}line number ${i} with some words ${i * 7}`;
    cues.push({ index: i, start: t, end: t + 1800, text, raw: text });
    t += step + (i % 5) * 120;
  }
  return { format: 'srt', cues, meta: {} };
}

/** t -> f(t) for every cue, i.e. the transform that produced the "wrong" file. */
function transform(doc, fn) {
  return { ...doc, cues: doc.cues.map((c, i) => ({ ...c, index: i, start: Math.round(fn(c.start)), end: Math.round(fn(c.end)) })) };
}

test('matchKey folds case, accents and punctuation', () => {
  assert.equal(matchKey('Hello,  World!'), 'hello world');
  assert.equal(matchKey('Chào Bạn!'), 'chao ban');
  assert.equal(matchKey('<i>Hello</i> {\\an8}there'), 'hello there');
});

test('recovers a pure offset', () => {
  const ref = makeDoc();
  // The target file runs 2.5 s late, so the correction must be -2500 ms.
  const target = transform(ref, (t) => t + 2500);
  const result = alignAgainstReference(target, ref);
  assert.equal(result.ok, true);
  assert.equal(result.offsetMs, -2500);
  assert.equal(result.rate, 1);
  assert.ok(result.confidence > 0.8, `confidence ${result.confidence}`);
  assert.equal(result.detail.strategy, 'anchors');
});

test('recovers an offset plus linear drift (rate)', () => {
  const ref = makeDoc();
  // The target is the reference pulled back: tgt = (ref - 2500) / 1.001
  const target = transform(ref, (t) => (t - 2500) / 1.001);
  const result = alignAgainstReference(target, ref);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.offsetMs - 2500) <= 120, `offset ${result.offsetMs}`);
  assert.ok(Math.abs(result.rate - 1.001) <= 0.0005, `rate ${result.rate}`);

  // Applying the result must land every cue back on the reference timing.
  const fixed = applySyncResult(target, result);
  const worst = Math.max(...fixed.cues.map((c, i) => Math.abs(c.start - ref.cues[i].start)));
  assert.ok(worst <= 120, `worst residual ${worst}ms`);
});

test('survives jittered cue times', () => {
  const ref = makeDoc();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 80;
  const target = transform(ref, (t) => t - 4200 + rnd());
  const result = alignAgainstReference(target, ref);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.offsetMs - 4200) <= 150, `offset ${result.offsetMs}`);
  assert.ok(result.confidence > 0.6, `confidence ${result.confidence}`);
});

test('falls back to the dialogue envelope when the text is a different language', () => {
  const ref = makeDoc(80);
  const target = transform({ ...ref, cues: ref.cues.map((c) => ({ ...c, text: `[vi] câu ${c.index} nội dung khác hẳn` })) }, (t) => t + 7000);
  const result = alignAgainstReference(target, ref);
  assert.equal(result.ok, true);
  assert.equal(result.detail.strategy, 'speech-mask');
  assert.ok(Math.abs(result.offsetMs + 7000) <= 300, `offset ${result.offsetMs}`);
  assert.equal(result.rate, 1);
});

test('refuses to answer on unrelated subtitles', () => {
  const a = makeDoc(40);
  const b = makeDoc(40, { start: 1_000_000, step: 900 });
  const result = alignAgainstReference(a, b);
  assert.equal(result.confidence < 0.6, true, `confidence ${result.confidence}`);
});

test('alignByText picks the best of several references', () => {
  const ref = makeDoc(60);
  const junk = makeDoc(60, { start: 900_000, step: 137, prefix: 'completely different dialogue ' });
  const target = transform(ref, (t) => t + 1500);
  const result = alignByText({ doc: target, references: [junk, ref] });
  assert.equal(result.ok, true);
  assert.equal(result.offsetMs, -1500);
  assert.equal(result.detail.tried, 2);
});

test('anchor matching tolerates near-identical lines', () => {
  const ref = makeDoc(30);
  const target = { ...ref, cues: ref.cues.map((c) => ({ ...c, text: c.text.replace('with some', 'with a few') })) };
  const { pairs } = matchAnchors(target.cues, ref.cues);
  assert.ok(pairs.length >= 20, `only ${pairs.length} pairs`);
});

test('fitFromAnchors rejects a single dominant wrong delta', () => {
  const pairs = [];
  for (let i = 0; i < 20; i += 1) pairs.push({ refStart: i * 3000 + 900, tgtStart: i * 3000, similarity: 1 });
  pairs.push({ refStart: 999_999, tgtStart: 0, similarity: 1 });
  const fit = fitFromAnchors(pairs);
  assert.equal(fit.inliers, 20);
  assert.equal(fit.offsetMs, 900);
});

test('interval lag search finds a synthetic shift', () => {
  // An irregular speech pattern: a periodic mask would be ambiguous by construction.
  let seed = 99;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const mask = new Uint8Array(900);
  let cursor = 0;
  while (cursor < 900) {
    const gap = 3 + Math.floor(rand() * 20);
    const run = 2 + Math.floor(rand() * 14);
    cursor += gap;
    for (let i = cursor; i < Math.min(900, cursor + run); i += 1) mask[i] = 1;
    cursor += run;
  }
  const shifted = new Uint8Array(900);
  shifted.set(mask.subarray(0, 850), 50);
  // `shifted` is `mask` delayed by 50 hops (+1000 ms), so the correction is -1000 ms.
  const result = bestIntervalLag(maskToIntervals(mask, 20), maskToIntervals(shifted, 20), { maxLagMs: 3000 });
  assert.ok(Math.abs(result.lagMs + 1000) <= 40, `lag ${result.lagMs}`);
  assert.ok(result.confidence > 0.3);
});

test('intervalsOverlap is exact on hand-built intervals', () => {
  const a = [{ s: 0, e: 1000 }, { s: 2000, e: 3000 }];
  const b = [{ s: 0, e: 500 }];
  assert.equal(intervalsOverlap(a, b, 0), 500);
  assert.equal(intervalsOverlap(a, b, 500), 500, 'b moved to [500,1000]');
  assert.equal(intervalsOverlap(a, b, -500), 0, 'b moved to [-500,0]');
  assert.equal(intervalsOverlap(a, b, 2000), 500, 'b lands on the second interval');
});

test('two corroborating references outrank a single one', () => {
  const refA = makeDoc(60);
  const refB = makeDoc(60);
  const target = transform(refA, (t) => t + 1800);
  const result = alignByText({ doc: target, references: [refA, refB] });
  assert.equal(result.ok, true);
  assert.equal(result.offsetMs, -1800);
  assert.equal(result.detail.consensus.unanimous, true);
  assert.equal(result.detail.consensus.votes, 2);
  assert.ok(result.confidence > 0.8, `confidence ${result.confidence}`);
});

test('a lone reference is diluted into a suggestion-level confidence', () => {
  const ref = makeDoc(60);
  const target = transform(ref, (t) => t + 1800);
  const one = alignByText({ doc: target, references: [ref] });
  const two = alignByText({ doc: target, references: [ref, makeDoc(60)] });
  assert.equal(one.ok, true);
  assert.equal(one.offsetMs, -1800);
  assert.ok(one.confidence < 0.45, `single-reference confidence must stay below the apply gate, got ${one.confidence}`);
  assert.ok(two.confidence > one.confidence);
});

test('contradictory references tie and the tie is resolved by changing nothing', () => {
  const base = makeDoc(60);
  const late = transform(base, (t) => t + 2500);
  // `late` is one file; two other files disagree about it, so no correction may be applied.
  const result = alignByText({ doc: base, references: [late, makeDoc(60)] });
  assert.equal(result.ok, true);
  assert.equal(result.offsetMs, 0, `expected the tie to keep the file unchanged, got ${result.offsetMs}`);
  assert.equal(result.detail.consensus.clusters.length, 2);
  assert.ok(result.confidence < 0.8, `a split decision must lower confidence, got ${result.confidence}`);
});

test('no usable reference yields ok:false, never a guess', () => {
  const result = alignByText({ doc: makeDoc(30), references: [] });
  assert.equal(result.ok, false);
  assert.equal(result.offsetMs, 0);
  assert.equal(result.confidence, 0);
});
