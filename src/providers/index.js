/**
 * Provider registry: one place that knows which sources exist and how to run them safely.
 * A provider outage must never break playback, so every call is isolated and time-boxed.
 * Owned by LEAD. Contract: src/contracts.js §2.
 */
import { httpJson, httpText, withTimeout } from '../util/http.js';
import { createLogger } from '../util/log.js';
import { rankTracks } from './rank.js';

import * as opensubtitles from './opensubtitles.js';
import * as subdl from './subdl.js';
import * as podnapisi from './podnapisi.js';
import * as addonProxy from './addon-proxy.js';
import * as local from './local.js';
import * as subsense from './subsense.js';

const providerLog = createLogger('providers');

/** @type {Record<string, any>} */
export const PROVIDERS = {
  opensubtitles,
  subsense,
  subdl,
  podnapisi,
  addons: addonProxy,
  local,
};

/** Display order and the id used in config/tokens. */
export const PROVIDER_ORDER = ['opensubtitles', 'subsense', 'subdl', 'podnapisi', 'addons', 'local'];

/** @returns {Array<{id:string,name:string,requiresKey:boolean,enabledByDefault:boolean,enabled:boolean,configured:boolean}>} */
export function listProviders(config = {}) {
  const enabledIds = config.ENABLED_PROVIDERS || [];
  return PROVIDER_ORDER
    .filter((id) => PROVIDERS[id])
    .map((id) => {
      const { meta } = PROVIDERS[id];
      const configured = !meta.requiresKey || Boolean(meta.keyEnv && config[meta.keyEnv]);
      return {
        id,
        name: meta.name,
        requiresKey: Boolean(meta.requiresKey),
        enabledByDefault: Boolean(meta.enabledByDefault),
        enabled: enabledIds.includes(id),
        configured,
        docs: meta.docs,
      };
    });
}

/** @returns {any|null} */
export function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * @param {Omit<import('../contracts.js').ProviderSearchContext,'httpJson'|'httpText'|'log'>} baseCtx
 * @param {{providers?:string[], perProviderTimeoutMs?:number, totalTimeoutMs?:number, log?:Function}} [opts]
 * @returns {Promise<import('../contracts.js').SubtitleTrack[]>}
 */
export async function searchAll(baseCtx, opts = {}) {
  const log = opts.log || baseCtx.log || providerLog;
  const config = baseCtx.config || {};
  const enabled = (opts.providers || config.ENABLED_PROVIDERS || []).filter((id) => PROVIDERS[id]);
  if (!enabled.length) {
    log('warn', 'no subtitle provider is enabled');
    return [];
  }

  const tasks = enabled.map((id) => runProvider(id, baseCtx, { timeoutMs: opts.perProviderTimeoutMs ?? 15000 }));
  const settled = await Promise.allSettled(tasks);
  const merged = [];
  settled.forEach((result, index) => {
    const id = enabled[index];
    if (result.status === 'fulfilled') merged.push(...result.value);
    else log('warn', `provider ${id} failed: ${result.reason?.message || result.reason}`);
  });

  const ranked = rankTracks(merged, {
    filename: baseCtx.filename,
    langs: baseCtx.langs,
    videoHash: baseCtx.videoHash,
    type: baseCtx.type,
    season: baseCtx.season,
    episode: baseCtx.episode,
    limit: opts.limit,
  });
  // The `samples/` fixtures exist so the addon is demoable offline; they must never appear
  // next to real results, where they would pollute both the UI and the reference corpus.
  const real = ranked.filter((track) => track.source !== 'sample');
  const final = real.length ? real : ranked;
  if (real.length !== ranked.length) log('debug', `searchAll: hid ${ranked.length - real.length} demo sample(s)`);
  log('debug', `searchAll: ${merged.length} raw -> ${final.length} ranked`);
  return final;
}

async function runProvider(id, baseCtx, { timeoutMs }) {
  const module = PROVIDERS[id];
  const ctx = {
    ...baseCtx,
    log: (level, msg, extra) => (baseCtx.log || providerLog)(level, `[${id}] ${msg}`, extra),
    httpJson,
    httpText,
  };
  const started = Date.now();
  try {
    const tracks = await withTimeout(Promise.resolve(module.search(ctx)), timeoutMs, `provider ${id}`);
    const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.url) : [];
    (baseCtx.log || providerLog)('debug', `[${id}] ${list.length} tracks in ${Date.now() - started}ms`);
    return list;
  } catch (err) {
    throw new Error(`${id}: ${err?.message || err}`);
  }
}

/**
 * Turn a lazy track reference (`osdl:<file_id>`, `file:/path`, `sample:name`) into something
 * downloadable. Providers without `resolveDownload` keep their plain URL.
 *
 * @param {import('../contracts.js').SubtitleTrack} track
 * @param {object} ctx same shape as the provider context
 * @returns {Promise<{url:string, headers?:object, filePath?:string}|null>}
 */
export async function resolveTrackUrl(track, ctx) {
  if (!track?.url) return null;
  const module = PROVIDERS[track.provider];
  const isHttp = /^https?:/i.test(track.url);

  // A provider may declare `meta.rewritesHttp` when the URLs it hands out are not directly
  // downloadable by a third party (SubSense proxies its upstreams). Without that flag an
  // http(s) URL is assumed to be the real thing and is used verbatim.
  if (isHttp) {
    if (module?.meta?.rewritesHttp && typeof module.resolveDownload === 'function') {
      try {
        const rewritten = await module.resolveDownload(track, ctx);
        if (typeof rewritten === 'string' && rewritten) return { url: rewritten, headers: track.headers };
        if (rewritten?.url) return rewritten;
      } catch (err) {
        (ctx?.log || providerLog)('warn', `rewrite failed for ${track.id}: ${err.message}`);
      }
    }
    return { url: track.url, headers: track.headers };
  }

  if (typeof module?.resolveDownload === 'function') {
    try {
      const resolved = await module.resolveDownload(track, ctx);
      if (typeof resolved === 'string') {
        if (resolved.startsWith('file:') || /^[/\\]/.test(resolved)) return { url: resolved, filePath: resolved.replace(/^file:/, '') };
        return { url: resolved, headers: track.headers };
      }
      if (resolved?.url) return resolved;
    } catch (err) {
      (ctx?.log || providerLog)('warn', `resolveDownload failed for ${track.id}: ${err.message}`);
    }
  }
  providerLog('warn', `no download resolver for ${track.provider} (${track.url.slice(0, 40)})`);
  return null;
}

export { rankTracks, dedupeTracks, scoreTrack, pickReferences } from './rank.js';
