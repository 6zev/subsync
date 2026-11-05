import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignByLlm, buildPrompt, parseLlmMatches, pickWindows, callLlm, formatClock,
} from '../../src/sync/llmMatch.js';
import { NUVIO } from '../../src/contracts.js';

function makeDoc(count = 60, { start = 10_000, step = 4000, prefix = 'ref ' } = {}) {
  const cues = [];
  let t = start;
  for (let i = 0; i < count; i += 1) {
    const text = `${prefix}line ${i} unique words ${i * 13}`;
    cues.push({ index: i, start: t, end: t + 2200, text, raw: text });
    t += step;
  }
  return { format: 'srt', cues, meta: {} };
}

const shift = (doc, ms) => ({ ...doc, cues: doc.cues.map((c) => ({ ...c, start: c.start + ms, end: c.end + ms })) });

test('formatClock renders mm:ss and h:mm:ss', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(75_000), '1:15');
  assert.equal(formatClock(3_725_000), '1:02:05');
});

test('buildPrompt asks for 1-based JSON and includes both sides', () => {
  const ref = makeDoc(6).cues.slice(0, 5);
  const cand = shift(makeDoc(6), -2000).cues.slice(0, 5);
  const prompt = buildPrompt(ref, cand);
  assert.match(prompt, /REFERENCE:/);
  assert.match(prompt, /CANDIDATE:/);
  assert.match(prompt, /"matches":\[\{"ref":/);
  assert.match(prompt, /^1\. \[0:10\] ref line 0/m);
});

test('parseLlmMatches accepts fenced, bare and 0-based replies', () => {
  assert.deepEqual(parseLlmMatches('```json\n{"matches":[{"ref":1,"target":2}]}\n```', 5, 5), [{ ref: 0, target: 1 }]);
  assert.deepEqual(parseLlmMatches('Sure!\n{"matches":[{"ref":3,"target":4}]}', 5, 5), [{ ref: 2, target: 3 }]);
  assert.deepEqual(parseLlmMatches('{"matches":[{"ref":0,"target":1},{"ref":1,"target":2}]}', 5, 5), [{ ref: 0, target: 1 }, { ref: 1, target: 2 }]);
  assert.deepEqual(parseLlmMatches('totally not json', 5, 5), []);
  assert.deepEqual(parseLlmMatches('{"matches":[{"ref":99,"target":1}]}', 5, 5), []);
});

test('pickWindows spreads the windows over the file and never returns short ones', () => {
  const cues = makeDoc(60).cues;
  const windows = pickWindows(cues, NUVIO.SOURCE_LINE_COUNT, NUVIO.MAX_ATTEMPTS);
  assert.equal(windows.length, 3);
  for (const w of windows) assert.equal(w.cues.length, 5);
  const starts = windows.map((w) => w.startIdx);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.ok(new Set(starts).size === 3);
});

test('callLlm speaks the Groq and Gemini protocols', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    if (/generativelanguage/.test(url)) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"matches":[]}' }] } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"matches":[]}' } }] }) };
  };
  const groq = await callLlm({ provider: 'groq', apiKey: 'k' }, 'hi', { fetchImpl: fakeFetch });
  assert.equal(groq.model, NUVIO.GROQ_MODEL_DEFAULT);
  const gemini = await callLlm({ provider: 'gemini', apiKey: 'k' }, 'hi', { fetchImpl: fakeFetch });
  assert.equal(gemini.model, NUVIO.GEMINI_MODEL_DEFAULT);
  assert.ok(seen[0].url.endsWith('/chat/completions'));
  assert.match(seen[1].url, /:generateContent\?key=k$/);
});

/** Build the reply the model *should* send, by reading the prompt the code actually built. */
function answerFromPrompt(prompt, { noisePerAttempt = 0, attempt = 0 } = {}) {
  const section = (name) => {
    const start = prompt.indexOf(`${name}:`);
    const end = prompt.indexOf('\n\n', start);
    return prompt.slice(start, end === -1 ? undefined : end);
  };
  const parse = (block) => block.split('\n').slice(1).map((line) => {
    const m = line.match(/^(\d+)\. \[([\d:]+)\] (.*)$/);
    if (!m) return null;
    const tail = m[3].match(/words (\d+)$/);
    return { n: Number(m[1]), key: tail ? tail[1] : m[3] };
  }).filter(Boolean);
  const refs = parse(section('REFERENCE'));
  const cands = parse(section('CANDIDATE'));
  const byKey = new Map(cands.map((c) => [c.key, c.n]));
  const matches = refs.filter((r) => byKey.has(r.key)).map((r) => ({ ref: r.n, target: byKey.get(r.key) }));
  return JSON.stringify({ matches: matches.length ? matches : [] , noise: attempt * noisePerAttempt });
}

test('alignByLlm pools attempts and takes the median (Nuvio behaviour)', async () => {
  const ref = makeDoc(60);
  // The candidate file runs exactly 3200 ms late, so the correction must be -3200 ms.
  const target = shift(ref, 3200);
  let call = 0;
  const fakeFetch = async (_url, init) => {
    call += 1;
    const prompt = JSON.parse(init.body).messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: answerFromPrompt(prompt, { attempt: call }) } }] }) };
  };
  const result = await alignByLlm({
    refCues: ref.cues,
    targetCues: target.cues,
    llm: { provider: 'groq', apiKey: 'test' },
    options: { attempts: 3, lineCount: 5 },
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, true);
  assert.equal(result.offsetMs, -3200);
  assert.equal(result.rate, 1);
  assert.ok(result.confidence > 0.6, `confidence ${result.confidence}`);
  assert.equal(result.detail.strategy, 'llm');
  assert.ok(result.detail.attempts.length >= 1);
  assert.ok(result.detail.pooled >= 5, `pooled ${result.detail.pooled}`);
  assert.ok(call >= 2, `the pipeline should have pooled several attempts, got ${call}`);
});

test('alignByLlm refuses without a key and never throws on a broken reply', async () => {
  const ref = makeDoc(20);
  assert.equal((await alignByLlm({ refCues: ref.cues, targetCues: ref.cues, llm: null })).ok, false);

  const broken = await alignByLlm({
    refCues: ref.cues,
    targetCues: shift(ref, 1000).cues,
    llm: { provider: 'groq', apiKey: 'x' },
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /no usable matches/);
  assert.ok(broken.detail.attempts.some((a) => a.error));
});

test('the LLM stage stays inside the configured clamp', async () => {
  const ref = makeDoc(40);
  const target = shift(ref, 5000);
  const fakeFetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: answerFromPrompt(prompt) } }] }) };
  };
  const wide = await alignByLlm({ refCues: ref.cues, targetCues: target.cues, llm: { provider: 'groq', apiKey: 'x' }, fetchImpl: fakeFetch });
  assert.equal(wide.offsetMs, -5000);

  const tightened = await alignByLlm({
    refCues: ref.cues, targetCues: target.cues, llm: { provider: 'groq', apiKey: 'x' },
    fetchImpl: fakeFetch, options: { maxOffsetMs: 1000 },
  });
  assert.equal(tightened.offsetMs, -1000, 'Nuvio clamp must apply');
});
;
