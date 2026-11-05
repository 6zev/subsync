/**
 * Build identity.
 *
 * `version` from package.json is useless for telling one deployment from another — it does not
 * change between builds. The commit sha does, so it is baked into the image at build time
 * (`--build-arg GIT_SHA=...` → `ENV GIT_SHA=...`) and surfaces in /healthz, /stats, the boot log
 * and the configure page.
 *
 * Outside a container the sha is read from the local git checkout, best effort.
 * Owned by LEAD.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './env.js';

const UNKNOWN = 'unknown';

let cached = null;

/** Read the sha of the checkout this process is running from (best effort, once). */
function gitShaFromCheckout() {
  try {
    if (!existsSync(join(PROJECT_ROOT, '.git'))) return null;
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version || UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * @returns {{version:string, sha:string, shortSha:string, builtAt:string|null, source:'env'|'git'|'unknown'}}
 */
export function getBuildInfo() {
  if (cached) return cached;
  const envSha = (process.env.GIT_SHA || process.env.NUVIO_GIT_SHA || '').trim();
  const sha = envSha || gitShaFromCheckout() || UNKNOWN;
  cached = {
    version: packageVersion(),
    sha,
    shortSha: sha === UNKNOWN ? UNKNOWN : sha.slice(0, 7),
    builtAt: (process.env.BUILD_TIME || process.env.NUVIO_BUILD_TIME || '').trim() || null,
    source: envSha ? 'env' : (sha === UNKNOWN ? 'unknown' : 'git'),
  };
  return cached;
}

/** One-line summary for logs. */
export function buildLabel() {
  const info = getBuildInfo();
  return `v${info.version} (${info.shortSha}${info.builtAt ? `, built ${info.builtAt}` : ''})`;
}

export { UNKNOWN };
