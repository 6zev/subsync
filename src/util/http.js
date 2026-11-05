/**
 * Shared HTTP helpers. Read-only for teammates. Owned by LEAD.
 * Zero dependencies — global fetch (Node >= 18).
 */
import { createLogger } from './log.js';

const httpLog = createLogger('http');

export const DEFAULT_UA =
  'nuvio-sync/0.1 (+https://github.com/local/nuvio-sync) Stremio subtitle addon';

/** Abort-after helper. Returns {signal, cancel}. */
export function timeoutSignal(ms, parent) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms) : null;
  if (timer?.unref) timer.unref();
  return {
    signal: ac.signal,
    cancel() {
      if (timer) clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    },
  };
}

export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Sleep that cannot keep the process alive. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
    }
  });
}

/**
 * Low-level fetch with retries, default UA and hard timeout.
 * @returns {Promise<Response>}
 */
export async function fetchResponse(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 12000,
  retries = 2,
  retryDelayMs = 400,
  redirect = 'follow',
  signal: parentSignal,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { signal, cancel } = timeoutSignal(timeoutMs, parentSignal);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': DEFAULT_UA, accept: '*/*', ...headers },
        body,
        redirect,
        signal,
      });
      cancel();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : retryDelayMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      cancel();
      lastError = err;
      if (parentSignal?.aborted) throw err;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`fetch failed: ${url}`);
}

/** @returns {Promise<{status:number, headers:Record<string,string>, body:string, ok:boolean}>} */
export async function httpText(url, opts = {}) {
  const res = await fetchResponse(url, opts);
  const body = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    headers: Object.fromEntries(res.headers.entries()),
    body,
  };
}

/** @returns {Promise<any>} parsed JSON, throws with the response body on failure */
export async function httpJson(url, opts = {}) {
  const res = await fetchResponse(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`invalid JSON from ${url}: ${text.slice(0, 160)}`);
    e.cause = err;
    throw e;
  }
}

/** POST JSON convenience. */
export async function httpJsonPost(url, payload, opts = {}) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(payload),
    ...opts,
  });
}

/** Download a (possibly large) body to a file. Node stream -> no buffering. */
export async function downloadToFile(url, destPath, opts = {}) {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const res = await fetchResponse(url, { timeoutMs: opts.timeoutMs ?? 60000, retries: opts.retries ?? 2, headers: opts.headers, signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(destPath));
  return destPath;
}

/** Fire-and-forget wrapper used for cache warming. */
export function detach(promise, label = 'detached') {
  Promise.resolve(promise).catch((err) => httpLog.debug(`${label} failed: ${err?.message}`));
}
