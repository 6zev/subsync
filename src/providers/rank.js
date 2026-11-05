/**
 * Ranking and deduplication of provider results.
 *
 * The score answers one question: "how likely is this subtitle to be in sync with the file the
 * user is playing?" — an exact file-hash match beats a release-name match, which beats a generic
 * result. Owned by LEAD. Contract: src/contracts.js §2.
 */
import { releaseSimilarity, foldText } from '../util/text.js';
import { toLang2 } from '../contracts.js';

/**
 * @param {import('../contracts.js').SubtitleTrack} track
 * @param {{filename?:string, langs?:string[], videoHash?:string, type?:string, season?:number, episode?:number}} ctx
 * @returns {number} 0..1-ish
 */
export function scoreTrack(track, ctx = {}) {
  let score = 0.1;

  const wantedHash = ctx.videoHash ? String(ctx.videoHash).toLowerCase() : null;
  if (wantedHash && track.hash && String(track.hash).toLowerCase() === wantedHash) score += 0.45;

  const name = track.releaseName || track.filename || '';
  if (ctx.filename && name) score += 0.3 * releaseSimilarity(ctx.filename, name);
  else if (name) score += 0.05;

  const langs = (ctx.langs || []).map(toLang2);
  const lang = toLang2(track.lang);
  if (langs.length) {
    const index = langs.indexOf(lang);
    if (index === 0) score += 0.15;
    else if (index > 0) score += Math.max(0.02, 0.15 / (index + 1));
  }

  if (Number.isFinite(track.score) && track.score > 0) score += Math.min(0.06, (Math.log10(1 + track.score) / 10) * 0.06);
  if (Number.isFinite(track.downloads) && track.downloads > 0) score += Math.min(0.06, (Math.log10(1 + track.downloads) / 6) * 0.06);

  if (track.hearingImpaired) score -= 0.03;
  if (track.machineTranslated) score -= 0.05;
  if (track.format && !['srt', 'vtt', 'ass', 'ssa'].includes(track.format)) score -= 0.02;

  if (ctx.type === 'series') {
    if (track.season != null && ctx.season != null && Number(track.season) !== Number(ctx.season)) score -= 0.25;
    if (track.episode != null && ctx.episode != null && Number(track.episode) !== Number(ctx.episode)) score -= 0.25;
  }

  return Math.max(0, Math.min(1.5, score));
}

/** Stable key for dedupe: language + release identity, falling back to the URL. */
export function dedupeKey(track) {
  const release = foldText(track.releaseName || track.filename || '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 48);
  if (release) return `${toLang2(track.lang)}|${release}`;
  return `${toLang2(track.lang)}|${String(track.url).slice(0, 120)}`;
}

/**
 * @param {import('../contracts.js').SubtitleTrack[]} tracks
 * @returns {import('../contracts.js').SubtitleTrack[]}
 */
export function dedupeTracks(tracks) {
  const byKey = new Map();
  for (const track of tracks || []) {
    if (!track?.url) continue;
    const key = dedupeKey(track);
    const existing = byKey.get(key);
    if (!existing || (track.rankScore ?? scoreTrack(track)) > (existing.rankScore ?? scoreTrack(existing))) {
      byKey.set(key, track);
    }
  }
  return [...byKey.values()];
}

/**
 * @param {import('../contracts.js').SubtitleTrack[]} tracks
 * @param {{filename?:string, langs?:string[], videoHash?:string, type?:string, season?:number, episode?:number, limit?:number}} ctx
 * @returns {import('../contracts.js').SubtitleTrack[]}
 */
export function rankTracks(tracks, ctx = {}) {
  const deduped = dedupeTracks(tracks);
  const scored = deduped.map((track) => ({ ...track, rankScore: Number(scoreTrack(track, ctx).toFixed(4)) }));
  scored.sort((a, b) => b.rankScore - a.rankScore || String(a.lang).localeCompare(String(b.lang)));
  return ctx.limit ? scored.slice(0, ctx.limit) : scored;
}

/** Pick the best reference candidates for the aligner: one per language, best score first. */
export function pickReferences(tracks, { excludeId, langs, limit = 4 } = {}) {
  const wanted = (langs || []).map(toLang2);
  const out = [];
  const usedLangs = new Set();
  for (const track of tracks || []) {
    if (track.id === excludeId || !track.url) continue;
    const lang = toLang2(track.lang);
    if (!wantWanted(wanted, lang)) continue;
    if (usedLangs.has(lang)) continue;
    usedLangs.add(lang);
    out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}

function wantWanted(wanted, lang) {
  if (!wanted.length) return true;
  if (wanted.includes(lang)) return true;
  return true; // other languages are still useful as cross-language references
}
