'use strict';

// Regression tests for the process-level crash safety net (Production
// Readiness Audit, 2026-07-13, ENG-043 finding: server.js had no
// uncaughtException/unhandledRejection handler at all).

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { registerCrashHandlers } = require('./crash-handlers');

// Each test registers its own listeners on the real process-wide event
// emitter — always remove them afterward so one test's handler doesn't fire
// for an unrelated event raised elsewhere in the same test run.
function cleanupListeners() {
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
}

describe('registerCrashHandlers', () => {
  afterEach(cleanupListeners);

  test('logs and exits(1) on uncaughtException, with the full stack', () => {
    cleanupListeners();
    const logged = [];
    let exitCode = null;
    registerCrashHandlers({ logger: { error: (m) => logged.push(m) }, exit: (code) => { exitCode = code; } });

    process.emit('uncaughtException', new Error('boom'));

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0], /uncaughtException/);
    assert.match(logged[0], /boom/);
  });

  test('logs and exits(1) on unhandledRejection, whether the reason is an Error or not', () => {
    cleanupListeners();
    const logged = [];
    let exitCode = null;
    registerCrashHandlers({ logger: { error: (m) => logged.push(m) }, exit: (code) => { exitCode = code; } });

    process.emit('unhandledRejection', new Error('rejected'));
    assert.strictEqual(exitCode, 1);
    assert.match(logged[0], /unhandledRejection/);
    assert.match(logged[0], /rejected/);

    exitCode = null;
    logged.length = 0;
    process.emit('unhandledRejection', 'a non-Error rejection reason');
    assert.strictEqual(exitCode, 1);
    assert.match(logged[0], /a non-Error rejection reason/);
  });

  test('defaults to the real logger and process.exit when no overrides are supplied', () => {
    cleanupListeners();
    registerCrashHandlers();
    assert.strictEqual(process.listenerCount('uncaughtException'), 1);
    assert.strictEqual(process.listenerCount('unhandledRejection'), 1);
  });
});
