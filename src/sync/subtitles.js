/**
 * Subtitle parsing / serialisation for SRT, WebVTT and ASS/SSA.
 * Everything here treats its input as untrusted data: no parser throws on malformed input,
 * they degrade to "as many cues as could be recovered".
 * Owned by LEAD. Contract: src/contracts.js §1.
 */
import { parseTimestamp, formatTimestampSrt, formatTimestampVtt, formatTimestampAss } from '../util/text.js';

const SRT_ARROW = /\s*-{1,2}>\s*/;

/**
 * @param {string} text
 * @param {string} [url]
 * @returns {'srt'|'vtt'|'ass'|'ssa'}
 */
export function detectFormat(text, url = '') {
  const path = String(url || '').split('?')[0].split('#')[0].toLowerCase();
  if (path.endsWith('.vtt')) return 'vtt';
  if (path.endsWith('.ass')) return 'ass';
  if (path.endsWith('.ssa')) return 'ssa';
  if (path.endsWith('.srt') || path.endsWith('.sub')) return 'srt';

  const sample = stripBom(String(text ?? '')).slice(0, 4000);
  if (/^\s*WEBVTT/.test(sample)) return 'vtt';
  if (/\[Script Info\]/i.test(sample) || /\[Events\]/i.test(sample)) {
    return /ScriptType:\s*v4\.00\+/i.test(sample) || /^Format:\s*Layer/m.test(sample) ? 'ass' : 'ssa';
  }
  if (/^\s*\{?\d+\}?\s*\r?\n\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/m.test(sample)) return 'srt';
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/.test(sample)) {
    return /\.\d{3}\s*-->/.test(sample) && /<c\.|<\/c>|<v |align:|line:/.test(sample) ? 'vtt' : 'srt';
  }
  return 'srt';
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Recover UTF-8 text that was decoded as latin1 (common for cp1252 subs). */
function fixMojibake(text) {
  if (!/[\u00c2-\u00c3][\u0080-\u00bf]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') ? text : repaired;
  } catch {
    return text;
  }
}

/** @param {string} text @param {{url?:string, format?:string}} [opts] */
export function parseSubtitles(text, { url = '', format } = {}) {
  let raw = fixMojibake(stripBom(String(text ?? '')).replace(/\r\n?/g, '\n'));
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const kind = format || detectFormat(raw, url);
  try {
    if (kind === 'vtt') return parseVtt(raw);
    if (kind === 'ass' || kind === 'ssa') return parseAss(raw, kind);
    const srt = parseSrt(raw);
    if (srt.cues.length) return srt;
    // Some hosts mislabel VTT as .srt — retry before giving up.
    if (/^\s*WEBVTT/.test(raw)) return parseVtt(raw);
    return srt;
  } catch {
    return { format: kind === 'ssa' ? 'ssa' : kind, cues: [], meta: { parseError: true } };
  }
}

/* ── SRT ───────────────────────────────────────────────────────────────── */

function parseSrt(raw) {
  const cues = [];
  const blocks = raw.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timing = lines[idx];
    if (!timing || !SRT_ARROW.test(timing)) continue;
    const [rawStart, rawRest] = timing.split(SRT_ARROW);
    const rawEnd = String(rawRest ?? '').trim().split(/\s+/)[0];
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const textLines = lines.slice(idx + 1);
    if (!textLines.length) continue;
    cues.push({
      index: cues.length,
      start,
      end: Math.max(end, start),
      text: textLines.join('\n'),
      raw: textLines.join('\n'),
    });
  }
  return { format: 'srt', cues, meta: {} };
}

/* ── WebVTT ────────────────────────────────────────────────────────────── */

function parseVtt(raw) {
  const lines = raw.split('\n');
  const cues = [];
  const meta = {};
  let i = 0;
  // Header block up to the first blank line.
  if (/^\s*WEBVTT/.test(lines[0] ?? '')) {
    const header = [];
    i = 1;
    while (i < lines.length && lines[i].trim() !== '') { header.push(lines[i]); i += 1; }
    meta.header = header.join('\n');
    const map = header.find((l) => /X-TIMESTAMP-MAP/i.test(l));
    if (map) {
      const m = map.match(/LOCAL:(\d{1,2}:\d{2}:\d{2}\.\d{1,3})/i);
      if (m) meta.timestampMapMs = parseTimestamp(m[1]);
    }
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(NOTE|STYLE|REGION)\b/.test(line)) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') i += 1;
      continue;
    }
    if (!line.includes('-->')) continue;
    const [rawStart, rawRest] = line.split(SRT_ARROW);
    const rawEnd = String(rawRest ?? '').trim().split(/\s+/)[0];
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const textLines = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '') { textLines.push(lines[j]); j += 1; }
    i = j;
    cues.push({ index: cues.length, start, end: Math.max(end, start), text: textLines.join('\n'), raw: textLines.join('\n') });
  }
  return { format: 'vtt', cues, meta };
}

/* ── ASS / SSA ─────────────────────────────────────────────────────────── */

