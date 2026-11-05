/**
 * SubSense provider — https://github.com/NepiRaw/Stremio-SubSense
 *
 * SubSense is itself a Stremio subtitle addon that aggregates OpenSubtitles, SubDL, Podnapisi,
 * SubSource, Wyzie, Subf2m, Kitsunekko, Jimaku, AnimeTosho, Gestdown, YIFY and TVsubtitles.
 * Its config lives in the URL path (`/:config/manifest.json`, `/:config/subtitles/:type/:id.json`),
 * and `parseConfigParam()` accepts plain URL-encoded JSON, so we can build the config ourselves
 * and call it like any other addon. That makes it the cheapest way to get a wide, key-free
 * reference corpus for the text aligner.
 *
 * The `wyzie` proxy on the free tier injects a promotional cue at 00:00:00, so results served
 * from sub.wyzie.io are ranked below the direct mirrors of the same subtitle.
 *
 * Owned by LEAD. Contract: src/contracts.js §2.
 */
import { toLang2 } from '../contracts.js';

export const meta = {
  id: 'subsense',
  name: 'SubSense',
  requiresKey: false,
  keyEnv: 'SUBSENSE_URL',
  enabledByDefault: true,
  // SubSense hands out upstream links that a third party usually cannot fetch (Wyzie answers
  // 401, some entries point at the player's own 127.0.0.1 server). `resolveDownload` rewrites
  // them to SubSense's own proxy route, so the http(s) URL must not be taken at face value.
  rewritesHttp: true,
  docs: 'https://github.com/NepiRaw/Stremio-SubSense',
};

const DEFAULT_BASE = 'https://subsense.nepiraw.com';

/** Known-wrong hosts / watermarked mirrors. */
const PENALISED_HOSTS = ['sub.wyzie.io'];

/**
 * Build the SubSense config path segment: URL-encoded JSON, which its `parseConfigParam()`
 * accepts first. Extra keys the user wants to pass through can be supplied verbatim.
 * @param {{languages:string[], maxSubtitles?:number, userId?:string, raw?:string}} input
 * @returns {string} path segment (no leading slash)
 */
export function buildConfigParam({ languages = [], maxSubtitles = 10, userId = 'nuvio-sync', raw = '' } = {}) {
  if (raw) return raw;
  const config = { languages, maxSubtitles, userId };
  return encodeURIComponent(JSON.stringify(config));
}

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const base = String(ctx.config?.SUBSENSE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  if (!base) return [];

  const isEpisode = ctx.type === 'series' && ctx.season != null && ctx.episode != null;
  let id = ctx.imdbId || '';
  if (!id) {
    ctx.log('debug', 'subsense: needs an IMDB id');
    return [];
  }
  if (isEpisode) id = `${id}:${ctx.season}:${ctx.episode}`;

  const config = buildConfigParam({
    languages: (ctx.langs || []).map(toLang2).filter(Boolean),
    maxSubtitles: Number(ctx.config?.SUBSENSE_MAX_SUBTITLES) || 10,
    userId: ctx.config?.SUBSENSE_USER_ID || 'nuvio-sync',
    raw: ctx.config?.SUBSENSE_CONFIG_PARAM || '',
  });

  const extra = new URLSearchParams();
  if (ctx.videoHash) extra.set('videoHash', ctx.videoHash);
  if (ctx.videoSize) extra.set('videoSize', String(ctx.videoSize));
  if (ctx.filename) extra.set('filename', ctx.filename);
  const extraPath = extra.toString() ? `/${encodeURIComponent(extra.toString())}` : '';

  const url = `${base}/${config}/subtitles/${ctx.type}/${encodeURIComponent(id)}${extraPath}.json`;
  let payload;
  try {
    payload = await ctx.httpJson(url, { timeoutMs: 15000 });
  } catch (err) {
    ctx.log('warn', `subsense request failed: ${err.message}`);
    return [];
  }
  const list = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const tracks = list
    .map((entry) => mapEntry(entry, ctx))
    .filter(Boolean);
  ctx.log('debug', `subsense: ${tracks.length} candidates`);
  return tracks;
}

/** @param {any} entry @param {import('../contracts.js').ProviderSearchContext} ctx */
export function mapEntry(entry, ctx) {
  const url = typeof entry === 'string' ? entry : entry?.url;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const lang = toLang2(entry?.lang || '');
  if (!lang) return null;
  if (ctx.langs?.length && !ctx.langs.includes(lang)) return null;

  const id = String(entry?.id || url);
  const format = formatFromId(id) || formatFromUrl(url);
  const fileName = entry?.fileName || '';
  const releaseName = entry?.releaseName || (entry?.releases || [])[0] || fileName;

  return {
    id: `subsense:${id}`,
    provider: 'subsense',
    lang,
    langName: entry?.lang,
    url,
    format,
    releaseName: releaseName || undefined,
    filename: fileName || undefined,
    // SubSense hands back raw upstream URLs; prefSize its own label as a hint only.
    score: PENALISED_HOSTS.some((host) => url.includes(host)) ? 0.35 : 1,
    downloads: undefined,
    source: 'api',
    extra: {
      upstream: entry?.source,
      label: entry?.label,
      watermarked: PENALISED_HOSTS.some((host) => url.includes(host)),
      base: String(ctx.config?.SUBSENSE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    },
  };
}

function formatFromId(id) {
  const m = String(id).match(/subsense-(srt|vtt|ssa|ass)-/i);
  return m ? m[1].toLowerCase() : null;
}

function formatFromUrl(url) {
  const m = String(url).match(/\.(srt|vtt|ass|ssa)(\?|$)/i);
  if (m) return m[1].toLowerCase();
  const q = String(url).match(/[?&]format=(srt|vtt|ass|ssa)/i);
  return q ? q[1].toLowerCase() : 'srt';
}

/**
 * Turn a SubSense result into something a third party can actually download.
 *
 * Evidence from live probing (2026-11): the raw upstream links SubSense hands out are frequently
 * unusable from outside its own process — `sub.wyzie.io` answers 401 ("Download link invalid or
 * expired"), and some entries point at the *client's* local Stremio server
 * (`http://127.0.0.1:11470/subtitles.srt?from=<real url>`). SubSense's own proxy route,
 * `GET /api/subtitle/{format}/{rawUrl}`, serves all of them correctly — and it expects the inner
 * URL **unencoded** (percent-encoding returns "invalid URL").
 *
 * @param {import('../contracts.js').SubtitleTrack} track
 * @param {object} ctx
 * @returns {Promise<string|null>}
 */
export async function resolveDownload(track, ctx) {
  const base = String(ctx?.config?.SUBSENSE_URL || track?.extra?.base || DEFAULT_BASE).replace(/\/+$/, '');
  let target = String(track?.url || '');
  if (!target) return null;

  // Entries that point back at the player's own machine: the real URL rides in `?from=`.
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(target)) {
    const inner = target.match(/[?&]from=([^&]+)/i);
    if (!inner) return null;
    try {
      target = decodeURIComponent(inner[1]);
    } catch {
      return null;
    }
  }

  if (target.startsWith(base)) return target;
  // `format=srt` makes SubSense convert ASS/SSA/VTT for us (their subtitle-converter), which is
  // also what lets the subtitle survive Stremio's plain-text renderers.
  return `${base}/api/subtitle/srt/${target}`;
}

export const __internal = { formatFromId, formatFromUrl, PENALISED_HOSTS };
