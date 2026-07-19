'use strict';

// OBS-103 WP-1 — Unit tests for the DEPLOYED production scheduler entry point,
// run-drain-cli.js. Closes audit finding TD-08 ("run-drain-cli.js has no unit
// test"): the drain runner itself is covered by drain.test.js, but the CLI
// wrapper's argument parsing, production/refusal gates, value propagation, and
// exit-code contract were previously untested.
//
// These tests contact NEITHER Railway NOR Supabase and require NO production
// credentials. run()'s existing dependency-injection seam (deps.drainDueStates,
// deps.log, deps.logEnvironmentConfirmation) lets us drive the whole CLI with a
// fake drain that returns a canned summary — the real drain (and therefore any
// DB client) is never constructed. No production source was changed to enable
// this; the seam already existed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cli = require('./run-drain-cli');
const { DEFAULT_MAX_STATES_PER_RUN, DEFAULT_CONCURRENCY, DEFAULT_RUNTIME_BUDGET_MS } = require('./drain');
const { DEFAULT_PAGE_SIZE } = require('./due-selection');

// A fake drain runner that records how it was called and returns a canned,
// well-formed summary. Never touches a database.
function makeFakeDrain(summaryOverrides = {}) {
  const calls = [];
  const summary = {
    pagesFetched: 1, statesSeen: 3, orgsProcessed: 1, statesClaimed: 3,
    statesCompleted: 3, statesFailed: 0, statesSkipped: 0, stoppedReason: 'drained',
    ...summaryOverrides,
  };
  const fn = async (opts, deps) => { calls.push({ opts, deps }); return summary; };
  fn.calls = calls;
  fn.summary = summary;
  return fn;
}

function capturingLog() {
  const lines = [];
  const log = (msg) => lines.push(String(msg));
  log.lines = lines;
  log.joined = () => lines.join('\n');
  return log;
}

// Standard behaviour-neutral deps: a fake drain, a capturing log, and a no-op
// environment confirmation (so nothing reads process.env or logs credentials).
function deps(drain, log) {
  return { drainDueStates: drain, log, logEnvironmentConfirmation: () => {} };
}

describe('run-drain-cli parseArgs', () => {
  test('defaults with no flags: not production, not dry-run, canonical budgets', () => {
    const out = cli.parseArgs([]);
    assert.equal(out.production, false);
    assert.equal(out.dryRun, false);
    assert.equal(out.now, null);
    assert.equal(out.maxStatesPerRun, DEFAULT_MAX_STATES_PER_RUN);
    assert.equal(out.pageSize, DEFAULT_PAGE_SIZE);
    assert.equal(out.concurrency, DEFAULT_CONCURRENCY);
    assert.equal(out.runtimeBudgetMs, DEFAULT_RUNTIME_BUDGET_MS);
  });

  test('parses the canonical deployed production flags exactly', () => {
    const out = cli.parseArgs([
      '--production',
      '--max-states-per-run', '1500',
      '--page-size', '250',
      '--concurrency', '8',
      '--runtime-budget-ms', '720000',
    ]);
    assert.equal(out.production, true);
    assert.equal(out.maxStatesPerRun, 1500);
    assert.equal(out.pageSize, 250);
    assert.equal(out.concurrency, 8);
    assert.equal(out.runtimeBudgetMs, 720000);
    assert.equal(out.dryRun, false);
  });

  test('parses --dry-run and --now', () => {
    const out = cli.parseArgs(['--dry-run', '--now', '2026-07-20T00:00:00.000Z']);
    assert.equal(out.dryRun, true);
    assert.equal(out.now, '2026-07-20T00:00:00.000Z');
    assert.equal(out.production, false);
  });

  // Characterisation of the CURRENT numeric contract (parseInt, base 10, no
  // validation). Documents exactly what today's implementation does with
  // invalid/edge numeric input so a future validation guard is a deliberate,
  // test-visible change rather than a silent one. NOTE: the CLI does not
  // currently reject these — see the WP-1 report's residual risks.
  test('numeric flags: malformed values become NaN (parseInt semantics)', () => {
    const out = cli.parseArgs(['--max-states-per-run', 'abc', '--concurrency', '1.9x']);
    assert.ok(Number.isNaN(out.maxStatesPerRun), 'malformed max-states-per-run parses to NaN');
    assert.equal(out.concurrency, 1, 'parseInt("1.9x") is 1 (trailing garbage dropped)');
  });

  test('numeric flags: a missing trailing value becomes NaN', () => {
    const out = cli.parseArgs(['--page-size']);
    assert.ok(Number.isNaN(out.pageSize), 'trailing --page-size with no value parses to NaN');
  });

  test('numeric flags: zero and negative values are accepted as-is (not validated)', () => {
    const out = cli.parseArgs(['--max-states-per-run', '0', '--runtime-budget-ms', '-5']);
    assert.equal(out.maxStatesPerRun, 0);
    assert.equal(out.runtimeBudgetMs, -5);
  });
});

