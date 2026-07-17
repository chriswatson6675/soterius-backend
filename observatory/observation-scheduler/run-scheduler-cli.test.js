'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { run, parseArgs } = require('./run-scheduler-cli');

describe('parseArgs', () => {
  test('parses --limit, repeated --org, --dry-run, --now, --production, --force-org', () => {
    const parsed = parseArgs(['--org', 'ORG-1', '--org', 'ORG-2', '--limit', '10', '--dry-run', '--now', '2026-08-01T00:00:00.000Z', '--production', '--force-org']);
    assert.deepStrictEqual(parsed.orgIds, ['ORG-1', 'ORG-2']);
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.now, '2026-08-01T00:00:00.000Z');
    assert.equal(parsed.production, true);
    assert.equal(parsed.forceOrg, true);
  });

  test('defaults to no org ids, null limit/now, all flags false', () => {
    const parsed = parseArgs([]);
    assert.deepStrictEqual(parsed.orgIds, []);
    assert.equal(parsed.limit, null);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.now, null);
    assert.equal(parsed.production, false);
    assert.equal(parsed.forceOrg, false);
  });
});

describe('run — environment confirmation', () => {
  test('always logs an environment confirmation line', async () => {
    const lines = [];
    await run({}, { log: (m) => lines.push(m), logEnvironmentConfirmation: (deps) => deps.log('ENV CONFIRMED'), runScheduler: async () => ({ ok: false, refused: true, reason: 'x' }) });
    assert.ok(lines.includes('ENV CONFIRMED'));
  });
});

describe('run — delegates to runScheduler and logs the enriched summary', () => {
  test('a successful bounded run logs all seven summary counters', async () => {
    const lines = [];
    const result = await run(
      { limit: 10 },
      {
        log: (m) => lines.push(m),
        runScheduler: async () => ({
          ok: true, dryRun: false, cohort: ['ORG-1'],
          summary: {
            organisationsSelected: 1, statesSelected: 3, statesClaimed: 3,
            statesCompleted: 2, statesFailed: 1, statesSkippedFuture: 2, statesSkippedSuspendedOrClaimed: 0,
          },
        }),
      },
    );
    assert.equal(result.ok, true);
    const summaryLine = lines.find((l) => l.includes('organisations selected'));
    assert.ok(summaryLine);
    assert.ok(summaryLine.includes('organisations selected 1'));
    assert.ok(summaryLine.includes('states selected 3'));
    assert.ok(summaryLine.includes('claimed 3'));
    assert.ok(summaryLine.includes('completed 2'));
    assert.ok(summaryLine.includes('failed 1'));
    assert.ok(summaryLine.includes('skipped-future 2'));
    assert.ok(summaryLine.includes('skipped-suspended-or-claimed 0'));
  });

  test('a refused (unbounded) run does not print a summary line', async () => {
    const lines = [];
    const result = await run({}, { log: (m) => lines.push(m), runScheduler: async () => ({ ok: false, refused: true, reason: 'refused' }) });
    assert.equal(result.ok, false);
    assert.ok(!lines.some((l) => l.includes('summary')));
  });

  test('forwards forceOrg through to runScheduler', async () => {
    let seenArgs = null;
    await run(
      { orgIds: ['ORG-1'], forceOrg: true },
      { log: () => {}, runScheduler: async (args) => { seenArgs = args; return { ok: true, dryRun: true, cohort: [], summary: { organisationsSelected: 0, statesSelected: 0, statesClaimed: 0, statesCompleted: 0, statesFailed: 0, statesSkippedFuture: 0, statesSkippedSuspendedOrClaimed: 0 } }; } },
    );
    assert.equal(seenArgs.forceOrg, true);
  });
});
