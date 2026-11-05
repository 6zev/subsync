/**
 * The "borrow the media source from the user's own stream addon" path — driven against a real
 * (stub) HTTP addon so the URL shapes are exercised for real.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nuvio-media-'));
process.env.LOG_LEVEL = 'silent';

const { resolveFromStreamAddon, listStreamsFromAddons, clearStreamListCache, safeHost } = await import('../../src/media/stream-addon.js');
const { saveConfig, getConfig, reloadConfig } = await import('../../src/env.js');
const { resolveMedia } = await import('../../src/media/index.js');

const TARGET_NAME = 'Inception.2010.1080p.BluRay.x264-SPARKS.mkv';
const DIRECT = 'https://debrid-cdn.example/d/AAAA/Inception.2010.1080p.BluRay.x264-SPARKS.mkv?token=secret';

let base = '';
let server;
let listHits = 0;

before(async () => {
  server = createServer((req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/manifest.json') return send(200, { id: 'stub.stream', resources: ['stream'], types: ['movie'] });
    if (req.url === '/stream/movie/tt137.json') {
      return send(200, {
        streams: [
          { name: 'StubQuery', title: 'Inception.2010.720p.WEB-DL-SOMETHING', url: 'https://debrid-cdn.example/d/BBBB/other.mkv' },
          { name: 'StubQuery', title: 'Inception.2010.1080p.BluRay.x264-SPARKS', url: DIRECT },
          { name: 'StubQuery', title: 'no url at all', infoHash: 'b2f9bafe72d33707bf9e6b7c5e018cefbb54ef50' },
        ],
      });
    }
    if (req.url === '/stream/movie/ttHASH.json') {
      return send(200, { streams: [{ name: 'StubQuery', title: 'Inception.2010.1080p.BluRay', infoHash: 'B2F9BAFE72D33707BF9E6B7C5E018CEFBB54EF50', fileIdx: 2 }] });
    }
    if (req.url === '/stream/movie/ttBOOM.json') return send(500, { error: 'boom' });
    if (req.url === '/stream/movie/ttLIST.json') {
      return send(200, {
        streams: [
          { name: 'A', title: 'playable one', url: 'https://cdn.example/a.mkv' },
          { name: 'A', title: 'the same link again', url: 'https://cdn.example/a.mkv' },
          { name: 'B', title: 'hashed', infoHash: 'B2F9BAFE72D33707BF9E6B7C5E018CEFBB54EF50', fileIdx: 1 },
          { name: 'C', title: 'not http', url: 'javascript:alert(1)' },
          { name: 'D', title: 'bad hash', infoHash: 'nope' },
          { name: 'E', title: 'magnet url', url: 'magnet:?xt=urn:btih:abc' },
          null,
        ],
      });
    }
    if (req.url === '/stream/movie/ttCACHE.json') {
      listHits += 1;
      return send(200, { streams: [{ name: 'A', title: `hit ${listHits}`, url: 'https://cdn.example/c.mkv' }] });
    }
    return send(404, { error: 'nope' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('picks the stream whose release matches the file being played', async () => {
  const result = await resolveFromStreamAddon({
    manifestUrl: `${base}/manifest.json`, type: 'movie', id: 'tt137', filename: TARGET_NAME, log: () => {},
  });
  assert.equal(result.kind, 'url');
  assert.equal(result.url, DIRECT);
  assert.match(result.reason, /stream addon/);
});

test('falls back to the infohash when the addon has no debrid configured', async () => {
  const result = await resolveFromStreamAddon({
    manifestUrl: `${base}/manifest.json`, type: 'movie', id: 'ttHASH', filename: TARGET_NAME, log: () => {},
  });
  assert.equal(result.kind, 'infohash');
  assert.equal(result.infoHash, 'b2f9bafe72d33707bf9e6b7c5e018cefbb54ef50', 'lower-cased');
  assert.equal(result.fileIdx, 2);
});

test('a broken or unknown addon degrades to none instead of throwing', async () => {
  for (const [manifestUrl, id] of [[`${base}/manifest.json`, 'ttBOOM'], [`${base}/manifest.json`, 'tt404'], ['', 'tt137']]) {
    const result = await resolveFromStreamAddon({ manifestUrl, type: 'movie', id, filename: TARGET_NAME, log: () => {} });
    assert.equal(result.kind, 'none');
    assert.ok(result.reason.length > 0);
  }
  const offline = await resolveFromStreamAddon({
    manifestUrl: 'http://127.0.0.1:1/manifest.json', type: 'movie', id: 'tt137', timeoutMs: 1500, log: () => {},
  });
  assert.equal(offline.kind, 'none');
});

test('debrid links never leak into logs', () => {
  assert.equal(safeHost(DIRECT), 'debrid-cdn.example');
  assert.ok(!safeHost(DIRECT).includes('token'));
  assert.equal(safeHost('not a url'), 'invalid-url');
});

test('pickBest chooses by release name, not by order', async () => {
  const { __internal } = await import('../../src/media/stream-addon.js');
  const picked = __internal.pickBest([
    { title: 'totally unrelated 2160p', url: 'https://x/1.mkv' },
    { title: 'Inception.2010.1080p.BluRay.x264-SPARKS', url: 'https://x/2.mkv' },
  ], TARGET_NAME);
  assert.equal(picked.url, 'https://x/2.mkv');
});

test('resolveMedia prefers the stream addon over our own debrid key', async () => {
  reloadConfig();
  saveConfig({ MEDIA_SOURCE_ADDON: [`${base}/manifest.json`], DEBRID_PROVIDER: '', DEBRID_API_KEY: '' });
  assert.deepEqual(getConfig().MEDIA_SOURCE_ADDON, [`${base}/manifest.json`]);

  const media = await resolveMedia({
    videoKey: 'h:aaaabbbbccccdddd:42', type: 'movie', id: 'tt137', filename: TARGET_NAME,
  });
  assert.equal(media.kind, 'url');
  assert.equal(media.path, DIRECT);
  assert.match(media.reason, /stream addon/);

  // Second call comes from the kv cache, so it must not need the network again.
  const again = await resolveMedia({ videoKey: 'h:aaaabbbbccccdddd:42', type: 'movie', id: 'tt137' });
  assert.equal(again.path, DIRECT);
});

test('with nothing configured, resolveMedia says so plainly', async () => {
  reloadConfig();
  saveConfig({ MEDIA_SOURCE_ADDON: [], LOCAL_MEDIA_ROOTS: [], DEBRID_PROVIDER: '', DEBRID_API_KEY: '' });
  const media = await resolveMedia({ videoKey: 'h:eeeeffff00001111:1', type: 'movie', id: 'nope' });
  assert.equal(media.kind, 'none');
  assert.match(media.reason, /no local file, URL or debrid magnet/);
});

/* ── picking the right file out of a real addon's decorated titles ── */

