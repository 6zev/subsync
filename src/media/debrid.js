/**
 * Debrid resolvers — turn a stored magnet / infohash into a directly playable URL so the
 * audio stage can pull the real audio track. Owned by LEAD.
 *
 * Everything is best-effort: any failure resolves to null and the caller degrades to the
 * text-only sync paths.
 */
import { httpJson, httpJsonPost, httpText, withTimeout, sleep } from '../util/http.js';
import { createLogger } from '../util/log.js';

const debridLog = createLogger('debrid');

/** Pluggable provider registry. */
export const DEBRID_PROVIDERS = Object.freeze({
  realdebrid: { id: 'realdebrid', name: 'Real-Debrid', api: 'https://api.real-debrid.com/rest/1.0' },
  torbox: { id: 'torbox', name: 'TorBox', api: 'https://api.torbox.app/v1/api' },
  alldebrid: { id: 'alldebrid', name: 'AllDebrid', api: 'https://api.alldebrid.com/v4' },
});

/**
 * Resolve a magnet/infohash into a direct URL.
 * @param {{provider:string, apiKey:string, magnet?:string, infoHash?:string, timeoutMs?:number, log?:Function}} opts
 * @returns {Promise<{url:string, filename?:string, provider:string, bytes?:number}|null>}
 */
export async function resolveDebrid({ provider, apiKey, magnet, infoHash, timeoutMs = 90000, log }) {
  const say = (level, msg, extra) => (log || debridLog)(level, msg, extra);
  if (!provider || !apiKey) return null;
  const magnetUri = magnet || (infoHash ? `magnet:?xt=urn:btih:${infoHash}` : null);
  if (!magnetUri) return null;
  try {
    switch (provider) {
      case 'realdebrid':
        return await withTimeout(realDebrid({ apiKey, magnet: magnetUri, say }), timeoutMs, 'realdebrid');
      case 'torbox':
        return await withTimeout(torBox({ apiKey, magnet: magnetUri, say }), timeoutMs, 'torbox');
      case 'alldebrid':
        return await withTimeout(allDebrid({ apiKey, magnet: magnetUri, say }), timeoutMs, 'alldebrid');
      default:
        say('warn', `unknown debrid provider "${provider}"`);
        return null;
    }
  } catch (err) {
    say('warn', `debrid resolve failed: ${err.message}`);
    return null;
  }
}

const auth = (key) => ({ authorization: `Bearer ${key}` });

async function realDebrid({ apiKey, magnet, say }) {
  const api = DEBRID_PROVIDERS.realdebrid.api;
  const added = await httpJson(`${api}/torrents/addMagnet`, {
    method: 'POST',
    headers: { ...auth(apiKey), 'content-type': 'application/x-www-form-urlencoded' },
    body: `magnet=${encodeURIComponent(magnet)}`,
  });
  const id = added?.id;
  if (!id) return null;
  await httpJson(`${api}/torrents/selectFiles/${id}`, {
    method: 'POST',
    headers: { ...auth(apiKey), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'files=all',
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await httpJson(`${api}/torrents/info/${id}`, { headers: auth(apiKey) });
    const link = (info?.links || [])[0];
    if (link) {
      const un = await httpJson(`${api}/unrestrict/link`, {
        method: 'POST',
        headers: { ...auth(apiKey), 'content-type': 'application/x-www-form-urlencoded' },
        body: `link=${encodeURIComponent(link)}`,
      });
      if (un?.download) {
        say('info', `realdebrid resolved ${info?.filename || id}`);
        return { url: un.download, filename: un.filename || info?.filename, bytes: un.filesize, provider: 'realdebrid' };
      }
    }
    await sleep(3000);
  }
  say('warn', 'realdebrid: torrent never became ready');
  return null;
}

async function torBox({ apiKey, magnet, say }) {
  const api = DEBRID_PROVIDERS.torbox.api;
  const created = await httpJson(`${api}/torrents/createtorrent`, {
    method: 'POST',
    headers: auth(apiKey),
    body: (() => {
      const form = new FormData();
      form.append('magnet', magnet);
      return form;
    })(),
  });
  const id = created?.data?.torrent_id ?? created?.data?.torrentid;
  if (!id) return null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = await httpJson(`${api}/torrents/mylist?id=${id}&bypass_cache=true`, { headers: auth(apiKey) });
    const torrent = Array.isArray(list?.data) ? list.data[0] : list?.data;
    if (torrent?.download_state === 'downloaded' || torrent?.download_finished) {
      const req = await httpJson(`${api}/torrents/requestdl?token=${apiKey}&torrent_id=${id}&file_id=0&zip_link=false`, { headers: auth(apiKey) });
      if (req?.data) return { url: req.data, filename: torrent.name, provider: 'torbox' };
    }
    await sleep(3000);
  }
  say('warn', 'torbox: torrent never became ready');
  return null;
}

async function allDebrid({ apiKey, magnet, say }) {
  const api = DEBRID_PROVIDERS.alldebrid.api;
  const up = await httpText(`${api}/magnet/upload?agent=nuvio-sync&apikey=${encodeURIComponent(apiKey)}&magnets[]=${encodeURIComponent(magnet)}`);
  const parsed = safeJson(up.body);
  const id = parsed?.data?.magnets?.[0]?.id;
  if (!id) return null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const st = await httpText(`${api}/magnet/status?agent=nuvio-sync&apikey=${encodeURIComponent(apiKey)}&id=${id}`);
    const magnetInfo = safeJson(st.body)?.data?.magnets;
    if (magnetInfo?.statusCode === 4 && magnetInfo.links?.length) {
      const un = await httpText(`${api}/link/unlock?agent=nuvio-sync&apikey=${encodeURIComponent(apiKey)}&link=${encodeURIComponent(magnetInfo.links[0].link)}`);
      const url = safeJson(un.body)?.data?.link;
      if (url) return { url, filename: magnetInfo.filename, provider: 'alldebrid' };
    }
    await sleep(3000);
  }
  say('warn', 'alldebrid: torrent never became ready');
  return null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Parse a magick link / infohash out of arbitrary user input. */
export function parseTorrentRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const btih = raw.match(/\b([0-9a-fA-F]{40}|[A-Za-z2-7]{32})\b/);
  if (/^magnet:/i.test(raw)) return { magnet: raw, infoHash: btih ? btih[1].toLowerCase() : null };
  if (btih && !raw.includes('/')) return { infoHash: btih[1].toLowerCase() };
  return { magnet: `magnet:?xt=urn:btih:${raw}` };
}

export { httpJsonPost };
