#!/usr/bin/env node
/**
 * nuvio-sync entry point.
 * Owned by LEAD.
 */
import { startFromConfig } from './server.js';
import { getConfig, DATA_DIR } from './env.js';
import { prune } from './store/index.js';
import { probeTools } from './sync/audioAlign.js';
import { listProviders } from './providers/index.js';
import { createLogger } from './util/log.js';

const log = createLogger('boot');

async function main() {
  const config = getConfig();
  const started = await startFromConfig();

  const providers = listProviders(config).filter((p) => p.enabled);
  const tools = await probeTools({ ffmpegPath: config.FFMPEG_PATH, alassPath: config.ALASS_PATH, ffsubsyncPath: config.FFSUBSYNC_PATH });

  log.info(`data dir: ${DATA_DIR}`);
  log.info(`providers: ${providers.map((p) => `${p.id}${p.configured ? '' : '(needs key)'}`).join(', ') || 'none'}`);
  log.info(`sync mode: ${config.SYNC_MODE} · llm: ${config.LLM_PROVIDER || 'off'} · audio: ${config.AUDIO_SYNC_ENABLED ? 'on' : 'off'}`);
  log.info(`tools: ffmpeg=${tools.ffmpeg ? 'yes' : 'no'} alass=${tools.alass ? 'yes' : 'no'} ffsubsync=${tools.ffsubsync ? 'yes' : 'no'}`);
  log.info('');
  log.info(`  Configure : ${started.url}/configure`);
  log.info(`  Manifest  : ${started.url}/manifest.json`);
  log.info(`  Install   : paste the manifest URL into Stremio -> Addons -> Install from URL`);
  log.info('');

  const timer = setInterval(() => {
    try { prune(); } catch (err) { log.warn(`prune failed: ${err.message}`); }
  }, 6 * 3600 * 1000);
  if (timer.unref) timer.unref();

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    clearInterval(timer);
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(`fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
