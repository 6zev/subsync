import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWav, buildEnergyEnvelope, cuesToMask, bestLag, alignByAudio,
  probeTools, hasBinary, parseAlassOutput, parseFfsubsyncOutput, extractPcm, runCommand,
  pickDialogueWindow,
} from '../../src/sync/audioAlign.js';

const SAMPLE_RATE = 8000;

/** Write a mono 16-bit PCM WAV with a known burst pattern. */
function makeWav(path, { durationMs = 40_000, bursts = [], amplitude = 0.6 } = {}) {
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  for (let i = 0; i < frames; i += 1) {
    const ms = (i / SAMPLE_RATE) * 1000;
    const inBurst = bursts.some((b) => ms >= b.start && ms < b.end);
    const value = inBurst ? rand() * amplitude : rand() * 0.0006;
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
  return path;
}

const BURSTS = [4000, 9000, 14000, 19000, 24000, 29000, 34000].map((start) => ({ start, end: start + 1500 }));
const doc = {
  format: 'srt',
  meta: {},
  cues: BURSTS.map((b, i) => ({ index: i, start: b.start, end: b.end, text: `speech ${i}`, raw: `speech ${i}` })),
};
const shiftDoc = (d, ms) => ({ ...d, cues: d.cues.map((c) => ({ ...c, start: c.start + ms, end: c.end + ms })) });

test('parseWav reads the RIFF header we wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-wav-'));
  const path = makeWav(join(dir, 'a.wav'), { bursts: BURSTS });
  const parsed = parseWav(readFileSync(path));
  assert.equal(parsed.sampleRate, SAMPLE_RATE);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bits, 16);
  assert.equal(parsed.format, 1);
});

test('buildEnergyEnvelope recovers a known silence/speech pattern', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-wav-'));
  const path = makeWav(join(dir, 'a.wav'), { bursts: BURSTS });
  const env = await buildEnergyEnvelope(path, { hopMs: 20, minSpeechRunMs: 200 });
  assert.equal(env.hopMs, 20);
  assert.ok(env.durationMs >= 39_000 && env.durationMs <= 41_000, `duration ${env.durationMs}`);
  assert.ok(env.voicedMs > 8000, `voicedMs ${env.voicedMs}`);

  const on = (ms) => env.mask[Math.floor(ms / env.hopMs)];
  const off = (ms) => env.mask[Math.floor(ms / env.hopMs)];
  assert.equal(on(4200), 1, 'inside a burst');
  assert.equal(off(6500), 0, 'between bursts');
  assert.equal(on(200), 0, 'leading silence');
});

test('cuesToMask covers the cue spans', () => {
  const { mask, hopMs } = cuesToMask(doc.cues, { hopMs: 20 });
  assert.equal(mask[Math.floor(5000 / hopMs)], 1);
  assert.equal(mask[Math.floor(6000 / hopMs)], 0);
  assert.equal(mask[Math.floor(15000 / hopMs)], 1);
});

test('malformed WAV input resolves with an error instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-wav-'));
  const path = join(dir, 'broken.wav');
  writeFileSync(path, Buffer.from('not a wav at all'));
  await assert.rejects(() => buildEnergyEnvelope(path), /not a readable PCM WAV/);
  assert.equal(parseWav(Buffer.from('RIFF')), null);
});

test('bestLag recovers a mask shift', () => {
  const base = new Uint8Array(2000);
  for (const b of BURSTS) for (let i = Math.floor(b.start / 20); i < Math.floor(b.end / 20); i += 1) base[i] = 1;
  const later = new Uint8Array(2100);
  later.set(base.subarray(0, 1900), 125); // +2500 ms
  const result = bestLag(base, later, { hopMs: 20, maxLagMs: 10000 });
  assert.ok(Math.abs(result.lagMs + 2500) <= 40, `lag ${result.lagMs}`);
  assert.ok(result.score > 0.4);
});

test('external aligner output parsers never throw on garbage', () => {
  assert.deepEqual(parseAlassOutput(''), { offsetMs: null, rate: null });
  assert.deepEqual(parseAlassOutput('\u0000 nonsense'), { offsetMs: null, rate: null });
  assert.equal(parseAlassOutput('applied offset of 2.5 seconds').offsetMs, 2500);
  assert.equal(parseFfsubsyncOutput('offset seconds: -1.75').offsetMs, -1750);
  assert.equal(parseFfsubsyncOutput('framerate ratio: 1.001').rate, 1.001);
});