test('candidateLabels pulls the file name out of Debrid Media Manager style titles', async () => {
  const { candidateLabels, cleanLabel } = (await import('../../src/media/stream-addon.js')).__internal;
  const dmm = candidateLabels({
    title: 'Joker.Folie.a.Deux.2024.2160p.U-HDRemux.HDR.DV-TheEqualizer.mkv\nDD 5.1 • 🇷🇺 🇬🇧\n🎬 DMM Cast TB',
    name: '4K • HEVC • 64.08 GB',
    behaviorHints: { filename: 'Joker.Folie.a.Deux.2024.2160p.U-HDRemux.HDR.DV-TheEqualizer.mkv' },
  });
  assert.equal(dmm[0], 'Joker.Folie.a.Deux.2024.2160p.U-HDRemux.HDR.DV-TheEqualizer.mkv');
  assert.ok(!dmm.some((l) => /[🇷🇺🎬•]/.test(l)), `decoration leaked: ${JSON.stringify(dmm)}`);

  const multiLine = candidateLabels({ title: 'Joker Folie à Deux 2024 BluRay 2160p UHD MULTi -\nREMUX HEVC (10bit) DV Atmos-Aisha\nTrueHD 7.1 • more' });
  assert.equal(multiLine[0], 'Joker Folie à Deux 2024 BluRay 2160p UHD MULTi');

  assert.equal(cleanLabel(''), '');
  assert.equal(cleanLabel(null), '');
  assert.equal(cleanLabel('🎬   '), '');
});

