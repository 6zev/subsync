/**
 * End-to-end proof of the audio path: a real video file, real ffmpeg, real correlation.
 * Skipped automatically when ffmpeg is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeTools, runCommand } from '../../src/sync/audioAlign.js';
import { syncSubtitle } from '../../src/sync/index.js';

const SAMPLE_RATE = 16000;
const BURSTS = [
  [2, 3.2], [5, 6.2], [8, 9.2], [11, 12.2], [14, 15.2], [17, 18.2], [20, 21.2],
  [23, 24.2], [26, 27.2], [29, 30.2], [32, 33.2], [35, 36.2], [37.5, 38.7],
];
const TRUE_SHIFT_MS = 4000;

function writeWav(path, durationMs = 40_000) {
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  for (let i = 0; i < frames; i += 1) {
    const ms = (i / SAMPLE_RATE) * 1000;
    const inside = BURSTS.some(([a, b]) => ms >= a * 1000 && ms < b * 1000);
    const value = inside ? rand() * 0.5 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 2.5 * (ms / 1000))) : rand() * 0.0005;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** The subtitle as it would be downloaded: correct timing shifted by TRUE_SHIFT_MS. */
const lateDoc = {
  format: 'srt',
  meta: {},
  cues: BURSTS.map(([a, b], i) => ({
    index: i,
    start: a * 1000 + TRUE_SHIFT_MS,
    end: b * 1000 + TRUE_SHIFT_MS,
    text: `speech line ${i}`,
    raw: `speech line ${i}`,
  })),
};

let mediaPath = null;
let available = false;

test.before(async () => {
  const tools = await probeTools({});
  if (!tools.ffmpeg) return;
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-media-'));
  const wav = join(dir, 'audio.wav');
  mediaPath = join(dir, 'movie.mkv');
  writeWav(wav);
  const made = await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=5:d=40',
    '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', mediaPath,
  ], { timeoutMs: 120000 });
  available = made.code === 0;
});

test('the full audio pipeline recovers a 4 s mistiming from a real video file', async (t) => {
  if (!available) return t.skip('ffmpeg is unavailable in this environment');

  const result = await syncSubtitle({
    doc: lateDoc,
    target: { filename: 'movie.mkv' },
    references: [],
    audio: { enabled: true, mediaPath },
    options: { preferExternalAligners: false, maxAnalyzeMs: 60000 },
    log: () => {},
  });

  assert.equal(result.ok, true, `audio sync failed: ${result.error}`);
  assert.equal(result.method, 'audio');
  assert.equal(result.detail.backend, 'js');
  assert.ok(Math.abs(result.offsetMs + TRUE_SHIFT_MS) <= 300, `offset ${result.offsetMs}`);
  assert.ok(result.confidence > 0.3, `confidence ${result.confidence}`);
});

test('the ladder can be pinned to the audio stage only', async (t) => {
  if (!available) return t.skip('ffmpeg is unavailable in this environment');
  const ref = { ...lateDoc, cues: lateDoc.cues.map((c) => ({ ...c, start: c.start - TRUE_SHIFT_MS, end: c.end - TRUE_SHIFT_MS })) };
  const result = await syncSubtitle({
    doc: lateDoc,
    target: { filename: 'movie.mkv' },
    references: [ref],
    audio: { enabled: true, mediaPath },
    options: { onlyMethods: ['audio'], preferExternalAligners: false, maxAnalyzeMs: 60000 },
    log: () => {},
  });
  assert.equal(result.method, 'audio', 'the text stage must be skipped when it is pinned out');
  assert.ok(Math.abs(result.offsetMs + TRUE_SHIFT_MS) <= 300);
});

test('the text stage alone is not allowed to invent an offset without corroboration', async () => {
  const ref = { ...lateDoc, cues: lateDoc.cues.map((c) => ({ ...c, start: c.start - TRUE_SHIFT_MS, end: c.end - TRUE_SHIFT_MS })) };
  const result = await syncSubtitle({
    doc: lateDoc,
    target: { filename: 'movie.mkv' },
    references: [ref],
    options: {},
    log: () => {},
  });
  assert.equal(result.ok, false, 'a single reference must not be applied automatically');
  assert.equal(result.suggestion.offsetMs, -TRUE_SHIFT_MS);
  assert.ok(result.suggestion.confidence < 0.45);
});

test('with two agreeing references the same subtitle is corrected automatically', async () => {
  const ref = { ...lateDoc, cues: lateDoc.cues.map((c) => ({ ...c, start: c.start - TRUE_SHIFT_MS, end: c.end - TRUE_SHIFT_MS })) };
  const result = await syncSubtitle({
    doc: lateDoc,
    target: { filename: 'movie.mkv' },
    references: [ref, ref],
    options: {},
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'text');
  assert.equal(result.offsetMs, -TRUE_SHIFT_MS);
  assert.ok(result.confidence > 0.8);
});
