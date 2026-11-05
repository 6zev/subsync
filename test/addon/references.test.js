import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReferences, parseStremioId, parseExtra } from '../../src/addon/pipeline.js';

const track = (over) => ({
  id: over.id, provider: over.provider || 'test', lang: over.lang || 'en', url: 'https://x/a.srt',
  source: 'api', ...over,
});

test('selectReferences prefers the target language, then the best-ranked others', () => {
  const tracks = [
    track({ id: 'vi-ok', lang: 'vi', releaseName: 'Inception.2010.1080p.BluRay.x264' }),
    track({ id: 'vi-meh', lang: 'vi', releaseName: 'Totally.Other.Release.2019' }),
    track({ id: 'vi-3rd', lang: 'vi', releaseName: 'Inception.2010.1080p.BluRay.x264' }),
    track({ id: 'en-best', lang: 'en', releaseName: 'Inception.2010.1080p.BluRay.x264' }),
    track({ id: 'fr-ok', lang: 'fr', releaseName: 'Inception.2010' }),
  ];
  const picked = selectReferences(tracks, {
    excludeId: null, targetLang: 'vi', filename: 'Inception.2010.1080p.BluRay.x264.mkv', langs: ['vi', 'en'],
  });
  assert.equal(picked.length, 4);
  assert.equal(picked[0].lang, 'vi', 'own language first');
  assert.equal(picked[1].lang, 'vi');
  const langs = picked.map((p) => p.lang);
  assert.equal(langs.filter((l) => l === 'vi').length, 2, 'at most two per language');
  assert.ok(picked.some((p) => p.id === 'en-best'), 'the best other-language reference is kept');
});

test('selectReferences skips the track being synced and URL-less entries', () => {
  const picked = selectReferences([
    track({ id: 'self', lang: 'en' }),
    track({ id: 'nourl', lang: 'en', url: undefined }),
    track({ id: 'good', lang: 'fr' }),
  ], { excludeId: 'self', targetLang: 'en' });
  assert.deepEqual(picked.map((p) => p.id), ['good']);
});

test('selectReferences never returns more than the limit', () => {
  const many = Array.from({ length: 30 }, (_v, i) => track({ id: `t${i}`, lang: `l${i % 6}`, releaseName: `R${i}` }));
  assert.equal(selectReferences(many, { targetLang: 'l0', limit: 4 }).length, 4);
});

test('parseStremioId understands movies and episodes', () => {
  assert.deepEqual(parseStremioId('movie', 'tt1375666'), {
    raw: 'tt1375666', imdbId: 'tt1375666', tmdbId: null, type: 'movie', season: null, episode: null,
  });
  const episode = parseStremioId('series', 'tt0903747:5:14');
  assert.equal(episode.season, 5);
  assert.equal(episode.episode, 14);
  assert.equal(episode.imdbId, 'tt0903747');
  assert.equal(parseStremioId('movie', 'kitsu:1234').imdbId, null);
});

test('parseExtra decodes the URL-encoded extra segment Stremio sends', () => {
  const extra = parseExtra(encodeURIComponent('videoHash=abc123&videoSize=42&filename=A.mkv'));
  assert.equal(extra.videoHash, 'abc123');
  assert.equal(extra.videoSize, 42);
  assert.equal(extra.filename, 'A.mkv');
  assert.deepEqual(parseExtra(undefined, {}), { videoHash: null, videoSize: null, filename: null, videoID: null, season: null, episode: null });
});
