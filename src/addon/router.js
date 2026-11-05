/**
 * HTTP router: pure function from a normalised request to a response, so the whole surface can
 * be exercised from tests without opening a socket.
 * Owned by LEAD. Contract: src/contracts.js §6.
 */
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { getConfig, publicConfig, saveConfig, PROJECT_ROOT, secretIsEphemeral } from '../env.js';
import { verifyToken, applyTokenPayload, configToTokenPayload, signToken } from './tokens.js';
import { buildManifest, LOGO_SVG, BACKGROUND_SVG } from './manifest.js';
import { handleSubtitlesRequest, parseExtra, serveSubtitle } from './pipeline.js';
import { listProviders } from '../providers/index.js';
import * as store from '../store/index.js';
import { renderConfigPage, renderSyncLabPage } from '../web/pages.js';
import * as lab from '../synclab/routes.js';
import { getBuildInfo } from '../buildinfo.js';
import { createLogger } from '../util/log.js';

const routerLog = createLogger('router');

const ROOTS = new Set(['manifest.json', 'subtitles', 's', 'configure', 'api', 'assets', 'synclab', 'healthz', 'stats', 'docs', 'favicon.ico', 'logo.svg', '']);

/**
 * @param {{method:string, pathname:string, query:Record<string,string>, headers:Record<string,string>,
 *          body?:string, baseUrl:string, log?:Function}} req
 * @returns {Promise<{status:number, body:string|Buffer, contentType:string, headers?:Record<string,string>}>}
 */
export async function route(req) {
  const log = req.log || routerLog;
  const method = (req.method || 'GET').toUpperCase();
  const baseConfig = getConfig();
  let segments = String(req.pathname || '/').split('/').filter(Boolean).map(decodeURIComponent);
  let config = baseConfig;
  let embedConfig = false;

  // Optional config prefix: /<token>/manifest.json
  if (segments.length && !ROOTS.has(segments[0])) {
    const payload = verifyToken(segments[0]);
    if (payload?.c) {
      config = applyTokenPayload(baseConfig, payload.c);
      embedConfig = true;
      segments = segments.slice(1);
    } else if (payload?.v) {
      // A bare subtitle token dropped at the root — send the user to the Sync Lab with it.
      return redirect(`/synclab?t=${encodeURIComponent(segments[0])}`);
    }
  }

  const root = segments[0] || '';
  const baseUrl = req.baseUrl || '';

  try {
    switch (root) {
      case '':
        if (method === 'GET') return redirect('/configure');

        break;
      case 'healthz': {
        const build = getBuildInfo();
        return json(200, {
          ok: true,
          version: (await import('./manifest.js')).ADDON_VERSION,
          build: { sha: build.sha, shortSha: build.shortSha, builtAt: build.builtAt, source: build.source },
          uptime: Math.round(process.uptime()),
        });
      }

      case 'stats':
        return json(200, {
          ok: true,
          build: getBuildInfo(),
          uptime: Math.round(process.uptime()),
          stats: store.stats(),
          config: publicConfig(config),
          events: store.recentEvents(20),
        });

      case 'manifest.json':
        return json(200, buildManifest({ baseUrl }));

      case 'assets':
        return serveAsset(segments.slice(1).join('/'));

      case 'favicon.ico':
        return { status: 200, body: LOGO_SVG, contentType: 'image/svg+xml', headers: { 'cache-control': 'public, max-age=86400' } };

      case 'docs': {
        let name = segments.slice(1).join('/').replace(/\.\./g, '');
        // The friendly form has no extension (/docs/nuvio-parity is what the pages link to);
        // the file on disk is .md.
        if (name && !/\.[a-z0-9]+$/i.test(name)) name = `${name}.md`;
        if (!name) return json(200, { ok: true, docs: await listDocs() });
        if (!/^[\w.-]+\.md$/.test(name)) return text(404, 'not found');
        const body = await readFile(join(PROJECT_ROOT, 'docs', normalize(name)), 'utf8').catch(() => null);
        return body ? { status: 200, body, contentType: 'text/markdown; charset=utf-8' } : text(404, `no such doc: ${name}\n`);
      }

      case 'configure':
        return { status: 200, body: renderConfigPage({
          manifestUrl: `${baseUrl}/manifest.json`,
          shareUrl: `${baseUrl}/${signToken({ c: configToTokenPayload(config) })}/manifest.json`,
          config: publicConfig(config),
          providers: listProviders(config),
          stats: store.stats(),
          build: getBuildInfo(),
          uptime: Math.round(process.uptime()),
          secretIsEphemeral: secretIsEphemeral(),
          insecure: isPlainRemoteHttp(baseUrl),
        }), contentType: 'text/html; charset=utf-8' };

      case 'api':
        return handleApi({ method, segments: segments.slice(1), query: req.query, body: req.body, baseConfig: config, baseUrl, log });

      case 'synclab': {
        const token = req.query.t;
        if (!token) return text(400, 'missing ?t= token — open the Sync Lab from the addon configuration page');
        return { status: 200, body: renderSyncLabPage({ token }), contentType: 'text/html; charset=utf-8' };
      }

      case 'subtitles': {
        if (method !== 'GET') return text(405, 'method not allowed');
        const [, type, rawId, extraSegment] = segments;
        if (!type || !rawId) return json(400, { err: 'bad request' });
        const id = rawId.replace(/\.json$/i, '');
        const extra = parseExtra(extraSegment?.replace(/\.json$/i, ''), req.query);
        if (extra.season != null) { /* explicit */
        }
        const result = await handleSubtitlesRequest({ type, id, extra, config, baseUrl, embedConfig, log });
        return json(200, { subtitles: result.subtitles });
      }

      case 's': {
        const [, token, ...rest] = segments;
        const filename = rest.join('/') || 'subtitle.srt';
        const response = await serveSubtitle({ token, filename, baseConfig: config, log });
        return response;
      }

      default:
        break;
    }
  } catch (err) {
    log.error(`route ${req.method} ${req.pathname} failed: ${err.message}`, { stack: err.stack?.split('\n').slice(0, 3) });
    return json(500, { ok: false, error: err.message });
  }
  return text(404, 'not found');
}

