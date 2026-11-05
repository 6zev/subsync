/**
 * OpenSubtitles file hash (aka "moviehash") + local media scanning helpers.
 * Owned by LEAD.
 */
import { open, stat, readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createLogger } from '../util/log.js';

const mediaLog = createLogger('media');

const CHUNK = 64 * 1024;
const MASK64 = (1n << 64n) - 1n;

/**
 * Compute the OpenSubtitles hash of a local file:
 * size + sum of the little-endian uint64 words of the first and last 64 KiB.
 * @param {string} filePath
 * @returns {Promise<{hash:string,size:number}|null>}
 */
export async function openSubtitlesHash(filePath) {
  let handle;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < CHUNK * 2) return null;
    handle = await open(filePath, 'r');
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await handle.read(head, 0, CHUNK, 0);
    await handle.read(tail, 0, CHUNK, info.size - CHUNK);
    let acc = BigInt(info.size);
    for (const buf of [head, tail]) {
      for (let i = 0; i < CHUNK; i += 8) acc = (acc + buf.readBigUInt64LE(i)) & MASK64;
    }
    return { hash: acc.toString(16).padStart(16, '0'), size: info.size };
  } catch (err) {
    mediaLog.debug(`hash failed for ${filePath}: ${err.message}`);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv', '.divx',
]);

/** @param {string} name */
export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(extname(name).toLowerCase());
}

/* ── directory index ───────────────────────────────────────────────────── */

/** @type {{roots:string[], entries:Array<{path:string,name:string,size:number,mtimeMs:number}>, builtAt:number}} */
let index = { roots: [], entries: [], builtAt: 0 };
const INDEX_TTL_MS = 120000;
const MAX_ENTRIES = 200000;

/**
 * Walk the configured media roots (lazily, cached).
 * @param {string[]} roots
 * @param {{force?:boolean, maxDepth?:number}} [opts]
 */
export async function getMediaIndex(roots, { force = false, maxDepth = 6 } = {}) {
  const wanted = [...(roots || [])].filter(Boolean).sort();
  const same = wanted.length === index.roots.length && wanted.every((r, i) => r === index.roots[i]);
  if (!force && same && Date.now() - index.builtAt < INDEX_TTL_MS) return index.entries;
  const entries = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth || entries.length >= MAX_ENTRIES) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      mediaLog.debug(`cannot read ${dir}: ${err.message}`);
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(item.name)) continue;
        await walk(full, depth + 1);
      } else if (item.isFile() && isVideoFile(item.name)) {
        try {
          const info = await stat(full);
          entries.push({ path: full, name: basename(full), size: info.size, mtimeMs: info.mtimeMs });
        } catch { /* race with a moving file, ignore */ }
      }
    }
  };
  for (const root of wanted) await walk(root, 0);
  index = { roots: wanted, entries, builtAt: Date.now() };
  mediaLog.info(`media index: ${entries.length} files under ${wanted.length} root(s)`);
  return entries;
}
