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

test('health, stats and the pages render, and report which build is running', async () => {
  const health = await (await get('/healthz')).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.build.shortSha, 'string');
  assert.ok(health.build.shortSha.length > 0, 'a deployment must be identifiable without guessing');
  assert.ok(['env', 'git', 'unknown'].includes(health.build.source));
  assert.ok(typeof health.uptime === 'number');

  const statsJson = await (await get('/stats')).json();
  assert.equal(statsJson.build.sha, health.build.sha, 'both endpoints must agree on the build');

  const stats = await (await get('/stats')).json();
  assert.ok(stats.stats.offsets >= 1);
  assert.ok(stats.events.length >= 1);
  assert.equal(stats.config.TOKEN_SECRET, undefined);

  const configure = await get('/configure');
  assert.equal(configure.status, 200);
  const configureHtml = await configure.text();
  assert.match(configureHtml, /id="installUrl"/);
  assert.ok(configureHtml.includes(health.build.shortSha), 'the configure page shows the running build');
  // This suite supplies TOKEN_SECRET, so the "data will not survive a restart" warning must be
  // absent. The other branch is covered in test/web/pages.test.js.
  assert.ok(!configureHtml.includes('dữ liệu không được lưu lại'), 'no false alarm when a secret is supplied');

  const root = await get('/', { redirect: 'manual' });
  assert.equal(root.status, 302);
});

test('the docs links the pages point at actually resolve', async () => {
  // The configure page links to `docs/nuvio-parity` (no extension) — that used to 404
  // because only `<name>.md` was routed.
  const pretty = await get('/docs/nuvio-parity');
  assert.equal(pretty.status, 200);
  assert.match(pretty.headers.get('content-type'), /markdown/);
  assert.match(await pretty.text(), /Nuvio parity/);

  const explicit = await get('/docs/nuvio-parity.md');
  assert.equal(explicit.status, 200);

  const index = await (await get('/docs')).json();
  assert.equal(index.ok, true);
  assert.ok(index.docs.includes('/docs/nuvio-parity'), index.docs.join(','));
  assert.ok(index.docs.every((d) => !d.endsWith('.md')), 'the index lists the friendly form');

  assert.equal((await get('/docs/nope')).status, 404);
  assert.equal((await get('/docs/../../etc/passwd')).status, 404);
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

test('a promo cue is stripped even when it comes out of a stale cache entry', async () => {
  const { loadSubtitleDoc } = await import('../../src/addon/pipeline.js');
  const store = await import('../../src/store/index.js');
  const videoKey = store.videoKeyOf({ type: 'movie', id: 'ttSTALECACHE' });
  const track = { id: 'stale:1', provider: 'local', lang: 'en', url: 'file:/nonexistent.srt', format: 'srt' };
  // Simulate what an older build cached: the advert is still in the body.
  store.putCachedSub(store.cacheKeyOf(['raw', videoKey, track.id]), {
    body: '1\n00:00:00,000 --> 00:00:06,000\nAdvertise your product or brand here\n\n'
      + '2\n00:00:20,000 --> 00:00:22,000\nReal dialogue.\n',
    format: 'srt',
    ttlMs: 60_000,
  });
  const { doc, text, cached } = await loadSubtitleDoc({ videoKey, trackId: track.id, track, config: {} });
  assert.equal(cached, true);
  assert.equal(doc.cues.length, 1);
  assert.ok(!/Advertise your product/i.test(text), text);
});

test('a promo cue never survives the SYNC path either', async () => {
  const { signToken } = await import('../../src/addon/tokens.js');
  const store = await import('../../src/store/index.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const dir = mkdtempSync(join(tmpdir(), 'nuvio-promo-'));
  const dump = (shiftMs, trailer) => {
    const lines = [];
    for (let i = 0; i < 24; i += 1) {
      const start = 20_000 + i * 4_000 + shiftMs;
      const fmt = (v) => {
        const h = Math.floor(v / 3600000), m = Math.floor((v % 3600000) / 60000), sec = Math.floor((v % 60000) / 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(v % 1000).padStart(3, '0')}`;
      };
      lines.push(`${i + 1}\n${fmt(start)} --> ${fmt(start + 2000)}\ndialogue line number ${i}\n`);
    }
    const first = `1\n00:00:00,000 --> 00:00:06,000\n${trailer}\n`;
    return `${first}\n${lines.join('\n')}`;
  };
  const a = join(dir, 'a.en.srt');
  const b = join(dir, 'b.fr.srt');
  const c = join(dir, 'c.en.srt');
  writeFileSync(a, dump(0, "You're on the free plan. Unlock every source → store.wyzie.io"));
  writeFileSync(b, dump(-3000, 'Watch Online Movies and Series for FREE\nwww.osdb.link/lm'));
  // Two corroborating references, otherwise the consensus gate keeps the offset as a suggestion.
  writeFileSync(c, dump(-3000, 'Advertise your product or brand here'));

  const videoKey = store.videoKeyOf({ type: 'movie', id: 'ttPROMO' });
  store.putTrack({ id: 'local:a', provider: 'local', lang: 'en', url: `file:${a}`, format: 'srt', source: 'local' }, videoKey, 'primary');
  store.putTrack({ id: 'local:b', provider: 'local', lang: 'fr', url: `file:${b}`, format: 'srt', source: 'local' }, videoKey, 'primary');
  store.putTrack({ id: 'local:c', provider: 'local', lang: 'en', url: `file:${c}`, format: 'srt', source: 'local' }, videoKey, 'primary');

  const token = signToken({ v: videoKey, i: 'local:a' }, { ttlMs: 3600_000 });
  const res = await get(`/s/${token}/promo.srt`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-nuvio-sync-method'), 'text', 'the sync path must have run');
  assert.ok(!/wyzie|osdb\.link|free plan|Watch Online Movies/i.test(body), `promo text leaked:\n${body.slice(0, 240)}`);
  const cues = body.trim().split(/\n\n+/).length;
  assert.ok(cues >= 24, `expected the real cues to survive, got ${cues}`);
});

function parseFirstCue(body) {
  const lines = body.split('\n');
  const timing = lines[1] || '';
  const [start] = timing.split(' --> ');
  return { start, text: (lines[2] || '').trim() };
}
