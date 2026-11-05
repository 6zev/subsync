import test from 'node:test';
import assert from 'node:assert/strict';
import * as opensubtitles from '../../src/providers/opensubtitles.js';
import * as subdl from '../../src/providers/subdl.js';
import * as podnapisi from '../../src/providers/podnapisi.js';
import * as local from '../../src/providers/local.js';
import { searchAll, PROVIDERS, listProviders, resolveTrackUrl } from '../../src/providers/index.js';

const noop = () => {};

function ctx(overrides = {}) {
  return {
    type: 'movie',
    imdbId: 'tt1234567',
    langs: ['vi', 'en'],
    filename: 'Movie.2024.1080p.WEB-DL.x264-GROUP.mkv',
    videoHash: 'd41d8cd98f00b204',
    videoSize: 123456789,
    config: {},
    log: noop,
    ...overrides,
  };
}

/* ── OpenSubtitles ─────────────────────────────────────────────────────── */

const OS_PAYLOAD = {
  data: [
    {
      attributes: {
        language: 'vi',
        download_count: 5123,
        ratings: 8.1,
        release: 'Movie.2024.1080p.WEB-DL.x264-GROUP',
        machine_translated: false,
        hearing_impaired: false,
        moviehash_match: true,
        format: 'srt',
        files: [{ file_id: 111, file_name: 'Movie.2024.1080p.WEB-DL.vi.srt' }],
      },
    },
    {
      attributes: {
        language: 'en',
        download_count: 12,
        ratings: 1,
        release: 'Something.Else.720p',
        format: 'srt',
        files: [{ file_id: 222, file_name: 'other.srt' }],
      },
    },
    { attributes: { language: 'en', files: [] } },
  ],
};

test('opensubtitles maps results and marks hash matches', async () => {
  const calls = [];
  const httpJson = async (url, opts) => { calls.push({ url, opts }); return OS_PAYLOAD; };
  const tracks = await opensubtitles.search(ctx({ config: { OPENSUBTITLES_API_KEY: 'key' }, httpJson }));
  assert.equal(tracks.length, 2, 'a file-less entry must be dropped');
  assert.equal(tracks[0].id, 'opensubtitles:111');
  assert.equal(tracks[0].lang, 'vi');
  assert.equal(tracks[0].url, 'osdl:111');
  assert.equal(tracks[0].hash, 'd41d8cd98f00b204');
  assert.equal(tracks[0].downloads, 5123);
  assert.equal(tracks[1].hash, undefined);
  assert.ok(calls[0].url.includes('imdb_id=1234567'));
  assert.ok(calls.some((c) => c.url.includes('moviehash=')), 'a hash query must be issued');
  assert.equal(calls[0].opts.headers['Api-Key'], 'key');
});

test('opensubtitles returns [] without a key and on HTTP failure', async () => {
  assert.deepEqual(await opensubtitles.search(ctx()), []);
  const tracks = await opensubtitles.search(ctx({
    config: { OPENSUBTITLES_API_KEY: 'key' },
    httpJson: async () => { throw new Error('HTTP 429'); },
  }));
  assert.deepEqual(tracks, []);
});

test('opensubtitles resolves a lazy download link', async () => {
  const httpJson = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(JSON.parse(opts.body).file_id, 111);
    return { link: 'https://dl.opensubtitles.com/download/abc' };
  };
  const url = await opensubtitles.resolveDownload({ id: 'opensubtitles:111', url: 'osdl:111', extra: { fileId: 111 } }, ctx({ config: { OPENSUBTITLES_API_KEY: 'k' }, httpJson }));
  assert.equal(url, 'https://dl.opensubtitles.com/download/abc');
});

test('opensubtitles download resolver returns null when the API is unhappy', async () => {
  const url = await opensubtitles.resolveDownload({ url: 'osdl:1', extra: {} }, ctx({ config: {}, httpJson: async () => ({}) }));
  assert.equal(url, null);
});

/* ── SubDL ─────────────────────────────────────────────────────────────── */

test('subdl builds absolute download URLs and filters languages', async () => {
  const httpJson = async (rawUrl) => {
    const url = decodeURIComponent(rawUrl);
    assert.ok(url.includes('api_key=k'), url);
    assert.ok(url.includes('type=movie'));
    assert.ok(url.includes('languages=VI,EN'), url);
    return {
      subtitles: [
        { language: 'VI', url: '/subtitle/1-2.zip', name: 'Movie.2024.1080p.WEB-DL.vi.zip', downloads: 900 },
        { language: 'FR', url: '/subtitle/3-4.zip', name: 'french.zip' },
        { language: 'EN', name: 'no url' },
      ],
    };
  };
  const tracks = await subdl.search(ctx({ config: { SUBDL_API_KEY: 'k' }, httpJson }));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].url, 'https://dl.subdl.com/subtitle/1-2.zip');
  assert.equal(tracks[0].lang, 'vi');
  assert.equal(tracks[0].extra.unpack, true);
});

test('subdl survives a malformed response', async () => {
  assert.deepEqual(await subdl.search(ctx({ config: { SUBDL_API_KEY: 'k' }, httpJson: async () => ({ subtitles: 'nope' }) })), []);
  assert.deepEqual(await subdl.search(ctx({ config: {}, httpJson: async () => ({}) })), []);
});

/* ── Podnapisi ─────────────────────────────────────────────────────────── */

