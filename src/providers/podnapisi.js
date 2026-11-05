/**
 * Podnapisi provider — legacy XML search endpoint, no API key required.
 * Owned by LEAD.
 */
import { toLang2, toLang3 } from '../contracts.js';

export const meta = {
  id: 'podnapisi',
  name: 'Podnapisi',
  requiresKey: false,
  enabledByDefault: true,
  docs: 'https://www.podnapisi.net',
};

const BASE = 'https://www.podnapisi.net';
const SEARCH = `${BASE}/subtitles/search/old`;

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const params = new URLSearchParams({ sXML: '1' });
  if (ctx.type === 'series') {
    params.set('sK', String(ctx.query || ''));
    params.set('sTS', String(ctx.season ?? ''));
    if (ctx.episode != null) params.set('sTE', String(ctx.episode));
  } else if (ctx.imdbId) {
    params.set('sK', String(ctx.imdbId).replace(/\D/g, ''));
  } else if (ctx.query) {
    params.set('sK', ctx.query);
  } else {
    return [];
  }
  const langs = (ctx.langs || []).map((l) => toLang3(l)).filter(Boolean);
  if (langs.length) params.set('sJ', langs.join(','));

  let response;
  try {
    response = await ctx.httpText(`${SEARCH}?${params}`, { timeoutMs: 12000 });
  } catch (err) {
    ctx.log('warn', `podnapisi query failed: ${err.message}`);
    return [];
  }
  if (!response.ok) {
    ctx.log('warn', `podnapisi returned HTTP ${response.status}`);
    return [];
  }
  return parsePodnapisiXml(response.body, ctx);
}

/**
 * Extract <subtitle> blocks with a deliberate, small regex parser — the payload is a flat,
 * well-formed legacy XML document and we refuse to pull in a dependency for it.
 * @param {string} xml
 * @param {import('../contracts.js').ProviderSearchContext} ctx
 */
export function parsePodnapisiXml(xml, ctx) {
  const tracks = [];
  const blocks = String(xml ?? '').match(/<subtitle\b[\s\S]*?<\/subtitle>/gi) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeXml(m[1].trim()) : null;
    };
    const pid = pick('pid') || pick('id');
    if (!pid) continue;
    const lang = toLang2(pick('language') || '');
    if (!lang) continue;
    if (ctx.langs?.length && !ctx.langs.includes(lang)) continue;
    const title = pick('title') || pick('movie') || '';
    const release = pick('release') || '';
    const url = pick('url');
    const downloadUrl = url && /^https?:/i.test(url)
      ? url
      : `${BASE}/subtitles/${encodeURIComponent(pid)}/download`;
    tracks.push({
      id: `podnapisi:${pid}`,
      provider: 'podnapisi',
      lang,
      langName: pick('language'),
      url: downloadUrl,
      format: 'srt',
      releaseName: release || title,
      filename: release || `${title}.srt`,
      score: Number(pick('rating') || 0) || undefined,
      downloads: Number(pick('downloads') || 0) || undefined,
      hearingImpaired: /yes|true|1/i.test(pick('hearingImpaired') || ''),
      source: 'api',
      extra: { unpack: true },
    });
    if (tracks.length >= 40) break;
  }
  ctx.log('debug', `podnapisi: ${tracks.length} candidates`);
  return tracks;
}

function decodeXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
