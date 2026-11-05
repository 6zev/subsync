/**
 * HTTP server: turns node:http requests into the router's normalised shape.
 * Owned by LEAD.
 */
import { createServer } from 'node:http';
import { route } from './addon/router.js';
import { getConfig } from './env.js';
import { createLogger } from './util/log.js';

const serverLog = createLogger('server');
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {{host:string, port:number, publicUrl?:string}} opts
 * @returns {Promise<{server:import('node:http').Server, url:string, close:()=>Promise<void>}>}
 */
export function startServer({ host = '0.0.0.0', port = 7878, publicUrl = '' } = {}) {
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let response;
    try {
      const body = await readBody(req);
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const baseUrl = resolveBaseUrl(publicUrl, req);
      response = await route({
        method: req.method || 'GET',
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body,
        baseUrl,
        log: serverLog,
      });
    } catch (err) {
      serverLog.error(`unhandled: ${err.message}`);
      response = { status: 500, body: JSON.stringify({ ok: false, error: 'internal error' }), contentType: 'application/json' };
    }
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'x-content-type-options': 'nosniff',
      ...(response.headers || {}),
    };
    res.writeHead(response.status, { 'content-type': response.contentType, ...headers });
    res.end(response.body);
    if (Date.now() - started > 1500) {
      serverLog.info(`${req.method} ${req.url} -> ${response.status} in ${Date.now() - started}ms`);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const url = publicUrl || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
      serverLog.info(`listening on ${host}:${actualPort} (advertised as ${url})`);
      resolve({
        server,
        url,
        port: actualPort,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function resolveBaseUrl(publicUrl, req) {
  if (publicUrl) return publicUrl.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`.replace(/\/$/, '');
}

function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve('');
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** Convenience for CLI use. */
export async function startFromConfig() {
  const config = getConfig();
  return startServer({ host: config.HOST, port: config.PORT, publicUrl: config.PUBLIC_URL });
}