describe('run-drain-cli run() — production/refusal gates', () => {
  test('refuses to run without --production (and without --dry-run); does not drain', async () => {
    const drain = makeFakeDrain();
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs([]), deps(drain, log));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.match(outcome.reason, /--production/);
    assert.equal(drain.calls.length, 0, 'the drain runner must not be invoked on refusal');
  });

  test('refuses --now without --dry-run; does not drain', async () => {
    const drain = makeFakeDrain();
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs(['--production', '--now', '2026-07-20T00:00:00.000Z']), deps(drain, log));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.match(outcome.reason, /--now/);
    assert.equal(drain.calls.length, 0);
  });

  test('--dry-run is a genuine no-op: reports params, never drains, never writes', async () => {
    const drain = makeFakeDrain();
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs(['--dry-run']), deps(drain, log));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.dryRun, true);
    assert.equal(drain.calls.length, 0, 'dry-run must not invoke the drain runner');
    assert.match(log.joined(), /DRY RUN/);
  });
});

describe('run-drain-cli run() — production execution & propagation', () => {
  test('with --production, invokes the drain runner exactly once', async () => {
    const drain = makeFakeDrain();
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs(['--production']), deps(drain, log));
    assert.equal(outcome.ok, true);
    assert.equal(drain.calls.length, 1);
    assert.deepEqual(outcome.summary, drain.summary);
  });

  test('propagates the parsed budgets into the drain runner unchanged', async () => {
    const drain = makeFakeDrain();
    const log = capturingLog();
    const argv = ['--production', '--max-states-per-run', '1500', '--page-size', '250',
      '--concurrency', '8', '--runtime-budget-ms', '720000'];
    await cli.run(cli.parseArgs(argv), deps(drain, log));
    const passed = drain.calls[0].opts;
    assert.equal(passed.maxStatesPerRun, 1500);
    assert.equal(passed.pageSize, 250);
    assert.equal(passed.concurrency, 8);
    assert.equal(passed.runtimeBudgetMs, 720000);
    assert.equal(passed.now, null);
  });

  test('surfaces a runtime-budget bounded-run termination in the summary', async () => {
    const drain = makeFakeDrain({ stoppedReason: 'runtime-budget', statesSeen: 1500, statesClaimed: 1500, statesCompleted: 1500 });
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs(['--production']), deps(drain, log));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary.stoppedReason, 'runtime-budget');
    assert.match(log.joined(), /stopped=runtime-budget/);
  });

  test('surfaces a work-budget (max-states) bounded-run termination in the summary', async () => {
    const drain = makeFakeDrain({ stoppedReason: 'work-budget' });
    const log = capturingLog();
    const outcome = await cli.run(cli.parseArgs(['--production']), deps(drain, log));
    assert.equal(outcome.summary.stoppedReason, 'work-budget');
    assert.match(log.joined(), /stopped=work-budget/);
  });
});

describe('run-drain-cli exitCodeFor', () => {
  test('exit 0 for an accepted (ok) outcome — including a completed drain with failed states', () => {
    assert.equal(cli.exitCodeFor({ ok: true, summary: { statesFailed: 0 } }), 0);
    // Per the CLI contract, per-observation failures are recorded outcomes, not
    // a process failure — a completed drain still exits 0 to avoid restart storms.
    assert.equal(cli.exitCodeFor({ ok: true, summary: { statesFailed: 7 } }), 0);
  });

  test('exit 1 for a refused / not-ok outcome', () => {
    assert.equal(cli.exitCodeFor({ ok: false, refused: true, reason: 'x' }), 1);
  });
});

describe('run-drain-cli environment confirmation & import safety', () => {
  test('default logEnvironmentConfirmation logs the target without constructing a DB client', () => {
    const log = capturingLog();
    // No SUPABASE creds needed: it only reads process.env.SUPABASE_URL for a log
    // line and never calls getClient(), so it cannot contact a database.
    assert.doesNotThrow(() => cli.logEnvironmentConfirmation({ log }));
    assert.match(log.joined(), /target environment/);
  });

  test('module import is side-effect-free: exports present, no drain executed on require', () => {
    // Requiring the module (this file already did) must not have run a drain or
    // exited the process — the `require.main === module` guard prevents that.
    for (const name of ['run', 'parseArgs', 'exitCodeFor', 'logEnvironmentConfirmation']) {
      assert.equal(typeof cli[name], 'function', `${name} must be exported`);
    }
    assert.ok(process.exitCode === undefined || process.exitCode === 0,
      'importing the CLI must not set a nonzero exit code');
  });
});
