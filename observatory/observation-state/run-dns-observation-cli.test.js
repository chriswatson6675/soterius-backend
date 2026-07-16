'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { run, parseArgs } = require('./run-dns-observation-cli');

function silentLog(lines) {
  return (msg) => lines.push(msg);
}

describe('parseArgs', () => {
  test('parses repeated --org, --limit, and --dry-run', () => {
    const parsed = parseArgs(['--org', 'ORG-1', '--org', 'ORG-2', '--limit', '5', '--dry-run']);
    assert.deepStrictEqual(parsed.orgIds, ['ORG-1', 'ORG-2']);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.dryRun, true);
  });

  test('defaults to no org ids, null limit, dryRun false', () => {
    const parsed = parseArgs([]);
    assert.deepStrictEqual(parsed.orgIds, []);
    assert.equal(parsed.limit, null);
    assert.equal(parsed.dryRun, false);
  });
});

describe('run — environment confirmation', () => {
  test('always logs an environment confirmation line, even on refusal', async () => {
    const lines = [];
    await run({}, { log: silentLog(lines), logEnvironmentConfirmation: (deps) => deps.log('ENV CONFIRMED') });
    assert.ok(lines.includes('ENV CONFIRMED'));
  });
});

describe('run — refuses an unbounded run', () => {
  test('with neither org ids nor a limit, refuses and performs no observation', async () => {
    let observeCalled = false;
    const result = await run({}, {
      log: () => {},
      observeOrganisationDnsSignals: async () => { observeCalled = true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.equal(observeCalled, false);
  });
});

describe('run — dry-run', () => {
  test('performs no collection and no database writes', async () => {
    let observeCalled = false;
    const result = await run(
      { orgIds: ['ORG-1', 'ORG-2'], dryRun: true },
      { log: () => {}, observeOrganisationDnsSignals: async () => { observeCalled = true; } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepStrictEqual(result.cohort, ['ORG-1', 'ORG-2']);
    assert.equal(observeCalled, false);
  });

  test('dry-run with --limit deterministically selects the cohort without observing', async () => {
    let observeCalled = false;
    const result = await run(
      { limit: 2, dryRun: true },
      {
        log: () => {},
        listOrganisationIds: async () => ['ORG-3', 'ORG-1', 'ORG-2'],
        observeOrganisationDnsSignals: async () => { observeCalled = true; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.cohort, ['ORG-1', 'ORG-2']);
    assert.equal(observeCalled, false);
  });
});

describe('run — real bounded execution', () => {
  test('invokes observeOrganisationDnsSignals once per explicit organisation id', async () => {
    const observed = [];
    const result = await run(
      { orgIds: ['ORG-1', 'ORG-2'], dryRun: false },
      {
        log: () => {},
        observeOrganisationDnsSignals: async (organisationId) => {
          observed.push(organisationId);
          return { organisationId, ok: true, domain: 'example.com', results: [] };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepStrictEqual(observed, ['ORG-1', 'ORG-2']);
  });

  test('logs a visible warning when a signal succeeds but its childError is set (supplementary evidence did not persist)', async () => {
    const lines = [];
    await run(
      { orgIds: ['ORG-1'], dryRun: false },
      {
        log: (msg) => lines.push(msg),
        observeOrganisationDnsSignals: async (organisationId) => ({
          organisationId, ok: true, domain: 'example.com',
          results: [{ signal: 'dkim', ok: true, childError: 'insert failed: null value in column "selector"' }],
        }),
      },
    );
    assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('supplementary evidence did not persist')));
  });

  test('does not log a warning when childError is absent', async () => {
    const lines = [];
    await run(
      { orgIds: ['ORG-1'], dryRun: false },
      {
        log: (msg) => lines.push(msg),
        observeOrganisationDnsSignals: async (organisationId) => ({
          organisationId, ok: true, domain: 'example.com',
          results: [{ signal: 'spf', ok: true, childError: null }],
        }),
      },
    );
    assert.ok(!lines.some((l) => l.includes('WARNING')));
  });
});
