/**
 * FROZEN INTERFACES — v1
 *
 * This file is the single source of truth for every cross-module boundary in nuvio-sync.
 * Owners may ADD optional fields, never rename or repurpose an existing one.
 * If you must change a boundary: bump CONTRACT_VERSION, update docs/contracts.md,
 * and tell the Lead. Everyone imports from here, nobody redefines a shape locally.
 */

export const CONTRACT_VERSION = 1;

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. Subtitles (owned by: src/sync/subtitles.js — sync-engine)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @typedef {Object} Cue
 * @property {number} index     0-based position in the document
 * @property {number} start     start time in MILLISECONDS (integer)
 * @property {number} end       end time in MILLISECONDS (integer)
 * @property {string} text      plain text, one cue may hold several "\n" lines
 * @property {string} [raw]     original text before HTML/override-tag stripping
 *
 * @typedef {Object} SubtitleDoc
 * @property {'srt'|'vtt'|'ass'|'ssa'} format
 * @property {Cue[]} cues
 * @property {Object} meta      format-specific passthrough (ass styles, vtt header…)
 *
 * Required exports of src/sync/subtitles.js:
 *   parseSubtitles(text: string, opts?: {url?: string, format?: string}) -> SubtitleDoc
 *   serializeSubtitles(doc: SubtitleDoc, format?: string) -> string
 *   detectFormat(text: string, url?: string) -> 'srt'|'vtt'|'ass'|'ssa'
 *   cuesToSpeechMask(cues: Cue[], opts?) -> {hopMs:number, mask:Uint8Array, durationMs:number}
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. Providers (owned by: src/providers/** — providers)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @typedef {Object} SubtitleTrack
 * @property {string}  id            globally unique + stable, "<provider>:<native id>"
 * @property {string}  provider      registry id, e.g. "opensubtitles"
 * @property {string}  lang          BCP-47-ish, e.g. "vi", "en", "pt-BR"
 * @property {string}  [langName]    human label, e.g. "Vietnamese"
 * @property {string}  url           direct download URL for the subtitle file
 * @property {Object}  [headers]     extra HTTP headers required to download it
 * @property {'srt'|'vtt'|'ass'|'unknown'} [format]
 * @property {string}  [releaseName] release the sub was made for
 * @property {string}  [filename]    uploaded file name
 * @property {number}  [score]       provider-native score (any scale, used for ranking only)
 * @property {number}  [downloads]
 * @property {string}  [hash]        OpenSubtitles file hash (8+8 hex) when known
 * @property {boolean} [machineTranslated]
 * @property {boolean} [hearingImpaired]
 * @property {number}  [season]
 * @property {number}  [episode]
 * @property {'api'|'addon'|'local'|'sample'} source
 * @property {Object}  [extra]       provider passthrough
 *
 * Required export of every src/providers/<name>.js:
 *   export const meta = { id, name, requiresKey, keyEnv?, enabledByDefault, docs? }
 *   export async function search(ctx) -> SubtitleTrack[]   // MUST NOT throw
 *
 * @typedef {Object} ProviderSearchContext
 * @property {'movie'|'series'} type
 * @property {string} [imdbId]     "tt1234567"
 * @property {number} [tmdbId]
 * @property {number} [season]
 * @property {number} [episode]
 * @property {string} [query]      title
 * @property {number} [year]
 * @property {string[]} langs      requested ISO-639-1 codes (lowercase)
 * @property {string} [filename]   release filename reported by Stremio
 * @property {string} [videoHash]  OpenSubtitles hash reported by Stremio
 * @property {number} [videoSize]
 * @property {Record<string,string>} config   resolved secrets for this request
 * @property {(level:string, msg:string, extra?:Object)=>void} log
 * @property {(url:string, opts?:Object)=>Promise<any>} httpJson   helper (src/util/http.js)
 * @property {(url:string, opts?:Object)=>Promise<{status:number,headers:Object,body:string}>} httpText
 *
 * Required exports of src/providers/index.js:
 *   listProviders() -> Array<{id,name,requiresKey,enabled}>
 *   searchAll(ctx, opts?: {providers?:string[], timeoutMs?:number}) -> Promise<SubtitleTrack[]>
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. Sync engine (owned by: src/sync/** — sync-engine)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @typedef {Object} SyncOptions
 * @property {number} [minCues=8]
 * @property {number} [maxOffsetMs=180000]        // Nuvio: SUBTITLE_DELAY_MAX_MS
 * @property {number} [minOffsetMs=-180000]
 * @property {number} [stepMs=100]                // Nuvio: SUBTITLE_DELAY_STEP_MS
 * @property {number} [reactionCompensationMs=300]// Nuvio: AUTO_SYNC_REACTION_COMPENSATION_MS
 * @property {boolean} [allowRate=true]
 * @property {number} [rateTolerance=0.02]
 * @property {string} [sourceLabel]               // for logging
 *
 * @typedef {Object} SyncResult
 * @property {boolean} ok
 * @property {'manual'|'text'|'llm'|'audio'|'none'} method
 * @property {number} offsetMs    applied as: newStart = round((oldStart * rate) + offsetMs)
 * @property {number} rate        1 = no drift correction
 * @property {number} confidence  0..1
 * @property {number} [samples]   number of anchor matches used
 * @property {Object} [detail]
 * @property {string} [error]
 *
 * Required exports of src/sync/index.js:
 *   export async function syncSubtitle(req: SyncRequest): Promise<SyncResult>
 *   export function normalizeOffset(offsetMs:number, opts?:SyncOptions): number
 *   export { shiftDoc, shiftCues }            // from shift.js
 *   export { parseSubtitles, serializeSubtitles, detectFormat, cuesToSpeechMask } // re-export
 *
 * @typedef {Object} SyncRequest
 * @property {SubtitleDoc} doc
 * @property {{filename?:string, videoHash?:string, videoSize?:number, lang?:string,
 *             mediaPath?:string|null, durationMs?:number}} target
 * @property {SubtitleDoc[]} [references]
 * @property {{provider:'groq'|'gemini', apiKey:string, model?:string, baseUrl?:string}|null} [llm]
 * @property {{enabled:boolean, mediaPath?:string, ffmpegPath?:string, alassPath?:string,
 *             ffsubsyncPath?:string, maxAnalyzeMs?:number}} [audio]
 * @property {SyncOptions} [options]
 * @property {(level:string,msg:string,extra?:Object)=>void} [log]
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. Offset store (owned by: src/store/** — LEAD)
 * ────────────────────────────────────────────────────────────────────────────
 *   getOffset(videoKey, trackId) -> {offsetMs, rate, method, confidence, source, updatedAt}|null
 *   putOffset(videoKey, trackId, {offsetMs, rate, method, confidence, source, meta})
 *   listOffsets(videoKey) -> Array<{trackId, offsetMs, rate, method, confidence, updatedAt}>
 *   deleteOffset(videoKey, trackId)
 *   getCachedSub(cacheKey) -> {body, format, contentType, createdAt}|null
 *   putCachedSub(cacheKey, {body, format, contentType, ttlMs})
 *   videoKeyOf({type, id, videoHash, filename, videoSize}) -> string
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 5. Media resolver (owned by: src/media/** — LEAD)
 * ────────────────────────────────────────────────────────────────────────────
 *   resolveMedia({videoKey, videoHash, videoSize, filename, infohash}) ->
 *     Promise<{kind:'local'|'url'|'none', path:string|null, headers?:Object, reason?:string}>
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 6. HTTP surface (owned by: src/addon/** + src/synclab/** — LEAD, UI in src/web — synclab)
 * ────────────────────────────────────────────────────────────────────────────
 *   GET  /manifest.json
 *   GET  /configure                       -> config page HTML (src/web/config.js)
 *   GET  /api/config                      -> {providers, settings}
 *   POST /api/config                      -> save config
 *   GET  /subtitles/:type/:id/:extra?.json
 *   GET  /subtitles/:type/:id.json
 *   GET  /s/:sid/:name(:ext)              -> synced subtitle body (subtitle fetch hook)
 *   GET  /synclab?t=TOKEN                 -> sync lab page HTML (src/web/synclab.js)
 *   GET  /api/synclab/session?t=TOKEN
 *   GET  /api/synclab/cues?t=TOKEN&fromMs=&toMs=&trackId=
 *   POST /api/synclab/apply  {t,trackId,mode:'tap'|'offset'|'rate'|'reset',videoPositionMs?,cueStartMs?,offsetMs?,rate?}
 *   POST /api/synclab/auto   {t,trackId,methods?:['text','llm','audio']}
 *   GET  /api/synclab/preview?t=TOKEN&trackId=
 *   GET  /healthz
 *   GET  /stats
 * ──────────────────────────────────────────────────────────────────────────── */

/* Nuvio parity constants — keep in sync with docs/nuvio-parity.md */
export const NUVIO = Object.freeze({
  REACTION_COMPENSATION_MS: 300,
  DELAY_MIN_MS: -180000,
  DELAY_MAX_MS: 180000,
  DELAY_STEP_MS: 100,
  SOURCE_LINE_COUNT: 5,
  MAX_ATTEMPTS: 3,
  GROQ_MODEL_DEFAULT: 'llama-3.1-8b-instant',
  GEMINI_MODEL_DEFAULT: 'gemini-3.5-flash',
});

/* Stremio language mapping helpers (3-letter ISO 639-2/B codes Stremio expects). */
export const LANG_3TO2 = Object.freeze({
  eng: 'en', vie: 'vi', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', por: 'pt',
  ita: 'it', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', tha: 'th', ind: 'id',
  ara: 'ar', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', nor: 'no',
  fin: 'fi', cze: 'cs', ces: 'cs', hun: 'hu', gre: 'el', ell: 'el', heb: 'he', hin: 'hi',
  ukr: 'uk', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slo: 'sk', slk: 'sk',
  slv: 'sl', est: 'et', lav: 'lv', lit: 'lt', cat: 'ca', glg: 'gl', eus: 'eu', fil: 'tl',
});

export const LANG_2TO3 = Object.freeze(
  Object.entries(LANG_3TO2).reduce((acc, [three, two]) => {
    if (!acc[two]) acc[two] = three;
    return acc;
  }, /** @type {Record<string,string>} */ ({})),
);

export const LANG_NAMES = Object.freeze({
  en: 'English', vi: 'Vietnamese', fr: 'French', de: 'German', es: 'Spanish',
  pt: 'Portuguese', it: 'Italian', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', th: 'Thai', id: 'Indonesian', ar: 'Arabic', tr: 'Turkish',
  pl: 'Polish', nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', cs: 'Czech', hu: 'Hungarian', el: 'Greek', he: 'Hebrew',
  hi: 'Hindi', uk: 'Ukrainian', ro: 'Romanian', bg: 'Bulgarian', fa: 'Persian',
});

/** Normalise anything (2 or 3 letters, any case, "pt-BR") to a lowercase 2-letter code. */
export function toLang2(value) {
  if (!value) return '';
  const raw = String(value).trim().toLowerCase().replace('_', '-');
  const base = raw.split('-')[0];
  if (base.length === 3) return LANG_3TO2[base] || base.slice(0, 2);
  return base;
}

/** Normalise to the ISO 639-2/B code Stremio expects in `Subtitle.lang`. */
export function toLang3(value) {
  const two = toLang2(value);
  return LANG_2TO3[two] || two;
}
