/**
 * End-to-end: boot the real HTTP server on an ephemeral port and drive the whole addon
 * surface the way Stremio and a browser do.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nuvio-e2e-'));
process.env.LOG_LEVEL = 'silent';
process.env.SYNC_MODE = 'fast';
process.env.AUTO_SYNC_BUDGET_MS = '8000';
process.env.PREFERRED_LANGS = 'vi,en';
process.env.ENABLED_PROVIDERS = 'local';
process.env.AUDIO_SYNC_ENABLED = 'false';
process.env.TOKEN_SECRET = 'e2e-secret-e2e-secret-e2e-secret';

const { startServer } = await import('../../src/server.js');
const { reloadConfig } = await import('../../src/env.js');

let ctx;

before(async () => {
  reloadConfig();
  ctx = await startServer({ host: '127.0.0.1', port: 0 });
});

after(async () => {
  await ctx?.close();
});

const get = (path, init) => fetch(`${ctx.url}${path}`, init);
const extra = encodeURIComponent('videoHash=d41d8cd98f00b204&videoSize=123456789&filename=demo.2024.1080p.WEB-DL.x264-DEMO.mkv');

async function trackList() {
  const res = await get(`/subtitles/movie/tt1234567/${extra}.json`);
  assert.equal(res.status, 200);
  const payload = await res.json();
  return payload.subtitles;
}

test('the manifest is a valid subtitle addon manifest', async () => {
  const res = await get('/manifest.json');
  assert.equal(res.status, 200);
  const manifest = await res.json();
  assert.equal(manifest.id, 'org.nuviosync.subtitles');
  assert.deepEqual(manifest.resources, ['subtitles']);
  assert.deepEqual(manifest.types, ['movie', 'series']);
  assert.ok(manifest.behaviorHints.configurable);
  assert.match(manifest.logo, /^http:\/\/127\.0\.0\.1:\d+\/assets\/logo\.svg$/);
});

test('the subtitle list exposes the offline sample tracks with 3-letter languages', async () => {
  const subtitles = await trackList();
  assert.equal(subtitles.length, 3);
  assert.deepEqual(subtitles.map((s) => s.lang).sort(), ['eng', 'eng', 'vie']);
  for (const s of subtitles) {
    assert.match(s.url, new RegExp(`^${ctx.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/`));
    assert.ok(s.url.endsWith('.srt'), s.url);
  }
});

test('fetching a mistimed subtitle auto-syncs it against two corroborating siblings', async () => {
  const subtitles = await trackList();
  const vi = subtitles.find((s) => s.lang === 'vie');
  const started = Date.now();
  const res = await get(new URL(vi.url).pathname);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-nuvio-sync-method'), 'text');
  assert.equal(Number(res.headers.get('x-nuvio-sync-offset-ms')), -2500);
  assert.equal(Number(res.headers.get('x-nuvio-sync-rate')), 1);
  assert.ok(Number(res.headers.get('x-nuvio-sync-confidence')) > 0.8);
  assert.ok(Date.now() - started < 8000, 'must answer inside the sync budget');

  // The bundled vi sample is the en sample delayed by 2500 ms: the served file must be corrected.
  const first = parseFirstCue(body);
  assert.equal(first.start, '00:00:12,000');
  assert.equal(first.text, '[vi] Good morning, everyone.');
});

test('a second fetch is served from cache byte-for-byte', async () => {
  const subtitles = await trackList();
  const vi = subtitles.find((s) => s.lang === 'vie');
  const a = await (await get(new URL(vi.url).pathname)).text();
  const started = Date.now();
  const b = await (await get(new URL(vi.url).pathname)).text();
  assert.equal(a, b);
  assert.ok(Date.now() - started < 500, 'cache hit should be fast');
});

test('the english sample needs no correction and stays untouched', async () => {
  const subtitles = await trackList();
  const en = subtitles.find((s) => s.lang === 'eng');
  const res = await get(new URL(en.url).pathname);
  const body = await res.text();
  assert.equal(res.status, 200);
  const offset = Number(res.headers.get('x-nuvio-sync-offset-ms'));
  assert.ok(Math.abs(offset) <= 200, `expected no meaningful correction, got ${offset}`);
  assert.equal(parseFirstCue(body).start, '00:00:12,000');
});

test('the Sync Lab session, cues, tap calibration, preview and auto endpoints agree', async () => {
  const subtitles = await trackList();
  const vi = subtitles.find((s) => s.lang === 'vie');
  const token = new URL(vi.url).pathname.split('/')[2];

  const session = await (await get(`/api/synclab/session?t=${encodeURIComponent(token)}`)).json();
  assert.equal(session.ok, true);
  assert.equal(session.tracks.length, 3);
  assert.equal(session.settings.reactionCompensationMs, 300);
  assert.equal(session.settings.clampMaxMs, 180000);
  assert.equal(session.settings.stepMs, 100);
  assert.equal(session.selectedTrackId, vi.id);

  const cues = await (await get(`/api/synclab/cues?t=${encodeURIComponent(token)}&trackId=${encodeURIComponent(vi.id)}&limit=5`)).json();
  assert.equal(cues.ok, true);
  assert.equal(cues.total, 48);
  assert.equal(cues.cues.length, 5);
  assert.equal(cues.cues[0].start, 14500, 'cues are served with their original timing');

  // Nuvio's manual calibration: the user heard this line 1000 ms after it should have started.
  const applied = await (await get('/api/synclab/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: token, trackId: vi.id, mode: 'tap', videoPositionMs: cues.cues[0].start + 1000, cueStartMs: cues.cues[0].start }),
  })).json();
  assert.equal(applied.ok, true);
  assert.equal(applied.offsetMs, 700, '1000 ms minus the 300 ms reaction compensation');
  assert.equal(applied.method, 'manual-tap');

  const preview = await (await get(`/api/synclab/preview?t=${encodeURIComponent(token)}&trackId=${encodeURIComponent(vi.id)}`)).text();
  assert.equal(parseFirstCue(preview).start, '00:00:15,200', '14500 + 700');

  const auto = await (await get('/api/synclab/auto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: token, trackId: vi.id, mode: 'fast' }),
  })).json();
  assert.equal(auto.ok, true);
  assert.equal(auto.result.method, 'text');
  assert.equal(auto.result.offsetMs, -2500, 'auto sync overrides the manual offset with the measured one');
});

test('the manual offset path also drives what Stremio will download', async () => {
  const subtitles = await trackList();
  const en = subtitles.find((s) => s.lang === 'eng');
  const token = new URL(en.url).pathname.split('/')[2];
  await get('/api/synclab/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: token, trackId: en.id, mode: 'offset', offsetMs: 1234 }),
  });
  const body = await (await get(new URL(en.url).pathname)).text();
  assert.equal(parseFirstCue(body).start, '00:00:13,234', '12000 + 1234');

  const reset = await (await get('/api/synclab/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: token, trackId: en.id, mode: 'reset' }),
  })).json();
  assert.equal(reset.ok, true);
  assert.equal(reset.offsetMs, 0);
});

test('malformed and hostile requests are rejected without a stack trace', async () => {
  const badToken = await get('/s/not-a-token/x.srt');
  assert.equal(badToken.status, 400);

  const missing = await get('/s/eyJ2IjoieCIsImkiOiJ5In0.deadbeef/x.srt');
  assert.equal(missing.status, 400);

  const notFound = await get('/nope');
  assert.equal(notFound.status, 404);

  const badJson = await get('/api/synclab/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).ok, false);

  const noToken = await get('/api/synclab/session');
  assert.equal(noToken.status, 400);
});

test('the configuration API round-trips and never echoes a secret', async () => {
  const saved = await (await get('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ OPENSUBTITLES_API_KEY: 'super-secret-key-1234', SYNC_MODE: 'fast', PREFERRED_LANGS: 'vi,en,fr' }),
  })).json();
  assert.equal(saved.ok, true);
  assert.match(saved.config.OPENSUBTITLES_API_KEY_MASK, /^supe••••1234$/);

  const fetched = await (await get('/api/config')).json();
  assert.equal(fetched.ok, true);
  assert.equal(fetched.config.OPENSUBTITLES_API_KEY, undefined, 'secrets must never be serialised');
  assert.deepEqual(fetched.config.PREFERRED_LANGS, ['vi', 'en', 'fr']);
});

test('health, stats and the pages render', async () => {
  const health = await (await get('/healthz')).json();
  assert.equal(health.ok, true);

  const stats = await (await get('/stats')).json();
  assert.ok(stats.stats.offsets >= 1);
  assert.ok(stats.events.length >= 1);
  assert.equal(stats.config.TOKEN_SECRET, undefined);

  const configure = await get('/configure');
  assert.equal(configure.status, 200);
  assert.match(await configure.text(), /id="installUrl"/);

  const root = await get('/', { redirect: 'manual' });
  assert.equal(root.status, 302);
});

test('a provider that answers 200 with junk produces an error, never an empty subtitle', async () => {
  const { signToken } = await import('../../src/addon/tokens.js');
  const store = await import('../../src/store/index.js');
  const videoKey = store.videoKeyOf({ type: 'movie', id: 'ttJUNK' });
  store.putTrack({
    id: 'junk:1',
    provider: 'junk',
    lang: 'en',
    url: `${ctx.url}/healthz`, // 200, but it is JSON, not a subtitle
    format: 'srt',
    source: 'api',
  }, videoKey, 'primary');
  const token = signToken({ v: videoKey, i: 'junk:1' }, { ttlMs: 3600_000 });
  const res = await get(`/s/${token}/junk.srt`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /no usable subtitle/);
});

test('promotional cues injected by free mirrors never reach the player', async () => {
  const { stripPromoCues } = await import('../../src/addon/pipeline.js');
  const doc = {
    format: 'srt',
    meta: {},
    cues: [
      { index: 0, start: 6000, end: 12074, text: 'Watch Online Movies and Series for FREE\nwww.osdb.link/lm' },
      { index: 1, start: 357000, end: 358235, text: 'Dreams feel real while we are in them.' },
      { index: 2, start: 12_000, end: 16_000, text: "You're on the free plan. Unlock every source, AI translation & ad-free subs" },
    ],
  };
  const cleaned = stripPromoCues(doc);
  assert.equal(cleaned.cues.length, 1);
  assert.equal(cleaned.cues[0].index, 0, 'indices are renumbered');
  assert.match(cleaned.cues[0].text, /Dreams feel real/);
  assert.equal(stripPromoCues(doc).cues.length, 1, 'the source document is not mutated');
  assert.equal(stripPromoCues({ format: 'srt', cues: [], meta: {} }).cues.length, 0);
});

function parseFirstCue(body) {
  const lines = body.split('\n');
  const timing = lines[1] || '';
  const [start] = timing.split(' --> ');
  return { start, text: (lines[2] || '').trim() };
}
