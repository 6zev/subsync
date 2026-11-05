/**
 * Configuration: defaults <- .env file <- data/config.json (the file wins).
 * Secrets are never logged and are redacted by `publicConfig()`.
 * Owned by LEAD.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createLogger } from './util/log.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PROJECT_ROOT = ROOT;
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const configLog = createLogger('config');

/** Keys that must never be echoed back to a browser. */
export const SECRET_KEYS = Object.freeze([
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD', 'SUBDL_API_KEY', 'SUBSOURCE_API_KEY',
  'LLM_API_KEY', 'DEBRID_API_KEY', 'TOKEN_SECRET',
]);

export const DEFAULTS = Object.freeze({
  HOST: '0.0.0.0',
  PORT: 7878,
  /** Base URL the addon advertises in subtitle links. Empty = derive from the request. */
  PUBLIC_URL: '',

  // Providers
  ENABLED_PROVIDERS: ['opensubtitles', 'subsense', 'subdl', 'podnapisi', 'addons', 'local'],
  OPENSUBTITLES_API_KEY: '',
  OPENSUBTITLES_USERNAME: '',
  OPENSUBTITLES_PASSWORD: '',
  SUBDL_API_KEY: '',
  SUBSOURCE_API_KEY: '',
  STREMIO_SUBTITLE_ADDONS: [],

  // SubSense (https://github.com/NepiRaw/Stremio-SubSense) — an aggregator that needs no key of
  // our own. Point SUBSENSE_URL at your own deployment to avoid the public instance.
  SUBSENSE_URL: 'https://subsense.nepiraw.com',
  /** Escape hatch: paste an existing `/configure`-generated config segment verbatim. */
  SUBSENSE_CONFIG_PARAM: '',
  SUBSENSE_MAX_SUBTITLES: 10,
  SUBSENSE_USER_ID: 'nuvio-sync',

  // Behaviour
  PREFERRED_LANGS: ['vi', 'en'],
  SHOW_ONLY_PREFERRED: false,
  MAX_SUBTITLES: 40,

  /**
   * Sync policy.
   *  off  — never sync automatically; only offsets applied from the Sync Lab.
   *  fast — cross-subtitle text alignment, plus LLM cue matching when a key is set.
   *  full — fast + audio alignment against the real media when it can be resolved.
   */
  SYNC_MODE: 'fast',
  ALLOW_RATE: true,
  AUTO_SYNC_BUDGET_MS: 9000,
  BACKGROUND_SYNC: true,
  CACHE_TTL_MS: 7 * 24 * 3600 * 1000,
  NEGATIVE_TTL_MS: 6 * 3600 * 1000,

  // LLM stage (Nuvio parity: Groq default / Gemini)
  LLM_PROVIDER: '',
  LLM_API_KEY: '',
  LLM_MODEL: '',
  LLM_ATTEMPTS: 3,

  // Audio stage
  AUDIO_SYNC_ENABLED: false,
  FFMPEG_PATH: 'ffmpeg',
  ALASS_PATH: 'alass',
  FFSUBSYNC_PATH: 'ffsubsync',
  AUDIO_MAX_ANALYZE_MS: 60000,
  /**
   * Analyse only the densest slice of audio instead of the whole file (0 = whole file).
   * ffmpeg must pull the bytes it decodes, so 600000 turns a 4 GB remote movie into a ~200 MB
   * fetch while still finding the offset. Recommended for long or remote media.
   */
  AUDIO_ANALYZE_WINDOW_MS: 0,

  // Media resolution
  /**
   * Stream addon manifest URL(s). When you already run a debrid-configured stream addon, this is
   * all the audio stage needs — no second debrid key. Its /stream/ answer usually carries a
   * directly playable url.
   */
  MEDIA_SOURCE_ADDON: [],
  LOCAL_MEDIA_ROOTS: [],
  DEBRID_PROVIDER: '',
  DEBRID_API_KEY: '',

  // Server
  TOKEN_SECRET: '',
  LOG_LEVEL: 'info',
});

/** Effective config cache. */
let cache = null;
/** True when this process had to invent a TOKEN_SECRET because DATA_DIR was empty. */
let generatedSecret = false;

export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function coerce(key, value) {
  const def = DEFAULTS[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(def)) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value).split(/[,:]/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof def === 'boolean') {
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'no', 'off', ''].includes(String(value).toLowerCase());
  }
  if (typeof def === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }
  return value === null ? '' : String(value);
}

function fromEnv() {
  const fileEnv = existsSync(join(PROJECT_ROOT, '.env'))
    ? parseDotEnv(readFileSync(join(PROJECT_ROOT, '.env'), 'utf8'))
    : {};
  const merged = { ...fileEnv, ...process.env };
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (merged[key] !== undefined) {
      const value = coerce(key, merged[key]);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

function fromFile() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined) {
        const value = coerce(key, raw[key]);
        if (value !== undefined) out[key] = value;
      }
    }
    return out;
  } catch (err) {
    configLog.warn(`config.json unreadable, ignoring: ${err.message}`);
    return {};
  }
}

/** Ensure DATA_DIR exists and a stable token secret is present. */
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const file = fromFile();
  if (!file.TOKEN_SECRET && !process.env.TOKEN_SECRET) {
    const secret = randomBytes(32).toString('hex');
    saveConfig({ TOKEN_SECRET: secret });
    generatedSecret = true;
    configLog.info(`generated a new TOKEN_SECRET in ${CONFIG_PATH}`);
  }
}

export function getConfig() {
  if (!cache) {
    ensureDataDir();
    cache = { ...DEFAULTS, ...fromEnv(), ...fromFile() };
    if (!cache.TOKEN_SECRET) cache.TOKEN_SECRET = randomBytes(32).toString('hex');
    mkdirSync(DATA_DIR, { recursive: true });
  }
  return cache;
}

/**
 * True when no TOKEN_SECRET was supplied (env or file) and one was generated for this process —
 * every subtitle link handed out before the restart is now invalid, which is exactly what
 * happens when the data volume is not persisted.
 */
export function secretIsEphemeral() {
  getConfig();
  return generatedSecret;
}

export function reloadConfig() {
  cache = null;
  return getConfig();
}

/** Persist a partial config (only known keys) and return the new effective config. */
export function saveConfig(patch) {
  mkdirSync(DATA_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH)
    ? (() => { try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })()
    : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULTS)) continue;
    const coerced = coerce(key, value);
    if (coerced === undefined) continue;
    next[key] = coerced;
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (cache) cache = { ...DEFAULTS, ...fromEnv(), ...fromFile(), TOKEN_SECRET: cache.TOKEN_SECRET || process.env.TOKEN_SECRET || next.TOKEN_SECRET };
  return getConfig();
}

const mask = (value) => {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
};

/** Config safe to render in the browser. */
export function publicConfig(config = getConfig()) {
  const out = { ...config };
  for (const key of SECRET_KEYS) {
    if (!out[key]) continue;
    out[`${key}_SET`] = true;
    out[`${key}_MASK`] = mask(out[key]);
    delete out[key];
  }
  return out;
}

export { CONFIG_PATH };
