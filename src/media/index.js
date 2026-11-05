/**
 * Media resolver: finds a playable local path or URL for the video Stremio is playing, so the
 * audio stage has real audio to align against. Everything degrades to `{kind:'none'}`.
 * Contract: src/contracts.js §5. Owned by LEAD.
 */
import { stat, access } from 'node:fs/promises';
import { basename } from 'node:path';
import { getConfig } from '../env.js';
import { kvGet, kvSet } from '../store/index.js';
import { getMediaIndex, openSubtitlesHash, isVideoFile } from './hash.js';
import { resolveDebrid, parseTorrentRef } from './debrid.js';
import { releaseSimilarity } from '../util/text.js';
import { createLogger } from '../util/log.js';

const mediaLog = createLogger('media');

const KV_PATH = (videoKey) => `media:path:${videoKey}`;
const KV_URL = (videoKey) => `media:url:${videoKey}`;
const KV_MAGNET = (videoKey) => `media:magnet:${videoKey}`;
const KV_HASH = (path, size) => `filehash:${size}:${path}`;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Attach a media source to a video key (used by the Sync Lab).
 * @param {string} videoKey
 * @param {{path?:string, url?:string, magnet?:string}} input
 * @returns {Promise<{ok:boolean, kind:string, detail?:string}>}
 */
export async function attachMedia(videoKey, input = {}) {
  if (!videoKey) return { ok: false, kind: 'none', detail: 'missing videoKey' };
  if (input.path) {
    if (!(await exists(input.path))) return { ok: false, kind: 'local', detail: `file not found: ${input.path}` };
    if (!isVideoFile(input.path)) return { ok: false, kind: 'local', detail: 'not a recognised video file' };
    kvSet(KV_PATH(videoKey), input.path);
    return { ok: true, kind: 'local', detail: input.path };
  }
  if (input.url) {
    kvSet(KV_URL(videoKey), { url: input.url, expiresAt: Date.now() + 6 * 3600 * 1000, filename: basename(new URL(input.url).pathname || 'stream') });
    return { ok: true, kind: 'url', detail: input.url };
  }
  if (input.magnet || input.infoHash) {
    const ref = parseTorrentRef(input.magnet || input.infoHash);
    if (!ref) return { ok: false, kind: 'none', detail: 'unparseable magnet' };
    kvSet(KV_MAGNET(videoKey), ref);
    return { ok: true, kind: 'debrid', detail: 'magnet stored — the debrid resolver will run on the first audio sync' };
  }
  return { ok: false, kind: 'none', detail: 'nothing to attach' };
}

/**
 * @param {{videoKey:string, videoHash?:string, videoSize?:number, filename?:string, allowDebrid?:boolean}} req
 * @returns {Promise<{kind:'local'|'url'|'none', path:string|null, headers?:object, reason?:string, title?:string}>}
 */
export async function resolveMedia(req) {
  const config = getConfig();
  const { videoKey, videoHash, videoSize, filename } = req || {};
  if (!videoKey) return { kind: 'none', path: null, reason: 'no videoKey' };

  // 1. explicit attachment
  const explicitPath = kvGet(KV_PATH(videoKey));
  if (explicitPath && await exists(explicitPath)) {
    return { kind: 'local', path: explicitPath, reason: 'attached local file', title: basename(explicitPath) };
  }
  if (explicitPath) mediaLog.warn(`attached media disappeared: ${explicitPath}`);

  const explicitUrl = kvGet(KV_URL(videoKey));
  if (explicitUrl?.url && (!explicitUrl.expiresAt || explicitUrl.expiresAt > Date.now())) {
    return { kind: 'url', path: explicitUrl.url, reason: 'attached direct URL', title: explicitUrl.filename };
  }

  // 2. local media roots
  const roots = config.LOCAL_MEDIA_ROOTS || [];
  if (roots.length) {
    const entries = await getMediaIndex(roots);
    const match = await matchLocalMedia(entries, { videoHash, videoSize, filename });
    if (match) return { kind: 'local', path: match.path, reason: match.reason, title: match.name };
  }

  // 3. debrid (opt-in, slow — only when the caller explicitly allows it)
  if (req.allowDebrid !== false) {
    const ref = kvGet(KV_MAGNET(videoKey));
    if (ref && config.DEBRID_PROVIDER && config.DEBRID_API_KEY) {
      const resolved = await resolveDebrid({
        provider: config.DEBRID_PROVIDER,
        apiKey: config.DEBRID_API_KEY,
        magnet: ref.magnet,
        infoHash: ref.infoHash,
        log: mediaLog,
      });
      if (resolved?.url) {
        kvSet(KV_URL(videoKey), { url: resolved.url, expiresAt: Date.now() + 6 * 3600 * 1000, filename: resolved.filename });
        return { kind: 'url', path: resolved.url, reason: `debrid:${resolved.provider}`, title: resolved.filename };
      }
      return { kind: 'none', path: null, reason: 'debrid could not resolve the magnet' };
    }
  }

  return { kind: 'none', path: null, reason: 'no local file, URL or debrid magnet attached to this video' };
}

