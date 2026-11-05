import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTracks, dedupeTracks, scoreTrack, pickReferences } from '../../src/providers/rank.js';

const track = (over = {}) => ({
  id: over.id || `t${Math.random().toString(36).slice(2, 8)}`,
  provider: 'test',
  lang: 'en',
  url: 'https://example.com/a.srt',
  source: 'api',
  ...over,
});

const MEDIA = 'Movie.2024.1080p.WEB-DL.x264-GROUP.mkv';

test('a hash match outranks a release match which outranks a generic result', () => {
  const hash = track({ id: 'hash', lang: 'en', hash: 'd41d8cd98f00b204', releaseName: 'Totally.Different.Name.2024' });
  const release = track({ id: 'release', releaseName: 'Movie.2024.1080p.WEB-DL.x264-GROUP' });
  const generic = track({ id: 'generic', releaseName: 'Movie.2024.2160p.BluRay.REMUX.HEVC-OTHER' });

  const hashScore = scoreTrack(hash, { filename: MEDIA, videoHash: 'd41d8cd98f00b204', langs: ['en'] });
  const releaseScore = scoreTrack(release, { filename: MEDIA, langs: ['en'] });
  const genericScore = scoreTrack(generic, { filename: MEDIA, langs: ['en'] });
  assert.ok(hashScore > releaseScore, `${hashScore} > ${releaseScore}`);
  assert.ok(releaseScore > genericScore, `${releaseScore} > ${genericScore}`);

  const ranked = rankTracks([generic, hash, release], { filename: MEDIA, videoHash: 'd41d8cd98f00b204', langs: ['en'] });
  assert.deepEqual(ranked.map((t) => t.id), ['hash', 'release', 'generic']);
  assert.ok(ranked.every((t) => typeof t.rankScore === 'number'));
});

test('preferred languages sort first and penalties apply', () => {
  const vi = track({ id: 'vi', lang: 'vie' });
  const en = track({ id: 'en', lang: 'eng' });
  const ranked = rankTracks([en, vi], { langs: ['vi', 'en'] });
  assert.equal(ranked[0].id, 'vi');

  const mt = scoreTrack(track({ machineTranslated: true }), { langs: ['en'] });
  const plain = scoreTrack(track({}), { langs: ['en'] });
  assert.ok(mt < plain);
  const hi = scoreTrack(track({ hearingImpaired: true }), { langs: ['en'] });
  assert.ok(hi < plain);
});

test('episode mismatches are pushed down', () => {
  const good = track({ id: 'good', season: 2, episode: 5, releaseName: 'Show.S02E05.1080p' });
  const bad = track({ id: 'bad', season: 2, episode: 9, releaseName: 'Show.S02E09.1080p' });
  const ranked = rankTracks([bad, good], { type: 'series', season: 2, episode: 5, filename: 'Show.S02E05.1080p.WEB.mkv' });
  assert.equal(ranked[0].id, 'good');
  assert.ok(ranked[1].rankScore < ranked[0].rankScore);
});

test('dedupe keeps the strongest copy of the same release+language', () => {
  const a = track({ id: 'a', lang: 'en', releaseName: 'Movie.2024.1080p.WEB-DL', downloads: 5 });
  const b = track({ id: 'b', lang: 'en', releaseName: 'Movie.2024.1080p.WEB-DL', downloads: 900 });
  const c = track({ id: 'c', lang: 'en', releaseName: 'Movie.2024.1080p.WEB-DL', url: 'https://example.com/a.srt.diff' });
  const deduped = dedupeTracks([a, b, c]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'b');

  const byUrl = dedupeTracks([
    track({ id: 'x', lang: 'fr', releaseName: '', url: 'https://one.example/a.srt' }),
    track({ id: 'y', lang: 'fr', releaseName: '', url: 'https://two.example/b.srt' }),
  ]);
  assert.equal(byUrl.length, 2, 'different URLs are different subtitles');
});

test('tracks without a URL never make it out of the ranker', () => {
  assert.deepEqual(rankTracks([{ id: 'x', lang: 'en' }, track({ id: 'ok' })]).map((t) => t.id), ['ok']);
});

test('pickReferences returns one reference per language and skips the selected track', () => {
  const tracks = [
    track({ id: 'vi', lang: 'vi' }),
    track({ id: 'vi2', lang: 'vi' }),
    track({ id: 'en', lang: 'en' }),
    track({ id: 'fr', lang: 'fr' }),
    track({ id: 'self', lang: 'en' }),
  ];
  const refs = pickReferences(tracks, { excludeId: 'self', limit: 3 });
  assert.equal(refs.length, 3);
  assert.ok(!refs.some((r) => r.id === 'self'));
  assert.equal(new Set(refs.map((r) => r.lang)).size, 3);
});

test('rankTracks honours a limit', () => {
  const many = Array.from({ length: 20 }, (_v, i) => track({ id: `t${i}`, releaseName: `R${i}` }));
  assert.equal(rankTracks(many, { limit: 5 }).length, 5);
});
