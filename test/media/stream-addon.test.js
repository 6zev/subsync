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

const { resolveFromStreamAddon, safeHost } = await import('../../src/media/stream-addon.js');
const { saveConfig, getConfig, reloadConfig } = await import('../../src/env.js');
const { resolveMedia } = await import('../../src/media/index.js');

const TARGET_NAME = 'Inception.2010.1080p.BluRay.x264-SPARKS.mkv';
const DIRECT = 'https://debrid-cdn.example/d/AAAA/Inception.2010.1080p.BluRay.x264-SPARKS.mkv?token=secret';

let base = '';
let server;

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
