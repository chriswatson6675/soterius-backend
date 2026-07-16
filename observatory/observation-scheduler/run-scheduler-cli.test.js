'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { run, parseArgs } = require('./run-scheduler-cli');

describe('parseArgs', () => {
  test('parses --limit, repeated --org, --dry-run, --now, --production', () => {
    const parsed = parseArgs(['--org', 'ORG-1', '--org', 'ORG-2', '--limit', '10', '--dry-run', '--now', '2026-08-01T00:00:00.000Z', '--production']);
    assert.deepStrictEqual(parsed.orgIds, ['ORG-1', 'ORG-2']);
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.now, '2026-08-01T00:00:00.000Z');
    assert.equal(parsed.production, true);
  });

  test('defaults to no org ids, null limit/now, dryRun/production false', () => {
    const parsed = parseArgs([]);
    assert.deepStrictEqual(parsed.orgIds, []);
    assert.equal(parsed.limit, null);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.now, null);
    assert.equal(parsed.production, false);
  });
});

describe('run — environment confirmation', () => {
  test('always logs an environment confirmation line', async () => {
    const lines = [];
    await run({}, { log: (m) => lines.push(m), logEnvironmentConfirmation: (deps) => deps.log('ENV CONFIRMED'), runScheduler: async () => ({ ok: false, refused: true, reason: 'x' }) });
    assert.ok(lines.includes('ENV CONFIRMED'));
  });
});

describe('run — delegates to runScheduler and logs the summary', () => {
  test('a successful bounded run logs the summary counts', async () => {
    const lines = [];
    const result = await run(
      { limit: 10 },
      {
        log: (m) => lines.push(m),
        runScheduler: async () => ({ ok: true, dryRun: false, cohort: ['ORG-1'], summary: { selected: 1, claimed: 1, completed: 1, failed: 0, skipped: 0 } }),
      },
    );
    assert.equal(result.ok, true);
    assert.ok(lines.some((l) => l.includes('selected 1') && l.includes('completed 1')));
  });

  test('a refused (unbounded) run does not print a summary line', async () => {
    const lines = [];
    const result = await run({}, { log: (m) => lines.push(m), runScheduler: async () => ({ ok: false, refused: true, reason: 'refused' }) });
    assert.equal(result.ok, false);
    assert.ok(!lines.some((l) => l.includes('summary')));
  });
});
