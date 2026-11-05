/**
 * Local sources:
 *  1. sidecar subtitles stored next to the media file (`Movie.mkv` + `Movie.en.srt`), which the
 *     pipeline reads straight from disk;
 *  2. the `samples/` fixture folder, so the addon is fully demoable without any API key or
 *     network access.
 * Owned by LEAD.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { PROJECT_ROOT } from '../env.js';
import { releaseSimilarity } from '../util/text.js';
import { toLang2 as lang2 } from '../contracts.js';

export const meta = {
  id: 'local',
  name: 'Local files',
  requiresKey: false,
  enabledByDefault: true,
  docs: 'Set LOCAL_MEDIA_ROOTS to the folders that hold your video files.',
};

const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

/** @param {import('../contracts.js').ProviderSearchContext} ctx */
export async function search(ctx) {
  const roots = ctx.config?.LOCAL_MEDIA_ROOTS || [];
  const results = [];
  if (roots.length && ctx.filename) {
    try {
      results.push(...await searchSidecars(ctx, roots));
    } catch (err) {
      ctx.log('warn', `local sidecar scan failed: ${err.message}`);
    }
  }
  try {
    results.push(...await searchSamples(ctx));
  } catch (err) {
    ctx.log('debug', `sample scan failed: ${err.message}`);
  }
  return results;
}

async function searchSidecars(ctx, roots) {
  const tracks = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || SUB_EXT.has(extname(entry.name).toLowerCase()) === false) continue;
      const score = releaseSimilarity(ctx.filename, entry.name);
      if (score < 0.35) continue;
      const lang = guessLang(entry.name) || 'und';
      if (ctx.langs?.length && lang !== 'und' && !ctx.langs.includes(lang)) continue;
      const full = join(root, entry.name);
      tracks.push({
        id: `local:${full}`,
        provider: 'local',
        lang,
        langName: lang,
        url: `file:${full}`,
        format: extname(entry.name).slice(1).toLowerCase(),
        releaseName: basename(entry.name, extname(entry.name)),
        filename: entry.name,
        source: 'local',
        score,
        extra: { path: full },
      });
    }
  }
  ctx.log('debug', `local: ${tracks.length} sidecar candidates`);
  return tracks;
}

async function searchSamples(ctx) {
  const dir = join(PROJECT_ROOT, 'samples');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const tracks = [];
  for (const name of entries) {
    if (!SUB_EXT.has(extname(name).toLowerCase())) continue;
    const lang = guessLang(name) || 'und';
    if (ctx.langs?.length && lang !== 'und' && !ctx.langs.includes(lang)) continue;
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    tracks.push({
      id: `sample:${name}`,
      provider: 'local',
      lang,
      langName: lang,
      url: `sample:${name}`,
      format: extname(name).slice(1).toLowerCase(),
      releaseName: name,
      filename: name,
      source: 'sample',
      score: 0.4,
      extra: { path: full, bytes: info?.size },
    });
  }
  return tracks;
}

/** `Movie.2024.1080p.WEB-DL.en.srt` -> `en`; also understands `.vie` / `.pt-BR`. */
export function guessLang(fileName) {
  const parts = basename(String(fileName || ''), extname(String(fileName || ''))).split(/[._\s-]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i -= 1) {
    const candidate = parts[i];
    if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/i.test(candidate)) return lang2(candidate);
    if (/^[a-z]{3}$/i.test(candidate)) {
      const mapped = lang2(candidate);
      if (mapped && mapped !== candidate.slice(0, 2)) return mapped;
      if (['eng', 'vie', 'fre', 'ger', 'spa', 'por', 'ita', 'rus', 'jpn', 'kor', 'chi', 'tha'].includes(candidate.toLowerCase())) return lang2(candidate);
    }
  }
  return null;
}

/** Resolve a `file:` / `sample:` URL back to a path. */
export async function resolveDownload(track) {
  const raw = String(track?.url || '');
  if (raw.startsWith('file:')) return raw.slice(5);
  if (raw.startsWith('sample:')) return join(PROJECT_ROOT, 'samples', raw.slice(7));
  return null;
}

export { dirname };
