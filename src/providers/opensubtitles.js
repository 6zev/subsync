/**
 * OpenSubtitles REST v3 provider.
 *
 * Search is cheap and safe; the actual download link costs the user one of their daily
 * downloads, so it is resolved lazily through `resolveDownload()` only when Stremio actually
 * fetches the subtitle.
 * Owned by LEAD. Contract: src/contracts.js §2.
 */
import { toLang2 } from '../contracts.js';

export const meta = {
  id: 'opensubtitles',
  name: 'OpenSubtitles',
  requiresKey: true,
  keyEnv: 'OPENSUBTITLES_API_KEY',
  enabledByDefault: true,
  docs: 'https://opensubtitles.stoplight.io/docs/opensubtitles-api',
};

const API = 'https://api.opensubtitles.com/api/v1';

function headers(config) {
  return {
    'Api-Key': config.OPENSUBTITLES_API_KEY,
    'User-Agent': 'nuvio-sync v0.1.0',
    accept: 'application/json',
  };
}

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const key = ctx.config?.OPENSUBTITLES_API_KEY;
  const { log } = ctx;
  if (!key) {
    log('debug', 'opensubtitles: no API key configured, skipping');
    return [];
  }

  const languages = (ctx.langs || []).map(toLang2).filter(Boolean).join(',');
  const isEpisode = ctx.type === 'series' && ctx.season != null && ctx.episode != null;
  const queries = [];
  const base = { languages, order_by: 'download_count', order_direction: 'desc' };

  if (ctx.imdbId && !isEpisode) {
    queries.push({ ...base, imdb_id: String(ctx.imdbId).replace(/\D/g, ''), type: 'movie' });
  }
  if (ctx.imdbId && isEpisode) {
    queries.push({
      ...base,
      parent_imdb_id: String(ctx.imdbId).replace(/\D/g, ''),
      type: 'episode',
      season_number: ctx.season,
      episode_number: ctx.episode,
    });
    queries.push({ ...base, query: ctx.query, type: 'episode', season_number: ctx.season, episode_number: ctx.episode });
  }
  if (ctx.videoHash && ctx.videoSize) {
    queries.push({ ...base, moviehash: ctx.videoHash, moviebytesize: String(ctx.videoSize) });
  }
  if (!queries.length && ctx.query) queries.push({ ...base, query: ctx.query, type: ctx.type === 'series' ? 'episode' : 'movie' });
  if (!queries.length) return [];

  const seen = new Set();
  const tracks = [];
  for (const params of queries) {
    let payload;
    try {
      payload = await ctx.httpJson(`${API}/subtitles?${new URLSearchParams(params)}`, { headers: headers(ctx.config), timeoutMs: 12000 });
    } catch (err) {
      log('warn', `opensubtitles query failed: ${err.message}`);
      continue;
    }
    for (const item of payload?.data || []) {
      const track = mapItem(item, ctx);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
      if (tracks.length >= 60) break;
    }
    if (tracks.length >= 60) break;
  }
  log('debug', `opensubtitles: ${tracks.length} candidates`);
  return tracks;
}

function mapItem(item, ctx) {
  const attributes = item?.attributes ?? {};
  const file = attributes.files?.[0];
  const fileId = file?.file_id;
  if (!fileId) return null;
  const rawLang = (attributes.language || '').toLowerCase();
  const lang = toLang2(rawLang) || rawLang.slice(0, 2);
  if (ctx.langs?.length && !ctx.langs.includes(lang)) return null;
  const hashMatched = Boolean(ctx.videoHash && attributes.moviehash_match);
  return {
    id: `opensubtitles:${fileId}`,
    provider: 'opensubtitles',
    lang,
    langName: attributes.language || lang,
    url: `osdl:${fileId}`,
    headers: headers(ctx.config),
    format: mapFormat(attributes.format || file?.file_name) || 'srt',
    releaseName: attributes.release || file?.file_name,
    filename: file?.file_name,
    score: Number(attributes.ratings || attributes.score || 0),
    downloads: Number(attributes.download_count || 0),
    hash: hashMatched ? ctx.videoHash : undefined,
    machineTranslated: Boolean(attributes.machine_translated),
    hearingImpaired: Boolean(attributes.hearing_impaired),
    season: attributes.feature_details?.season_number,
    episode: attributes.feature_details?.episode_number,
    source: 'api',
    extra: { fileId, hashMatched, points: attributes.subtitle_id },
  };
}

function mapFormat(value) {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('vtt')) return 'vtt';
  if (lower.includes('ass') || lower.includes('ssa')) return 'ass';
  return 'srt';
}

/**
 * Turn `osdl:<file_id>` into a real URL. Consumes one download from the user's quota.
 * @param {import('../contracts.js').SubtitleTrack} track
 * @param {import('../contracts.js').ProviderSearchContext} ctx
 * @returns {Promise<string|null>}
 */
export async function resolveDownload(track, ctx) {
  const fileId = track.extra?.fileId ?? String(track.url).replace('osdl:', '');
  if (!fileId) return null;
  const payload = await ctx.httpJson(`${API}/download`, {
    method: 'POST',
    headers: { ...headers(ctx.config), 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: Number(fileId), sub_format: 'srt' }),
    timeoutMs: 15000,
  });
  return payload?.link || payload?.data?.link || null;
}

export const __internal = { mapItem, mapFormat };
