'use strict';

// Integration boundary test for the two-wake-a-day Railway cron design
// (30 8,9 * * * UTC) — proves runScheduler()'s own due/future classification
// behaves safely across the GMT/BST boundary, WITHOUT re-testing
// cadence-policy.js's own DST math (see cadence-policy.test.js for that).
// This only exercises the integration boundary: given a next_due_at that
// cadence-policy already anchored to 09:30 Europe/London, does a wake at the
// "wrong" UTC time correctly see it as future, and the "right" one as due —
// and does neither wake ever force execution of a state that isn't due.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScheduler } = require('./run-scheduler');
const { computeNextDueAt } = require('../observation-state/cadence-policy');

// A single fake client supporting both query shapes runScheduler's dry-run
// path issues against 'observation_states': due-selection's
// select().in().not().or().order().limit() (twice — due + stale-claim), and
// classifyOrganisationDnsStates' select().eq().in() (via store.getAllByOrganisation).
function fakeClient(rows) {
  return {
    from(table) {
      if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
      let filtered = [...rows];
      let mode = null; // 'due' | 'stale' | 'plain'
      const builder = {
        select() { return builder; },
        in(col, vals) {
          if (mode === null) mode = 'due';
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return builder;
        },
        not(col, op, val) {
          mode = 'due';
          const excluded = val.replace(/[()]/g, '').split(',');
          filtered = filtered.filter((r) => !excluded.includes(r.status));
          return builder;
        },
        or(expr) {
          if (mode === 'due') {
            const nowIso = expr.split('lte.')[1];
            filtered = filtered.filter((r) => r.next_due_at === null || r.next_due_at <= nowIso);
          }
          return builder;
        },
        eq(col, val) {
          if (col === 'status' && val === 'running') mode = 'stale';
          else if (mode === null) mode = 'plain';
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        lt(col, val) {
          filtered = filtered.filter((r) => r[col] < val);
          return builder;
        },
        order() { return builder; },
        limit() { return Promise.resolve({ data: filtered, error: null }); },
        then(onFulfilled) { return Promise.resolve({ data: filtered, error: null }).then(onFulfilled); },
      };
      return builder;
    },
  };
}

function row(organisationId, observationType, nextDueAt) {
  return {
    organisation_id: organisationId, observation_type: observationType,
    next_due_at: nextDueAt, status: 'observed', updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('dual-wake DST safety (Railway cron 30 8,9 * * * UTC)', () => {
  test('BST: the 08:30 UTC wake (= 09:30 BST) finds the daily state due', async () => {
    const rows = [row('ORG-1', 'spf', '2026-07-17T08:30:00.000Z')];
    const outcome = await runScheduler(
      { orgIds: ['ORG-1'], dryRun: true, now: '2026-07-17T08:30:00.000Z' },
      { client: fakeClient(rows) },
    );
    const plan = outcome.plan.find((p) => p.organisationId === 'ORG-1');
    assert.ok(plan.classification.due.includes('spf'), 'must be due at 08:30 UTC in BST');
  });

  test('BST: after that state is (simulated) completed, the same-day 09:30 UTC wake sees it as future — a no-op', async () => {
    // Simulate what a real completed run would have persisted: next_due_at
    // advanced via cadence-policy's own computeNextDueAt (not re-tested here,
    // only consumed) from the 08:30 UTC observation just above.
    const advancedNextDueAt = computeNextDueAt('2026-07-17T08:30:05.000Z', 'spf');
    assert.equal(advancedNextDueAt, '2026-07-18T08:30:00.000Z'); // tomorrow's 09:30 BST
    const rows = [row('ORG-1', 'spf', advancedNextDueAt)];
    const outcome = await runScheduler(
      { orgIds: ['ORG-1'], dryRun: true, now: '2026-07-17T09:30:00.000Z' },
      { client: fakeClient(rows) },
    );
    // Not selected at all — orgIds filtered to due-only, and nothing is due.
    assert.deepStrictEqual(outcome.cohort, []);
    assert.equal(outcome.summary.statesSelected, 0);
  });

  test('GMT: the 08:30 UTC wake sees the 09:30-London state as future (GMT = UTC+0, so 09:30 local is 09:30 UTC, not yet reached)', async () => {
    const rows = [row('ORG-1', 'dkim', '2026-01-19T09:30:00.000Z')];
    const outcome = await runScheduler(
      { orgIds: ['ORG-1'], dryRun: true, now: '2026-01-19T08:30:00.000Z' },
      { client: fakeClient(rows) },
    );
    assert.deepStrictEqual(outcome.cohort, [], 'must not be selected — not yet due at 08:30 UTC in GMT');
    assert.equal(outcome.summary.statesSelected, 0);
  });

  test('GMT: the 09:30 UTC wake finds the same state due', async () => {
    const rows = [row('ORG-1', 'dkim', '2026-01-19T09:30:00.000Z')];
    const outcome = await runScheduler(
      { orgIds: ['ORG-1'], dryRun: true, now: '2026-01-19T09:30:00.000Z' },
      { client: fakeClient(rows) },
    );
    const plan = outcome.plan.find((p) => p.organisationId === 'ORG-1');
    assert.ok(plan.classification.due.includes('dkim'), 'must be due at 09:30 UTC in GMT');
  });

  test('neither wake can force a genuinely future state merely because the cron service started — a weekly state stays future at both wake times', async () => {
    const rows = [row('ORG-1', 'caa', '2026-07-24T08:30:00.000Z')]; // due a week from now
    const wake1 = await runScheduler({ orgIds: ['ORG-1'], dryRun: true, now: '2026-07-17T08:30:00.000Z' }, { client: fakeClient(rows) });
    const wake2 = await runScheduler({ orgIds: ['ORG-1'], dryRun: true, now: '2026-07-17T09:30:00.000Z' }, { client: fakeClient(rows) });
    assert.deepStrictEqual(wake1.cohort, []);
    assert.deepStrictEqual(wake2.cohort, []);
  });
});