const PN_XML = `<?xml version="1.0"?><subtitles>
<subtitle><pid>abc1</pid><title>Movie 2024</title><language>vi</language><release>Movie.2024.1080p.WEB-DL</release><rating>7</rating></subtitle>
<subtitle><pid>xyz2</pid><title>Movie 2024</title><language>en</language><url>https://example.com/direct.srt</url><hearingImpaired>yes</hearingImpaired></subtitle>
<subtitle><language>de</language></subtitle>
</subtitles>`;

test('podnapisi parses the legacy XML feed', async () => {
  const httpText = async () => ({ ok: true, status: 200, body: PN_XML });
  const tracks = await podnapisi.search(ctx({ httpText }));
  assert.equal(tracks.length, 2, 'the entry without a pid must be dropped');
  assert.equal(tracks[0].id, 'podnapisi:abc1');
  assert.equal(tracks[0].lang, 'vi');
  assert.match(tracks[0].url, /podnapisi\.net\/subtitles\/abc1\/download$/);
  assert.equal(tracks[1].url, 'https://example.com/direct.srt', 'absolute URLs are kept');
  assert.equal(tracks[1].hearingImpaired, true);
});

test('podnapisi survives a 500 and junk XML', async () => {
  assert.deepEqual(await podnapisi.search(ctx({ httpText: async () => ({ ok: false, status: 500, body: '' }) })), []);
  const tracks = await podnapisi.search(ctx({ httpText: async () => ({ ok: true, status: 200, body: '<html>not xml' }) }));
  assert.deepEqual(tracks, []);
});

/* ── local + registry ──────────────────────────────────────────────────── */

test('the sample provider exposes the bundled fixtures offline', async () => {
  const tracks = await local.search(ctx({ config: { LOCAL_MEDIA_ROOTS: [] } }));
  assert.ok(tracks.length >= 2, `expected the bundled samples, got ${tracks.length}`);
  assert.ok(tracks.every((t) => t.url.startsWith('sample:')));
  assert.ok(tracks.some((t) => t.lang === 'vi'));
  const resolved = await local.resolveDownload(tracks[0]);
  assert.ok(resolved.endsWith('.srt'));
});

test('guessLang reads language suffixes out of file names', () => {
  assert.equal(local.guessLang('Movie.2024.1080p.WEB-DL.en.srt'), 'en');
  assert.equal(local.guessLang('Movie.2024.1080p.WEB-DL.vie.srt'), 'vi');
  assert.equal(local.guessLang('Movie.2024.720p.WEB-DL.x264-GROUP.fr.ass'), 'fr');
});

test('listProviders reports configuration state', () => {
  const list = listProviders({ ENABLED_PROVIDERS: ['opensubtitles', 'local'], OPENSUBTITLES_API_KEY: 'x' });
  const os = list.find((p) => p.id === 'opensubtitles');
  assert.equal(os.enabled, true);
  assert.equal(os.configured, true);
  assert.equal(list.find((p) => p.id === 'subdl').enabled, false);
  assert.equal(list.find((p) => p.id === 'local').requiresKey, false);
});

test('searchAll isolates a provider that blows up', async () => {
  PROVIDERS.__boom = {
    meta: { id: '__boom', name: 'Boom', requiresKey: false, enabledByDefault: false },
    search: async () => { throw new Error('kaboom'); },
  };
  try {
    const tracks = await searchAll(ctx({ config: { LOCAL_MEDIA_ROOTS: [] } }), { providers: ['__boom', 'local'] });
    assert.ok(tracks.length >= 2, 'the healthy provider must still deliver');
  } finally {
    delete PROVIDERS.__boom;
  }
});

test('searchAll hides the demo samples as soon as a real source answers', async () => {
  PROVIDERS.__real = {
    meta: { id: '__real', name: 'Real', requiresKey: false, enabledByDefault: false },
    search: async () => [{
      id: 'real:1', provider: '__real', lang: 'en', url: 'https://x/a.srt', source: 'api',
      releaseName: 'Movie.2024.1080p.WEB-DL.x264-GROUP',
    }],
  };
  try {
    const withReal = await searchAll(ctx({ config: { LOCAL_MEDIA_ROOTS: [] } }), { providers: ['__real', 'local'] });
    assert.equal(withReal.length, 1);
    assert.equal(withReal[0].id, 'real:1');
    assert.ok(!withReal.some((t) => t.source === 'sample'), 'samples must not sit next to real results');

    const alone = await searchAll(ctx({ config: { LOCAL_MEDIA_ROOTS: [] } }), { providers: ['local'] });
    assert.ok(alone.length >= 2, 'with nothing else, the offline samples still make the addon demoable');
    assert.ok(alone.every((t) => t.source === 'sample'));
  } finally {
    delete PROVIDERS.__real;
  }
});

test('searchAll returns [] when nothing is enabled and never throws', async () => {
  assert.deepEqual(await searchAll(ctx(), { providers: [] }), []);
  assert.deepEqual(await searchAll(ctx(), { providers: ['does-not-exist'] }), []);
});

test('resolveTrackUrl handles scheme-less refs and refuses the impossible', async () => {
  const ok = await resolveTrackUrl({ id: 'local:x', provider: 'local', url: 'sample:demo.2024.1080p.WEB-DL.x264-DEMO.en.srt' }, ctx());
  assert.ok(ok.url.endsWith('.srt'));
  const direct = await resolveTrackUrl({ id: 'x', provider: 'subdl', url: 'https://dl.subdl.com/a.zip' }, ctx());
  assert.equal(direct.url, 'https://dl.subdl.com/a.zip');
  const impossible = await resolveTrackUrl({ id: 'x', provider: 'opensubtitles', url: 'osdl:1' }, ctx({ config: {}, httpJson: async () => ({}) }));
  assert.equal(impossible, null);
});
