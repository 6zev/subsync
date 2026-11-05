/**
 * Config parsing: list values from env/docker must survive being pasted as a single URL.
 * Regression for the colon separator that used to cut `https://…` into three "entries".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nuvio-config-'));
process.env.LOG_LEVEL = 'silent';
process.env.TOKEN_SECRET = 'config-test-secret-config-test-secret';
process.env.MEDIA_SOURCE_ADDON = 'https://debridmediamanager.com/api/stremio-tb/abc/manifest.json';
process.env.STREMIO_SUBTITLE_ADDONS = 'https://opensubtitles-v3.strem.io/manifest.json';
process.env.PREFERRED_LANGS = 'vi,en';
process.env.LOCAL_MEDIA_ROOTS = 'C:\\media';

const { getConfig, reloadConfig } = await import('../../src/env.js');

test('a single manifest URL stays one entry — colons are not list separators', () => {
  const config = reloadConfig();
  assert.deepEqual(config.MEDIA_SOURCE_ADDON, ['https://debridmediamanager.com/api/stremio-tb/abc/manifest.json']);
  assert.deepEqual(config.STREMIO_SUBTITLE_ADDONS, ['https://opensubtitles-v3.strem.io/manifest.json']);
});

test('commas still split short lists, and Windows drive letters survive', () => {
  const config = getConfig();
  assert.deepEqual(config.PREFERRED_LANGS, ['vi', 'en']);
  assert.deepEqual(config.LOCAL_MEDIA_ROOTS, ['C:\\media']);
});

test('one entry per line wins, and commas inside a line do not split it', () => {
  process.env.MEDIA_SOURCE_ADDON = 'https://a.example/manifest.json\nhttps://b.example/manifest.json';
  const config = reloadConfig();
  assert.deepEqual(config.MEDIA_SOURCE_ADDON, [
    'https://a.example/manifest.json',
    'https://b.example/manifest.json',
  ]);
});
