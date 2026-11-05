/** Tiny leveled logger. Shared, read-only for teammates. Owned by LEAD. */
const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function currentLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return raw in LEVELS ? LEVELS[raw] : LEVELS.info;
}

function emit(level, scope, msg, extra) {
  if (LEVELS[level] > currentLevel()) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope ? `(${scope}) ` : ''}${msg}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra !== undefined) stream.write(`${line} ${safeJson(extra)}\n`);
  else stream.write(`${line}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_k, v) => (v instanceof Error ? { error: v.message } : v));
  } catch {
    return '[unserializable]';
  }
}

/** @param {string} scope */
export function createLogger(scope = '') {
  /** @type {(level:string,msg:string,extra?:object)=>void} */
  const log = (level, msg, extra) => emit(LEVELS[level] === undefined ? 'info' : level, scope, msg, extra);
  log.child = (sub) => createLogger(scope ? `${scope}:${sub}` : sub);
  log.error = (m, e) => emit('error', scope, m, e);
  log.warn = (m, e) => emit('warn', scope, m, e);
  log.info = (m, e) => emit('info', scope, m, e);
  log.debug = (m, e) => emit('debug', scope, m, e);
  log.trace = (m, e) => emit('trace', scope, m, e);
  return log;
}

export const log = createLogger('nuvio-sync');
