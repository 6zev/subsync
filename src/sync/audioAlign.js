/**
 * Audio alignment: pull the real audio track with ffmpeg, reduce it to a speech envelope and
 * correlate that against the subtitle's dialogue envelope. ffsubsync / alass are used as
 * higher-quality backends when they are installed, and the pure-JS path is the fallback.
 *
 * This is the addon's substitute for Nuvio's live player clock. Owned by LEAD.
 * Contract: src/contracts.js §3.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cuesToSpeechMask, serializeSubtitles, parseSubtitles } from './subtitles.js';
import { bestMaskLag } from './correlate.js';
import { normalizeOffset } from './shift.js';
import { median } from '../util/text.js';

/* ── process helpers ───────────────────────────────────────────────────── */

/**
 * Run a command, capture stdout/stderr, enforce a timeout.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error?:string}>}
 */
export function runCommand(command, args, { timeoutMs = 60000, log } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      log?.('warn', `${command} killed after ${timeoutMs}ms`);
      finish({ code: null, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** @returns {Promise<boolean>} true when the binary is executable */
export async function hasBinary(name, args = ['-version']) {
  if (!name) return false;
  const probe = name.includes('/')
    ? await runCommand(name, args, { timeoutMs: 8000 })
    : await runCommand('/bin/sh', ['-c', `command -v ${shellQuote(name)} >/dev/null 2>&1 && ${shellQuote(name)} ${args.map(shellQuote).join(' ')}`], { timeoutMs: 8000 });
  return probe.code === 0;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/** @returns {Promise<{ffmpeg:boolean, ffprobe:boolean, alass:boolean, ffsubsync:boolean}>} */
export async function probeTools({ ffmpegPath = 'ffmpeg', alassPath = 'alass', ffsubsyncPath = 'ffsubsync' } = {}) {
  const [ffmpeg, alass, ffsubsync] = await Promise.all([
    hasBinary(ffmpegPath),
    hasBinary(alassPath, ['--help']),
    hasBinary(ffsubsyncPath, ['--help']),
  ]);
  return { ffmpeg, alass, ffsubsync };
}

/* ── pcm extraction ────────────────────────────────────────────────────── */

/**
 * @param {string} mediaPath local path or direct URL
 * @param {string} outWavPath
 * @param {{ffmpegPath?:string, startMs?:number, durationMs?:number, sampleRate?:number, timeoutMs?:number, headers?:object}} [opts]
 */
export async function extractPcm(mediaPath, outWavPath, opts = {}) {
  const {
    ffmpegPath = 'ffmpeg', startMs = 0, durationMs = 0, sampleRate = 8000, timeoutMs = 120000,
  } = opts;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (startMs > 0) args.push('-ss', String(startMs / 1000));
  if (headersToArgs(opts.headers)) args.push(...headersToArgs(opts.headers));
  args.push('-i', mediaPath);
  if (durationMs > 0) args.push('-t', String(durationMs / 1000));
  args.push('-vn', '-ac', '1', '-ar', String(sampleRate), '-acodec', 'pcm_s16le', '-f', 'wav', outWavPath);
  const result = await runCommand(ffmpegPath, args, { timeoutMs });
  if (result.code !== 0) {
    return { ok: false, wavPath: outWavPath, error: (result.stderr || result.error || 'ffmpeg failed').slice(0, 500) };
  }
  try {
    const info = await stat(outWavPath);
    if (!info.size) return { ok: false, wavPath: outWavPath, error: 'ffmpeg produced an empty file' };
  } catch (err) {
    return { ok: false, wavPath: outWavPath, error: `cannot stat output: ${err.message}` };
  }
  return { ok: true, wavPath: outWavPath };
}

function headersToArgs(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return lines ? ['-headers', `${lines}\r\n`] : null;
}

/* ── wav parsing + envelope ────────────────────────────────────────────── */

/**
 * Minimal RIFF/WAVE reader (PCM 8/16/24/32-bit integer and 32-bit float).
 * @param {Buffer} buf
 * @returns {{sampleRate:number, channels:number, bits:number, format:number, data:Buffer}|null}
 */
export function parseWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { ...fmt, data };
}

/**
 * RMS envelope + adaptive-threshold speech mask.
 * @param {string|Buffer} wav input path or raw buffer
 * @param {{hopMs?:number, vadThresholdRatio?:number, minSpeechRunMs?:number, silenceFloor?:number}} [opts]
 * @returns {Promise<{hopMs:number, durationMs:number, rms:Float32Array, mask:Uint8Array, voicedMs:number}>}
 */
export async function buildEnergyEnvelope(wav, opts = {}) {
  const { hopMs = 20, vadThresholdRatio = 2.2, minSpeechRunMs = 120 } = opts;
  const buf = Buffer.isBuffer(wav) ? wav : await readFile(wav);
  const parsed = parseWav(buf);
  if (!parsed) throw new Error('not a readable PCM WAV file');
  const { sampleRate, channels, bits, format, data } = parsed;
  const bytesPerSample = bits / 8;
  const frameBytes = bytesPerSample * channels;
  if (!frameBytes) throw new Error('invalid WAV frame size');

  const frameCount = Math.floor(data.length / frameBytes);
  const samplesPerHop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const hopCount = Math.max(1, Math.ceil(frameCount / samplesPerHop));
  const rms = new Float32Array(hopCount);

  const readSample = makeSampleReader(format, bits, bytesPerSample);

  for (let hop = 0; hop < hopCount; hop += 1) {
    const from = hop * samplesPerHop;
    const to = Math.min(frameCount, from + samplesPerHop);
    let sum = 0;
    let n = 0;
    for (let frame = from; frame < to; frame += 1) {
      const base = frame * frameBytes;
      let acc = 0;
      for (let ch = 0; ch < channels; ch += 1) acc += readSample(data, base + ch * bytesPerSample);
      const value = acc / channels;
      sum += value * value;
      n += 1;
    }
    rms[hop] = n ? Math.sqrt(sum / n) : 0;
  }

  const sorted = Float32Array.from(rms).sort();
  const med = sorted.length ? sorted[sorted.length >> 1] : 0;
  const threshold = Math.max(med * vadThresholdRatio, 0.004);
  const raw = new Uint8Array(hopCount);
  for (let i = 0; i < hopCount; i += 1) raw[i] = rms[i] > threshold ? 1 : 0;

  const minRunHops = Math.max(1, Math.round(minSpeechRunMs / hopMs));
  const mask = closeAndFilter(raw, minRunHops);
  let voicedMs = 0;
  for (const value of mask) voicedMs += value ? hopMs : 0;

  return { hopMs, durationMs: hopCount * hopMs, rms, mask, voicedMs };
}

function makeSampleReader(format, bits, bytesPerSample) {
  if (format === 1) {
    if (bits === 8) return (buf, i) => (buf[i] - 128) / 128;
    if (bits === 16) return (buf, i) => buf.readInt16LE(i) / 32768;
    if (bits === 24) return (buf, i) => ((buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) << 8 >> 8) / 8388608;
    if (bits === 32) return (buf, i) => buf.readInt32LE(i) / 2147483648;
  } else if (format === 3 && bits === 32) {
    return (buf, i) => buf.readFloatLE(i);
  }
  throw new Error(`unsupported WAV format ${format}/${bits}bit`);
}

/** Fill gaps shorter than minRun, then drop speech runs shorter than minRun. */
function closeAndFilter(mask, minRunHops) {
  const out = Uint8Array.from(mask);
  let i = 0;
  while (i < out.length) {
    if (out[i]) { i += 1; continue; }
    let j = i;
    while (j < out.length && !out[j]) j += 1;
    if (i > 0 && j < out.length && j - i < minRunHops) {
      for (let k = i; k < j; k += 1) out[k] = 1;
    }
    i = j;
  }
  i = 0;
  while (i < out.length) {
    if (!out[i]) { i += 1; continue; }
    let j = i;
    while (j < out.length && out[j]) j += 1;
    if (j - i < minRunHops) {
      for (let k = i; k < j; k += 1) out[k] = 0;
    }
    i = j;
  }
  return out;
}

/**
 * Pick the densest dialogue window of a subtitle, so long media only needs a slice analysed.
 * @param {import('../../contracts.js').Cue[]} cues
 * @param {number} windowMs desired window length
 * @returns {{startMs:number, durationMs:number, cues:number}|null}
 */
export function pickDialogueWindow(cues, windowMs) {
  const list = (cues || []).filter((c) => Number.isFinite(c.start) && c.end > c.start);
  if (!list.length || !(windowMs > 0)) return null;
  const span = list[list.length - 1].end - list[0].start;
  if (span <= windowMs) return { startMs: 0, durationMs: Math.ceil(list[list.length - 1].end), cues: list.length };

  let best = null;
  let left = 0;
  for (let right = 0; right < list.length; right += 1) {
    while (list[right].end - list[left].start > windowMs) left += 1;
    const count = right - left + 1;
    if (!best || count > best.cues) {
      const startMs = Math.max(0, Math.floor(list[left].start));
      best = {
        startMs,
        durationMs: Math.min(Math.ceil(list[right].end) - startMs, windowMs),
        cues: count,
      };
    }
  }
  return best;
}

/** Subtitle dialogue -> speech mask (alias kept for a stable public surface). */
export function cuesToMask(cues, opts = {}) {
  return cuesToSpeechMask(cues, opts);
}

/** Lag search between two binary masks. */
export function bestLag(maskA, maskB, { hopMs = 20, maxLagMs = 180000 } = {}) {
  const result = bestMaskLag(maskA, maskB, { hopMs, maxLagMs });
  return { lagMs: result.lagMs, confidence: result.confidence, score: result.score };
}

/* ── external backends ─────────────────────────────────────────────────── */

/** Parse alass progress output, which reports the applied shift in seconds. */
export function parseAlassOutput(text) {
  const raw = String(text ?? '');
  let offsetMs = null;
  const shift = raw.match(/offset[^-\d]*(-?\d+(?:\.\d+)?)\s*(?:s|sec|seconds)/i);
  if (shift) offsetMs = Math.round(Number(shift[1]) * 1000);
  const delta = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\s*(?:offset|shift)/i);
  if (offsetMs === null && delta) offsetMs = Math.round(Number(delta[1]) * 1000);
  let rate = null;
  const sp = raw.match(/speed[^-\d]*(-?\d+(?:\.\d+)?)/i);
  if (sp) rate = Number(sp[1]);
  return { offsetMs, rate };
}

/** ffsubsync logs the detected offset in seconds. */
export function parseFfsubsyncOutput(text) {
  const raw = String(text ?? '');
  let offsetMs = null;
  const m = raw.match(/offset\s+seconds?:\s*(-?\d+(?:\.\d+)?)/i);
  if (m) offsetMs = Math.round(Number(m[1]) * 1000);
  const m2 = raw.match(/(-?\d+(?:\.\d+)?)\s*seconds?\s*(?:of\s*)?(?:offset|shift)/i);
  if (offsetMs === null && m2) offsetMs = Math.round(Number(m2[1]) * 1000);
  let rate = null;
  const s = raw.match(/framerate\s*ratio:\s*(\d+(?:\.\d+)?)/i) || raw.match(/sync\s*ratio:\s*(\d+(?:\.\d+)?)/i);
  if (s) rate = Number(s[1]);
  return { offsetMs, rate };
}

/** Derive (offset, rate) by comparing an aligned subtitle file against the original. */
export async function measureShift(originalDoc, alignedPath) {
  const text = await readFile(alignedPath, 'utf8');
  const aligned = parseSubtitles(text);
  const n = Math.min(originalDoc.cues.length, aligned.cues.length, 60);
  if (!n) return { offsetMs: null, rate: null };
  const deltas = [];
  for (let i = 0; i < n; i += 1) deltas.push(aligned.cues[i].start - originalDoc.cues[i].start);
  const first = deltas[0];
  const last = deltas[n - 1];
  const spanMs = originalDoc.cues[n - 1].start - originalDoc.cues[0].start;
  const rate = spanMs > 60000 ? 1 + (last - first) / spanMs : 1;
  const offsetMs = Math.round(median(deltas));
  return { offsetMs, rate: Math.abs(rate - 1) < 0.0005 ? 1 : rate };
}

/** @returns {Promise<{ok:boolean, offsetMs:number|null, rate:number|null, raw:string, error?:string}>} */
export async function runAlass({ referencePath, incorrectPath, outputPath, alassPath = 'alass', timeoutMs = 120000 } = {}) {
  const result = await runCommand(alassPath, [referencePath, incorrectPath, outputPath], { timeoutMs });
  if (result.code !== 0) {
    return { ok: false, offsetMs: null, rate: null, raw: `${result.stdout}\n${result.stderr}`, error: result.error || `alass exited ${result.code}` };
  }
  const parsed = parseAlassOutput(`${result.stdout}\n${result.stderr}`);
  const measured = await measureShift(parseSubtitles(await readFile(incorrectPath, 'utf8')), outputPath).catch(() => ({ offsetMs: null, rate: null }));
  return {
    ok: true,
    offsetMs: parsed.offsetMs ?? measured.offsetMs,
    rate: parsed.rate ?? measured.rate,
    raw: `${result.stdout}\n${result.stderr}`.slice(0, 4000),
  };
}

/** @returns {Promise<{ok:boolean, offsetMs:number|null, rate:number|null, raw:string, error?:string}>} */
export async function runFfsubsync({ mediaPath, subPath, outputPath, ffsubsyncPath = 'ffsubsync', timeoutMs = 180000 } = {}) {
  const result = await runCommand(ffsubsyncPath, [mediaPath, '-i', subPath, '-o', outputPath], { timeoutMs });
  if (result.code !== 0) {
    return { ok: false, offsetMs: null, rate: null, raw: `${result.stdout}\n${result.stderr}`.slice(0, 2000), error: result.error || `ffsubsync exited ${result.code}` };
  }
  const parsed = parseFfsubsyncOutput(`${result.stdout}\n${result.stderr}`);
  const measured = await measureShift(parseSubtitles(await readFile(subPath, 'utf8')), outputPath).catch(() => ({ offsetMs: null, rate: null }));
  return {
    ok: true,
    offsetMs: parsed.offsetMs ?? measured.offsetMs,
    rate: parsed.rate ?? measured.rate,
    raw: `${result.stdout}\n${result.stderr}`.slice(0, 4000),
  };
}

/* ── orchestrator ──────────────────────────────────────────────────────── */

/**
 * Align a subtitle against the video's audio track.
 * @param {{mediaPath:string, doc:import('../../contracts.js').SubtitleDoc,
 *          options?:{ffmpegPath?:string, alassPath?:string, ffsubsyncPath?:string,
 *                     maxOffsetMs?:number, maxAnalyzeMs?:number, preferExternal?:boolean,
 *                     headers?:object, referencePath?:string, startMs?:number, durationMs?:number},
 *          log?:Function}} req
 * @returns {Promise<import('../../contracts.js').SyncResult>}
 */
export async function alignByAudio({ mediaPath, doc, options = {}, log } = {}) {
  const say = log || (() => {});
  const maxOffsetMs = options.maxOffsetMs ?? 180000;
  const maxLagMs = maxOffsetMs;
  const failure = (error, detail) => ({ ok: false, method: 'audio', offsetMs: 0, rate: 1, confidence: 0, error, detail });

  if (!mediaPath) return failure('no media source resolved');
  if (!doc?.cues?.length) return failure('subtitle has no cues');

  const preferExternal = options.preferExternal ?? options.preferExternalAligners ?? true;
  const tools = preferExternal
    ? await probeTools(options)
    : { ffmpeg: true, alass: false, ffsubsync: false };

  // 1. alass with a reference subtitle: cheapest and most precise when a reference exists.
  if (tools.alass && options.referencePath) {
    const dir = await mkdtemp(join(tmpdir(), 'nuvio-alass-'));
    try {
      const incorrect = join(dir, 'input.srt');
      const output = join(dir, 'output.srt');
      await writeFile(incorrect, serializeSubtitles(doc, 'srt'));
      const result = await runAlass({ referencePath: options.referencePath, incorrectPath: incorrect, outputPath: output, alassPath: options.alassPath, timeoutMs: options.maxAnalyzeMs ?? 120000 });
      if (result.ok && result.offsetMs !== null) {
        say('info', `alass aligned: ${result.offsetMs}ms`);
        return { ok: true, method: 'audio', offsetMs: normalizeOffset(result.offsetMs, { minOffsetMs: -maxOffsetMs, maxOffsetMs }), rate: result.rate || 1, confidence: 0.9, samples: doc.cues.length, detail: { backend: 'alass' } };
      }
      say('debug', `alass unusable: ${result.error}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 2. Our own correlation: the subtitle's exact dialogue pattern against the audio envelope.
  //    It is fast (no extra process) and tightly constrained by the cue boundaries, so it is the
  //    primary path; the slower general-purpose aligners are only consulted when it is unsure.
  let jsResult = null;
  if (tools.ffmpeg) {
    const dir = await mkdtemp(join(tmpdir(), 'nuvio-audio-'));
    try {
      // Long or remote media: analyse one dense dialogue window instead of the whole file.
      // ffmpeg has to pull the bytes it decodes, so this is the difference between a few MB
      // and a full 4 GB movie download.
      let analysisStartMs = options.startMs ?? 0;
      let analysisDurationMs = options.durationMs ?? 0;
      let analysedCues = doc.cues;
      const windowMs = Number(options.analyzeWindowMs) || 0;
      if (windowMs > 0 && !analysisDurationMs) {
        const window = pickDialogueWindow(doc.cues, windowMs);
        if (window) {
          analysisStartMs = window.startMs;
          analysisDurationMs = window.durationMs;
          analysedCues = doc.cues
            .filter((cue) => cue.end > window.startMs && cue.start < window.startMs + window.durationMs)
            .map((cue) => ({ ...cue, start: cue.start - window.startMs, end: cue.end - window.startMs }));
          say('debug', `analysing a ${(window.durationMs / 1000).toFixed(0)}s window at ${(window.startMs / 1000).toFixed(0)}s (${analysedCues.length} cues)`);
        }
      }

      const wavPath = join(dir, 'audio.wav');
      const extracted = await extractPcm(mediaPath, wavPath, {
        ffmpegPath: options.ffmpegPath,
        startMs: analysisStartMs,
        durationMs: analysisDurationMs,
        timeoutMs: options.maxAnalyzeMs ?? 120000,
        headers: options.headers,
      });
      if (!extracted.ok) {
        say('debug', `ffmpeg: ${extracted.error}`);
      } else {
        const envelope = await buildEnergyEnvelope(wavPath, { hopMs: 20 });
        if (envelope.voicedMs < 3000) {
          say('debug', 'the audio track has too little speech to align against');
        } else {
          const subMask = cuesToSpeechMask(analysedCues, { hopMs: envelope.hopMs });
          const lag = bestMaskLag(envelope.mask, subMask.mask, { hopMs: envelope.hopMs, maxLagMs });
          const confidence = Math.max(0, Math.min(1, lag.confidence));
          say('debug', `js audio lag=${lag.lagMs}ms score=${lag.score.toFixed(3)} confidence=${confidence.toFixed(2)}`);
          if (lag.score > 0.05) {
            jsResult = {
              ok: true,
              method: 'audio',
              offsetMs: normalizeOffset(Math.round(lag.lagMs / 100) * 100, { minOffsetMs: -maxOffsetMs, maxOffsetMs }),
              rate: 1,
              confidence,
              samples: doc.cues.length,
              detail: {
                backend: 'js',
                score: Number(lag.score.toFixed(4)),
                voicedMs: envelope.voicedMs,
                analyzedMs: envelope.durationMs,
                ...(analysisStartMs ? { windowStartMs: analysisStartMs } : {}),
              },
            };
          }
        }
      }
    } catch (err) {
      say('warn', `audio correlation failed: ${err.message}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const conclusive = jsResult && (jsResult.detail.score ?? 0) >= (options.jsConclusiveScore ?? 0.4);
  if (conclusive) return jsResult;

  // 3. ffsubsync: a mature VAD-based aligner, used when our own correlation is inconclusive.
  if (tools.ffsubsync) {
    const dir = await mkdtemp(join(tmpdir(), 'nuvio-ffss-'));
    try {
      const input = join(dir, 'input.srt');
      const output = join(dir, 'output.srt');
      await writeFile(input, serializeSubtitles(doc, 'srt'));
      const result = await runFfsubsync({ mediaPath, subPath: input, outputPath: output, ffsubsyncPath: options.ffsubsyncPath, timeoutMs: options.maxAnalyzeMs ?? 180000 });
      if (result.ok && result.offsetMs !== null) {
        const agree = jsResult ? Math.abs(jsResult.offsetMs - result.offsetMs) <= 1500 : true;
        say('info', `ffsubsync aligned: ${result.offsetMs}ms${jsResult ? ` (own estimate ${jsResult.offsetMs}ms, ${agree ? 'agreeing' : 'disagreeing'})` : ''}`);
        return {
          ok: true,
          method: 'audio',
          offsetMs: normalizeOffset(agree ? result.offsetMs : jsResult.offsetMs, { minOffsetMs: -maxOffsetMs, maxOffsetMs }),
          rate: agree ? (result.rate || 1) : 1,
          confidence: agree ? 0.9 : Math.min(0.6, jsResult.confidence + 0.15),
          samples: doc.cues.length,
          detail: { backend: agree ? 'ffsubsync' : 'js+ffsubsync-disagree', ffsubsyncOffsetMs: result.offsetMs, jsOffsetMs: jsResult.offsetMs },
        };
      }
      say('debug', `ffsubsync unusable: ${result.error}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (jsResult) return jsResult;
  return failure(tools.ffmpeg ? 'the audio track could not be analysed' : 'ffmpeg is not installed, and no external aligner succeeded');

}
