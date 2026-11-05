import test from 'node:test';
import assert from 'node:assert/strict';
import * as subsense from '../../src/providers/subsense.js';
import { rankTracks } from '../../src/providers/rank.js';

const noop = () => {};

function ctx(overrides = {}) {
  return {
    type: 'movie',
    imdbId: 'tt1375666',
    langs: ['vi', 'en'],
    config: {},
    log: noop,
    ...overrides,
  };
}

/** Shape confirmed against the live public instance (2026-11). */
const PAYLOAD = {
  subtitles: [
    {
      id: 'subsense-srt-opensubtitles-eng-0',
      url: 'https://sub.wyzie.io/c/19b40c5b/id/1952382875?format=srt&encoding=UTF-8',
      lang: 'eng',
      label: 'OpenSubtitles · [SRT] · Inception.2010.1080p.BluRay.x264',
      source: 'opensubtitles',
      fileName: 'Inception.2010.1080p.BluRay.x264.srt',
      releaseName: 'Inception.2010.1080p.BluRay.x264',
      releases: ['Inception.2010.1080p.BluRay.x264'],
    },
    {
      id: 'subsense-srt-opensubtitles-eng-1',
      url: 'https://dl.opensubtitles.org/en/download/src-api/vrf-19c10c5b/file/1952382875.srt',
      lang: 'eng',
      label: 'OpenSubtitles · [SRT] · Inception.2010.1080p.BluRay.x264',
      fileName: 'Inception.2010.1080p.BluRay.x264.srt',
      releaseName: 'Inception.2010.1080p.BluRay.x264',
    },
    {
      id: 'subsense-vtt-opensubtitles-eng-2',
      url: 'https://sub.wyzie.io/c/x/id/1?format=vtt',
      lang: 'eng',
      fileName: 'Inception.2010.1080p.BluRay.x264.vtt',
      releaseName: 'Inception.2010.1080p.BluRay.x264',
    },
    { id: 'subsense-srt-opensubtitles-fre-3', url: 'https://example.com/fr.srt', lang: 'fre', fileName: 'fr.srt' },
    { id: 'subsense-srt-opensubtitles-eng-4', url: 'javascript:alert(1)', lang: 'eng' },
    { id: 'subsense-srt-opensubtitles-eng-5', lang: 'eng' },
    'https://dl.opensubtitles.org/direct.srt',
  ],
};

test('subsense builds the plaintext JSON config its parseConfigParam() accepts', () => {
  const param = subsense.buildConfigParam({ languages: ['vi', 'en'], maxSubtitles: 10 });
  const decoded = JSON.parse(decodeURIComponent(param));
  assert.deepEqual(decoded.languages, ['vi', 'en']);
  assert.equal(decoded.maxSubtitles, 10);
  assert.ok(decoded.userId);
  assert.equal(subsense.buildConfigParam({ raw: 'RAWSEGMENT' }), 'RAWSEGMENT', 'an escaped config wins');
});

test('subsense maps results, filters languages and rejects non-http URLs', async () => {
  let called = '';
  const httpJson = async (url) => { called = url; return PAYLOAD; };
  const tracks = await subsense.search(ctx({ httpJson }));

  assert.ok(called.startsWith('https://subsense.nepiraw.com/'), called);
  assert.ok(called.includes('/subtitles/movie/tt1375666.json'), called);

  // fre is filtered out, javascript: is rejected, the URL-less entry and the bare string
  // (which carries no language) cannot be served.
  assert.equal(tracks.length, 3);
  assert.ok(tracks.every((t) => t.provider === 'subsense' && t.lang === 'en'));
  assert.ok(tracks.every((t) => t.id.startsWith('subsense:subsense-')));
  assert.equal(tracks[0].format, 'srt');
  assert.equal(tracks[0].filename, 'Inception.2010.1080p.BluRay.x264.srt');
});

test('subsense ranks the watermarked proxy below the direct mirror of the same subtitle', () => {
  const tracks = [
    { id: 'a', provider: 'subsense', lang: 'en', url: 'https://sub.wyzie.io/x?format=srt', score: 0.35,
      releaseName: 'Inception.2010.1080p.BluRay.x264', extra: { watermarked: true } },
    { id: 'b', provider: 'subsense', lang: 'en', url: 'https://dl.opensubtitles.org/y.srt', score: 1,
      releaseName: 'Inception.2010.1080p.BluRay.x264' },
  ];
  const ranked = rankTracks(tracks, { filename: 'Inception.2010.1080p.BluRay.x264.mkv', langs: ['en'] });
  assert.equal(ranked[0].id, 'b', 'the clean mirror must win the tie');
});

test('subsense builds the series id the way Stremio does', async () => {
  let seen = '';
  await subsense.search(ctx({ type: 'series', imdbId: 'tt0903747', season: 1, episode: 1, httpJson: async (url) => { seen = url; return { subtitles: [] }; } }));
  assert.ok(seen.includes(encodeURIComponent('tt0903747:1:1')), seen);
  assert.ok(seen.includes('/subtitles/series/'), seen);
});

