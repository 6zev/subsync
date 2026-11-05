import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftCue, shiftCues, shiftDoc, normalizeOffset, offsetFromCapture, meanShift } from '../../src/sync/shift.js';
import { parseSubtitles } from '../../src/sync/subtitles.js';

const cue = (start, end, text = 'x') => ({ index: 0, start, end, text, raw: text });

test('shiftCue applies newStart = round(oldStart * rate) + offset', () => {
  assert.deepEqual(pick(shiftCue(cue(1000, 2000), { offsetMs: 500 })), [1500, 2500]);
  assert.deepEqual(pick(shiftCue(cue(1000, 2000), { rate: 2 })), [2000, 4000]);
  assert.deepEqual(pick(shiftCue(cue(1000, 2000), { rate: 1.001, offsetMs: -250 })), [751, 1752]);
});

test('shiftCue clamps into the timeline and drops what falls off it', () => {
  assert.deepEqual(pick(shiftCue(cue(1000, 2000), { offsetMs: -1500 })), [0, 500]);
  assert.equal(shiftCue(cue(1000, 2000), { offsetMs: -3000 }), null, 'both ends fell off the timeline');
  const kept = shiftCues([cue(1000, 2000), cue(100, 200)], { offsetMs: -1000 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].index, 0);
});

test('shiftDoc does not mutate the source document', () => {
  const doc = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  const shifted = shiftDoc(doc, { offsetMs: 1000 });
  assert.equal(doc.cues[0].start, 1000);
  assert.equal(shifted.cues[0].start, 2000);
});

test('normalizeOffset matches Nuvio clamping, quantising only on request', () => {
  assert.equal(normalizeOffset(12_345), 12_345);
  assert.equal(normalizeOffset(999_999), 180_000);
  assert.equal(normalizeOffset(-999_999), -180_000);
  assert.equal(normalizeOffset(12_349, { quantize: true }), 12_300);
  assert.equal(normalizeOffset(12_350, { quantize: true }), 12_400);
  assert.equal(normalizeOffset(Number.NaN), 0);
});

test('offsetFromCapture reproduces Nuvio\'s 300 ms reaction compensation', () => {
  // A cue that starts at 10000 ms, heard when the player clock reads 11500 ms.
  assert.equal(offsetFromCapture({ videoPositionMs: 11_500, cueStartMs: 10_000 }), 1_200);
  assert.equal(offsetFromCapture({ videoPositionMs: 11_500, cueStartMs: 10_000, reactionCompensationMs: 0 }), 1_500);
  assert.equal(offsetFromCapture({ videoPositionMs: 10_000, cueStartMs: 30_000 }), -20_300);
});

test('meanShift reports the average correction', () => {
  const cues = [cue(0, 100), cue(1000, 1100)];
  assert.equal(meanShift(cues, { offsetMs: 100 }), 100);
  assert.equal(meanShift(cues, { rate: 2 }), 500);
});

function pick(shiftedCue) {
  return [shiftedCue.start, shiftedCue.end];
}
