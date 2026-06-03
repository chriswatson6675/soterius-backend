const LEVEL_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVEL_PRIORITY[process.env.LOG_LEVEL] ?? LEVEL_PRIORITY.info;

function log(level, message) {
  if (LEVEL_PRIORITY[level] > currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  level === 'error' ? console.error(line) : console.log(line);
}

module.exports = {
  info:  (msg) => log('info', msg),
  warn:  (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
  debug: (msg) => log('debug', msg),
};