test('subsense passes the video fingerprint through as extra', async () => {
  let seen = '';
  await subsense.search(ctx({
    videoHash: 'd41d8cd98f00b204', videoSize: 123456789, filename: 'x.mkv',
    httpJson: async (url) => { seen = decodeURIComponent(url); return { subtitles: [] }; },
  }));
  assert.ok(seen.includes('videoHash=d41d8cd98f00b204'), seen);
  assert.ok(seen.includes('videoSize=123456789'), seen);
});

test('subsense survives outages and junk payloads', async () => {
  assert.deepEqual(await subsense.search(ctx({ httpJson: async () => { throw new Error('HTTP 502'); } })), []);
  assert.deepEqual(await subsense.search(ctx({ httpJson: async () => ({ subtitles: 'nope' }) })), []);
  assert.deepEqual(await subsense.search(ctx({ httpJson: async () => null })), []);
  assert.deepEqual(await subsense.search(ctx({ imdbId: '', httpJson: async () => PAYLOAD })), []);
});

test('subsense respects a self-hosted base URL and a raw config segment', async () => {
  let seen = '';
  const httpJson = async (url) => { seen = url; return { subtitles: [] }; };
  await subsense.search(ctx({ httpJson, config: { SUBSENSE_URL: 'http://192.168.1.5:3100/', SUBSENSE_CONFIG_PARAM: 'MYSECRET' } }));
  assert.ok(seen.startsWith('http://192.168.1.5:3100/MYSECRET/subtitles/'), seen);
});

/* ── download rewriting (evidence-based, see the doc comment in the module) ── */

test('resolveDownload routes raw upstream links through the SubSense proxy, unencoded', async () => {
  const track = {
    id: 'subsense:subsense-srt-opensubtitles-eng-1',
    provider: 'subsense',
    url: 'https://dl.opensubtitles.org/en/download/src-api/vrf-19c10c5b/file/1952382875.srt',
    extra: { base: 'https://subsense.nepiraw.com' },
  };
  const url = await subsense.resolveDownload(track, ctx());
  assert.equal(url, 'https://subsense.nepiraw.com/api/subtitle/srt/https://dl.opensubtitles.org/en/download/src-api/vrf-19c10c5b/file/1952382875.srt');
  assert.ok(!url.endsWith('%2Fsrt'), 'the inner URL must not be percent-encoded — SubSense says "invalid URL"');
});

test('resolveDownload unwraps links that point at the player own machine', async () => {
  const track = {
    id: 'subsense:x',
    provider: 'subsense',
    url: 'http://127.0.0.1:11470/subtitles.srt?from=https%3A%2F%2Fdl.opensubtitles.org%2Fen%2Fdownload%2Fsrc-api%2Fvrf-19%2Ffile%2F1.srt',
    extra: { base: 'https://subsense.nepiraw.com' },
  };
  const url = await subsense.resolveDownload(track, ctx());
  assert.ok(url.startsWith('https://subsense.nepiraw.com/api/subtitle/srt/https://dl.opensubtitles.org/'), url);
  assert.ok(!url.includes('127.0.0.1'), url);
});

test('resolveDownload passes SubSense-hosted links through and honours a self-hosted base', async () => {
  const hosted = { id: 'x', provider: 'subsense', url: 'https://subsense.nepiraw.com/api/yify/proxy/abc', extra: {} };
  assert.equal(await subsense.resolveDownload(hosted, ctx()), 'https://subsense.nepiraw.com/api/yify/proxy/abc');

  const local = { id: 'x', provider: 'subsense', url: 'https://raw.example/a.srt', extra: {} };
  const url = await subsense.resolveDownload(local, ctx({ config: { SUBSENSE_URL: 'http://192.168.1.5:3100' } }));
  assert.equal(url, 'http://192.168.1.5:3100/api/subtitle/srt/https://raw.example/a.srt');
});

test('resolveDownload gives up on a local link with nothing to unwrap', async () => {
  const track = { id: 'x', provider: 'subsense', url: 'http://localhost:9999/nothing', extra: {} };
  assert.equal(await subsense.resolveDownload(track, ctx()), null);
});

test('resolveTrackUrl rewrites SubSense http links but leaves plain providers alone', async () => {
  const { resolveTrackUrl } = await import('../../src/providers/index.js');
  const subsenseTrack = {
    id: 'subsense:x', provider: 'subsense', url: 'http://127.0.0.1:11470/subtitles.srt?from=https%3A%2F%2Fdl.opensubtitles.org%2Fa.srt',
    extra: {},
  };
  const rewritten = await resolveTrackUrl(subsenseTrack, ctx());
  assert.ok(rewritten.url.startsWith('https://subsense.nepiraw.com/api/subtitle/srt/https://dl.opensubtitles.org/'), rewritten.url);

  const plain = await resolveTrackUrl({ id: 'x', provider: 'subdl', url: 'https://dl.subdl.com/a.zip' }, ctx());
  assert.equal(plain.url, 'https://dl.subdl.com/a.zip', 'an ordinary provider URL is passed through untouched');
});
