/**
 * SubDL provider (https://subdl.com). Owned by LEAD.
 */
import { toLang2 } from '../contracts.js';

export const meta = {
  id: 'subdl',
  name: 'SubDL',
  requiresKey: true,
  keyEnv: 'SUBDL_API_KEY',
  enabledByDefault: true,
  docs: 'https://subdl.com/api-doc',
};

const API = 'https://api.subdl.com/api/v1/subtitles';
const DL = 'https://dl.subdl.com';

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const key = ctx.config?.SUBDL_API_KEY;
  if (!key) {
    ctx.log('debug', 'subdl: no API key configured, skipping');
    return [];
  }
  const langs = (ctx.langs || []).map((l) => toLang2(l).toUpperCase()).filter(Boolean).join(',');
  const params = new URLSearchParams({ api_key: key, subs_per_page: '30' });
  if (langs) params.set('languages', langs);
  const isEpisode = ctx.type === 'series' && ctx.season != null;
  params.set('type', isEpisode ? 'tv' : 'movie');
  if (ctx.imdbId) params.set('imdb_id', String(ctx.imdbId).replace(/\D/g, ''));
  else if (ctx.tmdbId) params.set('tmdb_id', String(ctx.tmdbId));
  else if (ctx.query) params.set('film_name', ctx.query);
  else return [];
  if (isEpisode) {
    params.set('season_number', String(ctx.season));
    if (ctx.episode != null) params.set('episode_number', String(ctx.episode));
  }

  let payload;
  try {
    payload = await ctx.httpJson(`${API}?${params}`, { timeoutMs: 12000 });
  } catch (err) {
    ctx.log('warn', `subdl query failed: ${err.message}`);
    return [];
  }

  const list = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const tracks = [];
  for (const item of list) {
    const url = item?.url ? (String(item.url).startsWith('http') ? item.url : `${DL}${item.url}`) : null;
    if (!url) continue;
    const lang = toLang2(item.language || item.lang || '');
    if (!lang) continue;
    if (ctx.langs?.length && !ctx.langs.includes(lang)) continue;
    tracks.push({
      id: `subdl:${item.subtitle_id || item.sd_id || item.url}`,
      provider: 'subdl',
      lang,
      langName: item.language,
      url,
      format: /\.(srt|vtt|ass)(\?|$)/i.test(url) ? url.match(/\.(srt|vtt|ass)/i)[1].toLowerCase() : 'srt',
      releaseName: item.name || item.release_name || item.film_name,
      filename: item.name,
      score: Number(item.rating || 0),
      downloads: Number(item.downloads || 0),
      hearingImpaired: Boolean(item.hi),
      season: item.season != null ? Number(item.season) : undefined,
      episode: item.episode != null ? Number(item.episode) : undefined,
      source: 'api',
      extra: { unpack: /\.zip(\?|$)/i.test(url) },
    });
    if (tracks.length >= 50) break;
  }
  ctx.log('debug', `subdl: ${tracks.length} candidates`);
  return tracks;
}
