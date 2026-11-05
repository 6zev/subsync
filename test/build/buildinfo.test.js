import test from 'node:test';
import assert from 'node:assert/strict';
import { getBuildInfo, buildLabel } from '../../src/buildinfo.js';

test('build info reports a real revision and its source', () => {
  const info = getBuildInfo();
  assert.equal(typeof info.version, 'string');
  assert.equal(typeof info.sha, 'string');
  assert.equal(typeof info.shortSha, 'string');
  assert.ok(['env', 'git', 'unknown'].includes(info.source));
  if (info.source === 'git') {
    assert.match(info.sha, /^[0-9a-f]{40}$/, `expected a full git sha, got ${info.sha}`);
    assert.equal(info.shortSha, info.sha.slice(0, 7));
  }
  assert.equal(typeof buildLabel(), 'string');
  assert.ok(buildLabel().includes(info.shortSha));
});

test('GIT_SHA and BUILD_TIME from the environment win — this is how the image reports itself', async () => {
  const before = { sha: process.env.GIT_SHA, at: process.env.BUILD_TIME };
  process.env.GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
  process.env.BUILD_TIME = '2026-11-05T09:00:00Z';
  // A fresh module instance is what a container process sees at boot.
  const fresh = await import(`../../src/buildinfo.js?fresh=${Date.now()}`);
  const info = fresh.getBuildInfo();
  assert.equal(info.source, 'env');
  assert.equal(info.sha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(info.shortSha, '0123456');
  assert.equal(info.builtAt, '2026-11-05T09:00:00Z');
  if (before.sha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = before.sha;
  if (before.at === undefined) delete process.env.BUILD_TIME; else process.env.BUILD_TIME = before.at;
});

test('an unknown build degrades instead of throwing', async () => {
  const before = process.env.GIT_SHA;
  process.env.GIT_SHA = 'not-a-sha';
  const fresh = await import(`../../src/buildinfo.js?unknown=${Date.now()}`);
  assert.equal(fresh.getBuildInfo().shortSha, 'not-a-s');
  if (before === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = before;
});