async function handleApi({ method, segments, query, body, baseConfig, log }) {
  const [head, ...rest] = segments;

  if (head === 'config') {
    if (method === 'GET') {
      return json(200, {
        ok: true,
        config: publicConfig(baseConfig),
        providers: listProviders(baseConfig),
        stats: store.stats(),
      });
    }
    if (method === 'POST') {
      const patch = parseBody(body, log);
      if (!patch) return json(400, { ok: false, error: 'invalid JSON body' });
      const next = saveConfig(patch);
      return json(200, { ok: true, config: publicConfig(next), restartHint: 'các thay đổi có hiệu lực ngay / changes apply immediately' });
    }
    return json(405, { ok: false, error: 'method not allowed' });
  }

  if (head === 'synclab') {
    const action = rest[0] || '';
    if (action === 'session' && method === 'GET') return lab.getSession({ token: query.t, baseConfig });
    if (action === 'cues' && method === 'GET') {
      return lab.getCues({
        token: query.t,
        trackId: query.trackId,
        fromMs: query.fromMs,
        toMs: query.toMs,
        limit: query.limit,
        baseConfig,
      });
    }
    if (action === 'tracks' && method === 'GET') return lab.getTracks({ token: query.t, baseConfig });
    if (action === 'preview' && method === 'GET') return lab.getPreview({ token: query.t, trackId: query.trackId, baseConfig });
    if (method === 'POST') {
      const payload = parseBody(body, log);
      if (!payload) return json(400, { ok: false, error: 'invalid JSON body' });
      if (action === 'apply') return lab.postApply({ body: payload, baseConfig });
      if (action === 'auto') return lab.postAuto({ body: payload, baseConfig });
      if (action === 'media') return lab.postMedia({ body: payload, baseConfig });
    }
    return json(404, { ok: false, error: `unknown synclab action "${action}"` });
  }

  if (head === 'sync' && rest[0] === 'state' && method === 'GET') {
    return json(200, { ok: true, events: store.recentEvents(50), offsets: store.listRecentOffsets(50) });
  }

  return json(404, { ok: false, error: 'unknown api endpoint' });
}

function parseBody(body, log) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    log?.('warn', `invalid JSON body: ${err.message}`);
    return null;
  }
}

/**
 * Stremio Web (https://web.stremio.com) refuses to fetch an http:// addon — mixed content — so a
 * deployment reached over plain HTTP from a non-local host can only be installed in Stremio
 * Desktop/mobile. Worth saying out loud instead of leaving people staring at a NetworkError.
 * @param {string} baseUrl
 */
function isPlainRemoteHttp(baseUrl) {
  if (!/^http:\/\//i.test(baseUrl || '')) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}

/** Markdown files shipped in docs/, used by the docs index. */
async function listDocs() {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(PROJECT_ROOT, 'docs')).catch(() => []);
  return files.filter((f) => f.endsWith('.md')).sort().map((f) => `/docs/${f.replace(/\.md$/, '')}`);
}

async function serveAsset(name) {
  if (name === 'logo.svg') {
    return { status: 200, body: LOGO_SVG, contentType: 'image/svg+xml', headers: { 'cache-control': 'public, max-age=86400' } };
  }
  if (name === 'background.svg') {
    return { status: 200, body: BACKGROUND_SVG, contentType: 'image/svg+xml', headers: { 'cache-control': 'public, max-age=86400' } };
  }
  const safe = join(PROJECT_ROOT, 'public', normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!safe.startsWith(join(PROJECT_ROOT, 'public'))) return text(403, 'forbidden');
  try {
    const body = await readFile(safe);
    return { status: 200, body, contentType: mimeFor(safe), headers: { 'cache-control': 'public, max-age=3600' } };
  } catch {
    return text(404, 'not found');
  }
}

function mimeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

const json = (status, payload) => ({
  status,
  body: JSON.stringify(payload),
  contentType: 'application/json; charset=utf-8',
  headers: { 'cache-control': 'no-store' },
});

const text = (status, message) => ({ status, body: message, contentType: 'text/plain; charset=utf-8' });

const redirect = (location) => ({ status: 302, body: '', contentType: 'text/plain', headers: { location } });