function parseAss(raw, kind = 'ass') {
  const lines = raw.split('\n');
  const cues = [];
  const meta = { assPrefixLines: [], eventsFormat: null, styleFormat: null, kind };
  let inEvents = false;
  let fieldCount = -1;
  let startIdx = -1;
  let endIdx = -1;
  let textIdx = -1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inEvents = /^\[Events\]/i.test(line);
      if (!inEvents) meta.assPrefixLines.push(rawLine);
      continue;
    }
    if (!inEvents) {
      meta.assPrefixLines.push(rawLine);
      continue;
    }
    if (/^Format\s*:/i.test(line)) {
      const fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
      fieldCount = fields.length;
      meta.eventsFormat = fields;
      startIdx = fields.indexOf('start');
      endIdx = fields.indexOf('end');
      textIdx = fields.indexOf('text');
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) {
      meta.eventsFormat === null && meta.assPrefixLines.push(rawLine);
      continue;
    }
    if (fieldCount < 0 || startIdx < 0 || textIdx < 0) continue;
    const body = line.slice(line.indexOf(':') + 1).trim();
    const fields = body.split(',');
    const head = fields.slice(0, fieldCount - 1);
    const tail = fields.slice(fieldCount - 1).join(',');
    const parts = [...head, tail];
    if (parts.length < fieldCount) continue;
    const start = parseTimestamp(parts[startIdx]);
    const end = endIdx >= 0 ? parseTimestamp(parts[endIdx]) : null;
    if (start === null) continue;
    cues.push({
      index: cues.length,
      start,
      end: Math.max(end ?? start + 2000, start),
      text: parts[textIdx] ?? '',
      raw: parts[textIdx] ?? '',
      style: parts[3] ?? parts[1] ?? null,
    });
  }
  return { format: kind, cues, meta };
}

/* ── serialisation ─────────────────────────────────────────────────────── */

/**
 * @param {import('../contracts.js').SubtitleDoc} doc
 * @param {string} [format] defaults to doc.format
 * @returns {string}
 */
export function serializeSubtitles(doc, format) {
  const kind = format || doc?.format || 'srt';
  const cues = doc?.cues ?? [];
  if (kind === 'vtt') return serializeVtt(cues, doc?.meta);
  if (kind === 'ass' || kind === 'ssa') return serializeAss(cues, doc?.meta, kind);
  return serializeSrt(cues);
}

function serializeSrt(cues) {
  const out = [];
  let n = 1;
  for (const cue of cues) {
    const text = String(cue.text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    out.push(`${n}`, `${formatTimestampSrt(cue.start)} --> ${formatTimestampSrt(cue.end)}`, text, '');
    n += 1;
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function serializeVtt(cues, meta = {}) {
  const out = ['WEBVTT'];
  if (meta.header) out.push(...String(meta.header).split('\n').filter((l) => !/^\s*WEBVTT/.test(l)));
  out.push('');
  for (const cue of cues) {
    const text = String(cue.text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    out.push(`${formatTimestampVtt(cue.start)} --> ${formatTimestampVtt(cue.end)}`, text, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function serializeAss(cues, meta = {}, kind = 'ass') {
  const prefix = Array.isArray(meta.assPrefixLines) && meta.assPrefixLines.length
    ? meta.assPrefixLines
    : buildAssHeader(kind);
  const format = Array.isArray(meta.eventsFormat) && meta.eventsFormat.length
    ? meta.eventsFormat
    : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const lines = [...prefix, '[Events]', `Format: ${format.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(', ')}`];
  const textIdx = format.indexOf('text');
  for (const cue of cues) {
    const text = String(cue.text ?? '').replace(/\n/g, '\\N');
    if (!text.trim()) continue;
    const fields = format.map((field, i) => {
      if (i === textIdx) return text;
      switch (field) {
        case 'layer': return '0';
        case 'start': return formatTimestampAss(cue.start);
        case 'end': return formatTimestampAss(cue.end);
        case 'style': return cue.style && String(cue.style) !== 'Default' ? String(cue.style) : 'Default';
        case 'name': return '';
        case 'marginl': case 'marginr': return '0000';
        case 'marginv': return '0000';
        case 'effect': return '';
        case 'marked': return 'Marked=0';
        default: return '';
      }
    });
    lines.push(`Dialogue: ${fields.join(',')}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function buildAssHeader(kind) {
  return [
    '[Script Info]',
    `ScriptType: ${kind === 'ssa' ? 'v4.00' : 'v4.00+'}`,
    'WrapStyle: 0',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,40,40,60,1',
  ];
}

/* ── speech mask ───────────────────────────────────────────────────────── */

/**
 * Rasterise the dialogue presence of a cue list into a binary mask, used for
 * cross-language alignment against an audio envelope.
 * @param {import('../contracts.js').Cue[]} cues
 * @param {{hopMs?:number, durationMs?:number, padMs?:number}} [opts]
 * @returns {{hopMs:number, durationMs:number, mask:Uint8Array}}
 */
export function cuesToSpeechMask(cues, { hopMs = 20, padMs = 120 } = {}) {
  const list = (cues || []).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  const last = list.reduce((max, c) => Math.max(max, c.end), 0);
  const durationMs = Math.max(1000, Math.ceil((last + padMs) / hopMs) * hopMs);
  const mask = new Uint8Array(Math.ceil(durationMs / hopMs));
  for (const cue of list) {
    const from = Math.max(0, Math.floor((cue.start - padMs) / hopMs));
    const to = Math.min(mask.length - 1, Math.ceil((cue.end + padMs) / hopMs));
    for (let i = from; i <= to; i += 1) mask[i] = 1;
  }
  return { hopMs, durationMs, mask };
}

/** Count of dialogue-bearing cues (non music/SFX-only). */
export function countDialogueCues(cues) {
  return (cues || []).filter((c) => /[\p{L}\p{N}]/u.test(String(c.text ?? '').replace(/[♪♫♬]/g, ''))).length;
}
