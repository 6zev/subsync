/**
 * Proxy other Stremio subtitle addons: their results become both candidates *and* the
 * reference corpus the text aligner correlates against.
 * Owned by LEAD.
 */
import { toLang2 } from '../contracts.js';

export const meta = {
  id: 'addons',
  name: 'Other Stremio addons',
  requiresKey: false,
  enabledByDefault: true,
  docs: 'Set STREMIO_SUBTITLE_ADDONS to a comma separated list of manifest.json URLs.',
};

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const manifests = ctx.config?.STREMIO_SUBTITLE_ADDONS || [];
  if (!manifests.length) return [];
  const results = await Promise.allSettled(manifests.map((manifestUrl) => queryAddon(manifestUrl, ctx)));
  const tracks = [];
  for (const result of results) {
    if (result.status === 'fulfilled') tracks.push(...result.value);
  }
  ctx.log('debug', `addons: ${tracks.length} candidates from ${manifests.length} addon(s)`);
  return tracks;
}

async function queryAddon(manifestUrl, ctx) {
  const base = manifestUrl.replace(/manifest\.json.*$/i, '').replace(/\/?$/, '/');
  const id = buildId(ctx);
  const extra = new URLSearchParams();
  if (ctx.videoHash) extra.set('videoHash', ctx.videoHash);
  if (ctx.videoSize) extra.set('videoSize', String(ctx.videoSize));
  if (ctx.filename) extra.set('filename', ctx.filename);
  const extraPath = extra.toString() ? `/${encodeURIComponent(extra.toString())}` : '';

  const attempts = [
    `${base}subtitles/${ctx.type}/${encodeURIComponent(id)}${extraPath}.json`,
    `${base}subtitles/${ctx.type}/${encodeURIComponent(id)}.json`,
  ];

  let payload = null;
  for (const url of attempts) {
    try {
      payload = await ctx.httpJson(url, { timeoutMs: 10000 });
      if (payload?.subtitles) break;
    } catch {
      payload = null;
    }
  }
  if (!payload?.subtitles) return [];
  const source = `addons:${hostOf(manifestUrl)}`;
  return payload.subtitles
    .map((entry, index) => {
      const url = typeof entry === 'string' ? entry : entry?.url;
      if (!url || !/^https?:/i.test(url)) return null;
      const lang = toLang2(entry?.lang || entry?.language || guessFromLabel(entry?.label)) || 'und';
      if (ctx.langs?.length && lang !== 'und' && !ctx.langs.includes(lang)) return null;
      return {
        id: `${source}:${entry?.id || `${index}-${hash(url)}`}`,
        provider: 'addons',
        lang,
        langName: entry?.lang || entry?.label || lang,
        url,
        headers: entry?.headers,
        format: guessFormat(url),
        releaseName: entry?.label || entry?.title,
        filename: entry?.label,
        source: 'addon',
        extra: { manifestUrl, upstreamId: entry?.id },
      };
    })
    .filter(Boolean)
    .slice(0, 40);
}

function buildId(ctx) {
  if (ctx.type === 'series' && ctx.imdbId && ctx.season != null && ctx.episode != null) {
    return `${ctx.imdbId}:${ctx.season}:${ctx.episode}`;
  }
  return ctx.imdbId || String(ctx.tmdbId || '');
}

function guessFormat(url) {
  const m = String(url).match(/\.(srt|vtt|ass|ssa)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'srt';
}

function guessFromLabel(label) {
  const value = String(label || '');
  const paren = value.match(/\(([a-z]{2,3})\)\s*$/i);
  return paren ? paren[1] : '';
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'other'; }
}

function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
