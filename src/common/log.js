// Line-oriented structured logging. One JSON object per line when
// ALPHA_LOG_FORMAT=json, otherwise a compact human form for a terminal.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = LEVELS[process.env.ALPHA_LOG_LEVEL ?? 'info'] ?? LEVELS.info;
const asJson = process.env.ALPHA_LOG_FORMAT === 'json';

function emit(level, scope, message, fields) {
  if (LEVELS[level] < configuredLevel) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;

  if (asJson) {
    stream.write(
      JSON.stringify({ ts: new Date().toISOString(), level, scope, message, ...fields }) + '\n',
    );
    return;
  }

  const time = new Date().toISOString().slice(11, 23);
  const extras = Object.entries(fields ?? {})
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  stream.write(`${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extras ? ' ' + extras : ''}\n`);
}

export function createLogger(scope) {
  return {
    debug: (message, fields) => emit('debug', scope, message, fields),
    info: (message, fields) => emit('info', scope, message, fields),
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
    child: (suffix) => createLogger(`${scope}:${suffix}`),
  };
}