/**
 * Find the local file matching the playing video.
 * Exact-hash first (only for candidates whose size matches, capped), then size+name, then name.
 */
async function matchLocalMedia(entries, { videoHash, videoSize, filename }) {
  if (!entries?.length) return null;
  const wantSize = Number(videoSize) || 0;

  if (videoHash && /^[0-9a-f]{16}$/i.test(videoHash)) {
    const candidates = entries
      .filter((e) => !wantSize || e.size === wantSize)
      .slice(0, 12);
    for (const candidate of candidates) {
      const cached = kvGet(KV_HASH(candidate.path, candidate.size));
      let hash = cached?.hash;
      if (!hash) {
        const computed = await openSubtitlesHash(candidate.path);
        if (!computed) continue;
        hash = computed.hash;
        kvSet(KV_HASH(candidate.path, candidate.size), { hash, at: Date.now() });
      }
      if (hash.toLowerCase() === String(videoHash).toLowerCase()) {
        return { path: candidate.path, name: candidate.name, reason: 'open-subtitles hash match' };
      }
    }
  }

  if (wantSize) {
    const bySize = entries.filter((e) => e.size === wantSize);
    if (bySize.length === 1) return { path: bySize[0].path, name: bySize[0].name, reason: 'exact file-size match' };
    if (filename && bySize.length > 1) {
      const best = bestByName(bySize, filename);
      if (best) return { path: best.entry.path, name: best.entry.name, reason: 'file-size + filename match' };
    }
  }

  if (filename) {
    const best = bestByName(entries, filename);
    if (best && best.score >= 0.5) return { path: best.entry.path, name: best.entry.name, reason: `filename match (${best.score.toFixed(2)})` };
  }
  return null;
}

function bestByName(entries, filename) {
  let best = null;
  for (const entry of entries) {
    const score = releaseSimilarity(filename, entry.name);
    const folded = String(filename).toLowerCase();
    const boost = folded.includes(entry.name.toLowerCase().replace(/\.[a-z0-9]+$/, '')) ? 0.35 : 0;
    const total = score + boost;
    if (!best || total > best.score) best = { entry, score: total };
  }
  return best;
}

/** Candidate list for the Sync Lab media picker. */
export async function listLocalMedia({ query = '', limit = 30 } = {}) {
  const config = getConfig();
  const entries = await getMediaIndex(config.LOCAL_MEDIA_ROOTS || []);
  const filtered = query
    ? entries
      .map((e) => ({ e, s: releaseSimilarity(String(query), e.name) }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e)
    : entries;
  return filtered.slice(0, limit).map((e) => ({ path: e.path, name: e.name, size: e.size }));
}

/** Probe with ffprobe for duration. Returns ms or null. */
export async function probeDuration(mediaPath, ffprobePath = 'ffprobe', timeoutMs = 20000) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mediaPath];
    let out = '';
    let child;
    try {
      child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const seconds = Number(out.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    });
  });
}

export { getMediaIndex, openSubtitlesHash, isVideoFile };
