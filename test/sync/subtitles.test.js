import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseSubtitles, serializeSubtitles, cuesToSpeechMask } from '../../src/sync/subtitles.js';

const SRT = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline.\r\n';
const VTT = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\ncue-1\n00:00:01.000 --> 00:00:02.500 align:middle\nHello <c.yellow>there</c>.\n\n00:00:03.000 --> 00:00:04.000\nSecond line.\n';
const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello, there, friend.
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8}Second line.
`;

test('detectFormat recognises all three containers', () => {
  assert.equal(detectFormat(SRT), 'srt');
  assert.equal(detectFormat(VTT), 'vtt');
  assert.equal(detectFormat(ASS), 'ass');
  assert.equal(detectFormat('', 'https://x/y.vtt?token=1'), 'vtt');
  assert.equal(detectFormat('', 'https://x/y.srt'), 'srt');
});

test('SRT round-trip keeps timings and rejects a BOM/CRLF', () => {
  const doc = parseSubtitles(SRT);
  assert.equal(doc.format, 'srt');
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].start, 1000);
  assert.equal(doc.cues[0].end, 2500);
  assert.equal(doc.cues[1].text, 'Second\nline.');
  const out = serializeSubtitles(doc, 'srt');
  const again = parseSubtitles(out);
  assert.deepEqual(again.cues.map((c) => [c.start, c.end, c.text]), doc.cues.map((c) => [c.start, c.end, c.text]));
});

test('WebVTT parses cue ids, settings and inline markup', () => {
  const doc = parseSubtitles(VTT, { url: 'x.vtt' });
  assert.equal(doc.format, 'vtt');
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].start, 1000);
  assert.equal(doc.cues[0].text, 'Hello <c.yellow>there</c>.');
  const out = serializeSubtitles(doc, 'vtt');
  assert.match(out, /^WEBVTT/);
  assert.match(out, /00:00:01\.000 --> 00:00:02\.500/);
});

test('ASS/SSA keeps styles and splits Dialogue on the text field only', () => {
  const doc = parseSubtitles(ASS);
  assert.equal(doc.format, 'ass');
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].text, 'Hello, there, friend.');
  assert.equal(doc.cues[0].start, 1000);
  const out = serializeSubtitles(doc, 'ass');
  assert.match(out, /\[V4\+ Styles\]/);
  assert.match(out, /^Dialogue: 0,0:00:01\.00,0:00:02\.50,Default,[^,]*,\d+,\d+,\d+,,[^\n]*Hello, there, friend\./m);
  assert.match(out, /Dialogue: [^\n]*\{\\an8\}Second line\./);
});

test('malformed input never throws and returns what it could recover', () => {
  for (const bad of ['', 'not a subtitle at all', '1\n00:00:xx --> nope\ntext\n', '\u0000\u0001\u0002']) {
    const doc = parseSubtitles(bad);
    assert.ok(Array.isArray(doc.cues));
  }
  const partial = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nGood\n\nGARBAGE\n\n2\n00:00:03,000 --> 00:00:04,000\nFine\n');
  assert.equal(partial.cues.length, 2);
});

test('cp1252 text mis-decoded as UTF-8 is repaired', () => {
  const original = 'Chào bạn, tôi khoẻ.';
  const broken = Buffer.from(original, 'utf8').toString('latin1');
  const doc = parseSubtitles(`1\n00:00:01,000 --> 00:00:02,000\n${broken}\n`);
  assert.equal(doc.cues[0].text, original);
});

test('cuesToSpeechMask covers the cue spans and pads them', () => {
  const doc = parseSubtitles(SRT);
  const { mask, hopMs, durationMs } = cuesToSpeechMask(doc.cues, { hopMs: 20 });
  assert.equal(hopMs, 20);
  assert.ok(durationMs >= 4000);
  assert.equal(mask[Math.floor(1000 / hopMs) + 1], 1);
  assert.equal(mask[Math.floor(300 / hopMs)], 0);
  assert.equal(mask[Math.floor(2600 / hopMs)], 1, 'padding keeps the tail on');
});

test('a declared format that lies is recovered from the content', () => {
  // SubSense's proxy converts an upstream .ssa to VTT while the entry keeps the .ssa name.
  assert.equal(parseSubtitles(VTT, { url: 'x.ssa', format: 'ssa' }).cues.length, 2);
  assert.equal(parseSubtitles(VTT, { url: 'x.ass', format: 'ass' }).cues.length, 2);
  assert.equal(parseSubtitles(SRT, { url: 'x.vtt', format: 'vtt' }).cues.length, 2);
  assert.equal(parseSubtitles(ASS, { url: 'x.srt', format: 'srt' }).cues.length, 2);
  // And the recovered document reports the format that actually parsed.
  assert.equal(parseSubtitles(VTT, { format: 'ssa' }).format, 'vtt');
  assert.equal(parseSubtitles(ASS, { format: 'srt' }).format, 'ass');
});

test('a genuinely empty payload still yields no cues and no throw', () => {
  for (const bad of ['', '   ', '<html><body>error</body></html>', '{"error":"nope"}']) {
    const doc = parseSubtitles(bad, { format: 'srt' });
    assert.equal(doc.cues.length, 0);
  }
});
