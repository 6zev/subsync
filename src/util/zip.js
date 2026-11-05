/**
 * Minimal ZIP reader (stored + deflate), used because several subtitle providers hand back
 * `.zip` archives. Zero dependencies: node:zlib does the inflate.
 * Owned by LEAD.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|sub|txt)$/i;

/**
 * @param {Buffer} buffer
 * @returns {Array<{name:string, size:number, method:number, offset:number, compressedSize:number}>}
 */
export function listZipEntries(buffer) {
  const entries = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return entries;
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return entries;
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && pointer + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(pointer) !== SIG_CENTRAL) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLen = buffer.readUInt16LE(pointer + 28);
    const extraLen = buffer.readUInt16LE(pointer + 30);
    const commentLen = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLen);
    entries.push({ name, size, method, offset: localOffset, compressedSize });
    pointer += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extract one entry's bytes.
 * @param {Buffer} buffer
 * @param {{name:string, method:number, offset:number, compressedSize:number, size:number}} entry
 * @returns {Buffer|null}
 */
export function readZipEntry(buffer, entry) {
  try {
    const base = entry.offset;
    if (buffer.readUInt32LE(base) !== 0x04034b50) return null;
    const nameLen = buffer.readUInt16LE(base + 26);
    const extraLen = buffer.readUInt16LE(base + 28);
    const dataStart = base + 30 + nameLen + extraLen;
    const size = entry.compressedSize || entry.size;
    const raw = buffer.subarray(dataStart, dataStart + size);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull the most likely subtitle payload out of a zip, or return the buffer unchanged when it
 * is not a zip at all.
 * @param {Buffer} buffer
 * @returns {{body:Buffer, name:string, fromZip:boolean}}
 */
export function unwrapSubtitlePayload(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return { body: buffer, name: '', fromZip: false };
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip) return { body: buffer, name: '', fromZip: false };
  const entries = listZipEntries(buffer).filter((e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX'));
  if (!entries.length) return { body: buffer, name: '', fromZip: false };
  const ranked = entries.slice().sort((a, b) => {
    const aScore = (SUBTITLE_EXT.test(a.name) ? 2 : 0) + (a.size > 100 ? 1 : 0);
    const bScore = (SUBTITLE_EXT.test(b.name) ? 2 : 0) + (b.size > 100 ? 1 : 0);
    return bScore - aScore || b.size - a.size;
  });
  for (const entry of ranked) {
    const body = readZipEntry(buffer, entry);
    if (body?.length) return { body, name: entry.name, fromZip: true };
  }
  return { body: buffer, name: '', fromZip: false };
}