test('the matching stream wins even when it is not first in the list', async () => {
  const { __internal } = await import('../../src/media/stream-addon.js');
  const filename = 'Joker.Folie.a.Deux.2024.2160p.UHD.BluRay.REMUX.HDR.MULTi.mkv';
  const picked = __internal.pickBest([
    { title: 'Joker.Folie.a.Deux.2024.1080p.WEB-DL.x264-OTHER\nAAC 2.0', url: 'https://x/a' },
    { title: 'cast a file inside a torrent', url: 'https://x/b' },
    { title: `${filename}\nDD 5.1 • more`, url: 'https://x/c' },
  ], filename);
  assert.equal(picked.url, 'https://x/c');
});

test('a stream addon answering with a different release is refused while a local file is playing', async () => {
  const { resolveMedia } = await import('../../src/media/index.js');
  const videoKey = 'h:1122334455667788:99';
  const { saveConfig, reloadConfig } = await import('../../src/env.js');
  reloadConfig();
  saveConfig({ MEDIA_SOURCE_ADDON: [`${base}/manifest.json`], LOCAL_MEDIA_ROOTS: [], DEBRID_PROVIDER: '', DEBRID_API_KEY: '' });
  // tt137 answers with an Inception release; ask for a completely unrelated file.
  const media = await resolveMedia({
    videoKey, type: 'movie', id: 'tt137', filename: 'Some.Totally.Different.Movie.1999.720p.mkv',
  });
  assert.equal(media.kind, 'none', 'must not align against an unrelated release');
  assert.match(media.reason, /no local file/);
});

/* ── our own /stream resource: relaying the user's stream addon ── */

test('listStreamsFromAddons flattens, de-duplicates and drops unplayable entries', async () => {
  const streams = await listStreamsFromAddons({
    manifestUrls: [`${base}/manifest.json`, `${base}/manifest.json`],
    type: 'movie', id: 'ttLIST', log: () => {},
  });
  assert.equal(streams.length, 2, JSON.stringify(streams));
  assert.equal(streams[0].url, 'https://cdn.example/a.mkv');
  assert.equal(streams[1].infoHash, 'b2f9bafe72d33707bf9e6b7c5e018cefbb54ef50');
  assert.equal(streams[1].fileIdx, 1);
  assert.ok(streams.every((s) => s.url || s.infoHash));
});

test('listStreamsFromAddons is empty when no addon is configured or it fails', async () => {
  assert.deepEqual(await listStreamsFromAddons({ manifestUrls: [], type: 'movie', id: 'tt137' }), []);
  const broken = await listStreamsFromAddons({
    manifestUrls: ['', `${base}/manifest.json`], type: 'movie', id: 'ttBOOM', log: () => {},
  });
  assert.deepEqual(broken, []);
});

test('consecutive stream requests hit a short cache instead of the addon', async () => {
  clearStreamListCache();
  listHits = 0;
  const urls = [`${base}/manifest.json`];
  const first = await listStreamsFromAddons({ manifestUrls: urls, type: 'movie', id: 'ttCACHE', log: () => {} });
  const second = await listStreamsFromAddons({ manifestUrls: urls, type: 'movie', id: 'ttCACHE', log: () => {} });
  assert.equal(listHits, 1, 'second call must be served from cache');
  assert.deepEqual(second, first);
  clearStreamListCache();
  await listStreamsFromAddons({ manifestUrls: urls, type: 'movie', id: 'ttCACHE', log: () => {} });
  assert.equal(listHits, 2, 'clearing the cache forces a fresh answer');
});
