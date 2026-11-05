/**
 * Shared text utilities: normalisation, tokenisation, fuzzy similarity, release-name parsing.
 * Read-only for teammates. Owned by LEAD. Used by providers/rank.js and sync/textAlign.js.
 */

/** Strip accents + lowercase + collapse whitespace. */
export function foldText(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0110\u0111]/g, 'd')
    .toLowerCase();
}

/** Remove markup / ASS override tags / music symbols from a subtitle line. */
export function stripSubtitleMarkup(input) {
  return String(input ?? '')
    .replace(/\{\\[^}]*\}/g, '')            // ASS override blocks
    .replace(/<\/?[^>]+>/g, '')             // HTML-ish tags
    .replace(/\[[^\]]{0,40}\]/g, ' ')       // [music], [door slams]
    .replace(/[♪♫♬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the line carries no readable dialogue (music note / pure punctuation). */
export function isNonDialogueLine(input) {
  const stripped = stripSubtitleMarkup(input);
  if (!stripped) return true;
  if (!/[\p{L}\p{N}]/u.test(stripped)) return true;
  return false;
}

/** Tokenise into folded word tokens. */
export function tokenize(input) {
  return foldText(stripSubtitleMarkup(input))
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Dice coefficient over bigrams — cheap and language-agnostic. */
export function bigramDice(a, b) {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

function bigrams(text) {
  const s = foldText(text).replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** Token Jaccard for short lines. */
export function tokenJaccard(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** Combined line-similarity score in [0,1]. */
export function lineSimilarity(a, b) {
  const dice = bigramDice(a, b);
  const jac = tokenJaccard(a, b);
  return Math.max(dice, jac * 0.95 + dice * 0.05);
}

/** Levenshtein distance with an early-exit ceiling. */
export function levenshtein(a, b, ceiling = Infinity) {
  const s = a.length <= b.length ? a : b;
  const t = a.length <= b.length ? b : a;
  if (t.length - s.length > ceiling) return ceiling + 1;
  let prev = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let i = 1; i <= t.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= s.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (t[i - 1] === s[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > ceiling) return ceiling + 1;
    prev = cur;
  }
  return prev[s.length];
}

export const RELEASE_TOKENS = Object.freeze([
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hd', 'sd', '8k',
  'web-dl', 'webdl', 'webrip', 'web', 'bluray', 'blu-ray', 'brrip', 'bdrip', 'bdremux',
  'remux', 'hdtv', 'dvdrip', 'dvd', 'hdcam', 'cam', 'ts', 'tc', 'hdrip', 'amzn', 'nf',
  'dsnp', 'atvp', 'hmax', 'hulu', 'itunes', 'ma', 'hdr', 'hdr10', 'hdr10plus', 'dv',
  'dolbyvision', 'sdr', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx',
  'aac', 'ac3', 'eac3', 'ddp', 'dd', 'dts', 'dtshd', 'truehd', 'atmos', 'flac', 'mp3',
  'proper', 'repack', 'extended', 'unrated', 'uncut', 'remastered', 'directors', 'cut',
  'imax', 'hybrid', 'multi', 'dual', 'subs', 'dubbed', 'vosf', 'vff', 'vfq',
]);

/** Extract the release-ish tokens from a filename/torrent name. */
export function releaseTokens(name) {
  const folded = foldText(String(name ?? '').replace(/[._]+/g, ' '));
  return folded
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t) && t.length > 1);
}

/**
 * Release-name compatibility score in [0,1] between a media filename and a subtitle filename.
 * Weighted: resolution > source > group > codec.
 */
export function releaseSimilarity(mediaName, subName) {
  if (!mediaName || !subName) return 0;
  const a = new Set(releaseTokens(mediaName));
  const b = new Set(releaseTokens(subName));
  if (!a.size || !b.size) return 0;

  const grade = (list, weight) => {
    const mine = list.filter((t) => a.has(t));
    if (!mine.length) return 0;
    const shared = mine.filter((t) => b.has(t));
    return (shared.length / mine.length) * weight;
  };

  let score = 0;
  score += grade(['2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd'], 0.3);
  score += grade(['web-dl', 'webdl', 'webrip', 'bluray', 'blu-ray', 'brrip', 'bdrip', 'remux', 'hdtv', 'dvdrip', 'amzn', 'nf', 'dsnp', 'atvp', 'hmax', 'itunes'], 0.3);
  score += grade(['x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'aac', 'ac3', 'eac3', 'ddp', 'dts', 'truehd', 'atmos'], 0.2);

  const groupA = guessReleaseGroup(mediaName);
  const groupB = guessReleaseGroup(subName);
  if (groupA && groupB && foldText(groupA) === foldText(groupB)) score += 0.2;

  const titleA = new Set(titleTokens(mediaName));
  const titleB = new Set(titleTokens(subName));
  if (titleA.size && titleB.size) {
    let inter = 0;
    for (const t of titleA) if (titleB.has(t)) inter += 1;
    score += 0.15 * (inter / titleA.size);
  }
  return Math.min(1, score);
}

/** Title words only (drops release tokens, years, episode markers). */
export function titleTokens(name) {
  return releaseTokens(String(name ?? '').replace(/\.[a-z0-9]{2,4}$/i, ''))
    .filter((t) => !RELEASE_TOKENS.includes(t))
    .filter((t) => !/^s\d{1,2}(e\d{1,3})?$/.test(t))
    .filter((t) => !/^(19|20)\d{2}$/.test(t));
}

/** Guess the release group: "-GROUP" suffix, or a trailing ALL-CAPS token. */
export function guessReleaseGroup(name) {
  const raw = String(name ?? '');
  const dash = raw.match(/-([A-Za-z0-9][A-Za-z0-9._-]{1,24})(?:\.[a-z0-9]{2,4})?$/);
  if (dash) return dash[1];
  const caps = raw.match(/\b([A-Z][A-Z0-9]{2,15})\b(?!.*\b[A-Z][A-Z0-9]{2,15}\b)/);
  return caps ? caps[1] : null;
}

/** Parse "S01E02" / "1x02" / "Season 1 Episode 2" out of a filename. */
export function parseSeasonEpisode(name) {
  const s = String(name ?? '');
  let m = s.match(/[Ss](\d{1,2})[\s._-]?[Ee](\d{1,3})/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/[Ss]eason[\s._-]*(\d{1,2}).*?[Ee]pisode[\s._-]*(\d{1,3})/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/\bE(?:p)?[\s._-]?(\d{1,3})\b/i);
  if (m) return { season: null, episode: Number(m[1]) };
  return { season: null, episode: null };
}

/** Median (numbers, unsorted ok). */
export function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Median absolute deviation — used to score how trustworthy an offset estimate is. */
export function mad(values) {
  const m = median(values);
  if (!Number.isFinite(m)) return NaN;
  return median(values.map((v) => Math.abs(v - m)));
}

/** Parse "00:01:02,345" / "0:01:02.345" / "1:02:03.4" into ms. */
export function parseTimestamp(value) {
  const m = String(value ?? '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return (Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + ms;
}

/** ms -> "HH:MM:SS,mmm" */
export function formatTimestampSrt(ms) {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const milli = v % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

/** ms -> "HH:MM:SS.mmm" */
export function formatTimestampVtt(ms) {
  return formatTimestampSrt(ms).replace(',', '.');
}

/** ms -> ASS "H:MM:SS.cc" */
export function formatTimestampAss(ms) {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const cs = Math.floor((v % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
