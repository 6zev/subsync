/**
 * Signed, URL-safe tokens.
 *
 * Two payload kinds:
 *   { c: {...} }                      portable addon configuration (embed only non-defaults)
 *   { v: videoKey, i: trackId, ... }  per-video / per-track reference (subtitle links, Sync Lab)
 *
 * Every token is HMAC-SHA256 signed with TOKEN_SECRET, so a user cannot forge a track
 * reference or smuggle a config into someone else's server. Owned by LEAD.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../env.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (str) => Buffer.from(String(str), 'base64url').toString('utf8');

function secret() {
  return getConfig().TOKEN_SECRET || 'insecure-development-secret';
}

function signature(body) {
  return createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 22);
}

/**
 * @param {object} payload
 * @param {{ttlMs?:number}} [opts]
 * @returns {string}
 */
export function signToken(payload, { ttlMs } = {}) {
  const withExp = { ...payload };
  if (ttlMs && ttlMs > 0) withExp.e = Date.now() + ttlMs;
  const body = b64url(JSON.stringify(withExp));
  return `${body}.${signature(body)}`;
}

/**
 * @param {string} token
 * @returns {object|null} payload, or null when malformed / tampered / expired
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signature(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(unb64url(body)); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.e && Number(payload.e) < Date.now()) return null;
  return payload;
}

/** Compact field names keep install URLs short. */
export const CONFIG_FIELDS = Object.freeze({
  p: 'ENABLED_PROVIDERS',
  l: 'PREFERRED_LANGS',
  m: 'SYNC_MODE',
  r: 'ALLOW_RATE',
  b: 'AUTO_SYNC_BUDGET_MS',
  o: 'OPENSUBTITLES_API_KEY',
  d: 'SUBDL_API_KEY',
  s: 'SUBSOURCE_API_KEY',
  a: 'STREMIO_SUBTITLE_ADDONS',
  g: 'LLM_PROVIDER',
  k: 'LLM_API_KEY',
  n: 'LLM_MODEL',
  u: 'AUDIO_SYNC_ENABLED',
  x: 'SHOW_ONLY_PREFERRED',
});

/** Build the portable config payload (only values differing from the server defaults matter). */
export function configToTokenPayload(config) {
  const out = {};
  for (const [short, long] of Object.entries(CONFIG_FIELDS)) {
    const value = config?.[long];
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value) && !value.length) continue;
    out[short] = value;
  }
  return out;
}

/** Merge a decoded config token over a base config. @returns {object} */
export function applyTokenPayload(config, payload) {
  const out = { ...config };
  for (const [short, long] of Object.entries(CONFIG_FIELDS)) {
    if (payload?.[short] !== undefined) out[long] = payload[short];
  }
  return out;
}

/**
 * Stateless "subtitle reference" token placed in the URL Stremio fetches.
 * @param {{videoKey:string, trackId:string, cfg?:object}} input
 */
export function makeTrackToken({ videoKey, trackId, cfg }) {
  const payload = { v: videoKey, i: trackId };
  if (cfg) payload.c = configToTokenPayload(cfg);
  return signToken(payload, { ttlMs: 30 * 24 * 3600 * 1000 });
}
