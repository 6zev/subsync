import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, jsonEmbed, renderConfigPage, renderSyncLabPage, renderLayout } from '../../src/web/pages.js';

const XSS = '<script>alert(1)</script>';

test('escapeHtml neutralises every HTML metacharacter', () => {
  assert.equal(escapeHtml(XSS), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('jsonEmbed cannot break out of a script block', () => {
  const embedded = jsonEmbed({ evil: '</script><img src=x onerror=alert(1)>' });
  assert.ok(!embedded.includes('</script>'));
  assert.ok(!embedded.includes('<img'));
  assert.equal(JSON.parse(embedded).evil, '</script><img src=x onerror=alert(1)>');
});

test('renderLayout emits a self-contained document without external assets', () => {
  const html = renderLayout({ title: 'x', body: '<p>hi</p>', script: 'var a=1;' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<p>hi<\/p>/);
  assert.match(html, /var a=1;/);
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/xmlns="[^"]*"/g, '')), 'no external URLs');
  assert.ok(!html.includes('cdn'));
});

test('the configure page renders the install URL and escapes every field', () => {
  const html = renderConfigPage({
    manifestUrl: `http://127.0.0.1:7878/manifest.json?x=${XSS}`,
    shareUrl: 'http://127.0.0.1:7878/abc/manifest.json',
    config: {
      SYNC_MODE: 'fast', AUTO_SYNC_BUDGET_MS: 9000, ALLOW_RATE: true, AUDIO_SYNC_ENABLED: false,
      SHOW_ONLY_PREFERRED: false, PREFERRED_LANGS: ['vi', 'en'], LLM_PROVIDER: '', LLM_MODEL: '',
      OPENSUBTITLES_API_KEY_MASK: 'abcd••••wxyz', LOCAL_MEDIA_ROOTS: [],
      STREMIO_SUBTITLE_ADDONS: ['https://a/manifest.json'], DEBRID_PROVIDER: '',
    },
    providers: [{ id: 'opensubtitles', name: 'OpenSubtitles', requiresKey: true, enabled: true }],
    stats: { offsets: 1, cachedSubs: 2, tracks: 3, events: 4, last24h: 5 },
  });
  assert.match(html, /id="installUrl"/);
  assert.match(html, /id="cfgForm"/);
  assert.match(html, /name="provider_opensubtitles"/);
  assert.match(html, /action="api\/config"/);
  assert.ok(!html.includes(XSS), 'the injected payload must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /abcd••••wxyz/);
});

test('the configure page degrades with no providers', () => {
  const html = renderConfigPage({
    manifestUrl: 'http://x/manifest.json', shareUrl: 'http://x/y/manifest.json',
    config: { PREFERRED_LANGS: [] }, providers: [], stats: {},
  });
  assert.match(html, /Không có provider nào/);
});

test('the sync lab renders the Nuvio flow controls and embeds the token safely', () => {
  const html = renderSyncLabPage({ token: `abc${XSS}` });
  for (const id of ['cues', 'clock', 'startBtn', 'autoFast', 'autoFull', 'applyManual', 'resetBtn', 'preview', 'mediaPath', 'trackSel']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(!html.includes(XSS));
  assert.match(html, /api\/synclab\/session/);
  assert.match(html, /api\/synclab\/apply/);
  assert.match(html, /api\/synclab\/auto/);
  assert.match(html, /var TOKEN=/);
  assert.ok(html.includes('\\u003c') || html.includes('&lt;'), 'token must be escaped either way');
});

test('the sync lab client reproduces the 300 ms reaction compensation', () => {
  const html = renderSyncLabPage({ token: 't' });
  assert.match(html, /cue\.start-300/);
  assert.match(html, /videoPositionMs/);
  assert.match(html, /cueStartMs/);
});
