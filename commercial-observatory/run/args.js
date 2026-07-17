'use strict';

// Minimal `--key=value` / `--flag` CLI argument parser shared by the
// Commercial Observatory's manual CLIs. Kebab-case keys are converted to
// camelCase (e.g. --investigation-id=... -> { investigationId: '...' }).

function toCamel(key) {
  return key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const stripped = arg.slice(2);
    const eq = stripped.indexOf('=');
    if (eq === -1) {
      result[toCamel(stripped)] = true;
    } else {
      const key = stripped.slice(0, eq);
      const value = stripped.slice(eq + 1);
      result[toCamel(key)] = value;
    }
  }
  return result;
}

module.exports = { parseArgs, toCamel };