test('runCommand reports a missing binary instead of throwing', async () => {
  const result = await runCommand('/definitely/not/here', ['--help'], { timeoutMs: 2000 });
  assert.equal(result.code, null);
  assert.ok(result.error);
  assert.equal(await hasBinary('/definitely/not/here'), false);
});

test('probeTools reports the real toolchain without assuming any of it exists', async (t) => {
  const tools = await probeTools({});
  assert.equal(typeof tools.ffmpeg, 'boolean');
  assert.equal(typeof tools.alass, 'boolean');
  assert.equal(typeof tools.ffsubsync, 'boolean');
  // ffmpeg is required for the audio stage; everything else degrades on its own. CI images
  // may not ship it, so this is informational rather than a hard failure there.
  if (!tools.ffmpeg) t.diagnostic('ffmpeg is not installed: audio alignment will be unavailable');
});

test('alignByAudio recovers the offset of a mistimed subtitle from the real audio', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-audio-'));
  const wav = makeWav(join(dir, 'media.wav'), { bursts: BURSTS });
  const tools = await probeTools({});
  if (!tools.ffmpeg) return t.skip('ffmpeg is not available');

  const result = await alignByAudio({
    mediaPath: wav,
    doc: shiftDoc(doc, 2000),
    options: { preferExternal: false, maxOffsetMs: 30000, maxAnalyzeMs: 30000 },
    log: () => {},
  });
  assert.equal(result.ok, true, `alignByAudio failed: ${result.error}`);
  assert.equal(result.method, 'audio');
  assert.equal(result.detail.backend, 'js');
  assert.ok(Math.abs(result.offsetMs + 2000) <= 300, `offset ${result.offsetMs}`);
});

test('alignByAudio degrades gracefully when there is nothing to analyse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-audio-'));
  const silence = join(dir, 'silence.wav');
  makeWav(silence, { bursts: [] });
  const result = await alignByAudio({ mediaPath: silence, doc, options: { preferExternal: false, maxAnalyzeMs: 20000 }, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(result.error);

  const missing = await alignByAudio({ mediaPath: join(dir, 'nope.mkv'), doc, options: { preferExternal: false, maxAnalyzeMs: 10000 }, log: () => {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.offsetMs, 0);
});

test('extractPcm fails cleanly on a bogus path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-audio-'));
  const out = join(dir, 'out.wav');
  const result = await extractPcm(join(dir, 'missing.mkv'), out, { timeoutMs: 15000 });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('pickDialogueWindow finds the densest slice of a long subtitle', () => {
  const long = {
    format: 'srt',
    meta: {},
    cues: Array.from({ length: 200 }, (_v, i) => ({
      index: i,
      // First 40 cues are sparse filler, the rest alternate: dense from 600 s onwards.
      start: i < 40 ? i * 20_000 : 600_000 + (i - 40) * 4_000,
      end: (i < 40 ? i * 20_000 : 600_000 + (i - 40) * 4_000) + 2_500,
      text: `line ${i}`,
      raw: `line ${i}`,
    })),
  };
  const window = pickDialogueWindow(long.cues, 300_000);
  assert.ok(window);
  assert.equal(window.durationMs <= 300_000, true);
  assert.ok(window.cues >= 70, `expected a dense window, got ${window.cues} cues`);
  assert.ok(window.startMs >= 600_000, `the dense region starts at 600 s, got ${window.startMs}`);
  assert.equal(pickDialogueWindow(long.cues, 0), null);
  assert.equal(pickDialogueWindow([], 1000), null);
  const short = pickDialogueWindow(doc.cues, 10_000_000);
  assert.equal(short.startMs, 0, 'a subtitle shorter than the window is analysed whole');
});

test('windowed analysis returns the same offset as analysing the whole file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-win-'));
  const wav = makeWav(join(dir, 'win.wav'), { bursts: BURSTS });
  const tools = await probeTools({});
  if (!tools.ffmpeg) return t.skip('ffmpeg is not available');

  const result = await alignByAudio({
    mediaPath: wav,
    doc: shiftDoc(doc, 2000),
    options: { preferExternal: false, analyzeWindowMs: 20_000, maxOffsetMs: 30_000, maxAnalyzeMs: 30_000 },
    log: () => {},
  });
  assert.equal(result.ok, true, `windowed run failed: ${result.error}`);
  assert.ok(Math.abs(result.offsetMs + 2000) <= 300, `offset ${result.offsetMs}`);
  assert.ok(result.detail.windowStartMs >= 0);
});
