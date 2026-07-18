'use strict';

// Integration boundary test for the deterministic fixed-UTC 15-minute shard
// scheduling model (Railway cron */15 * * * * UTC). Supersedes the former
// dual-wake DST integration test — there is no Europe/London anchor and no dual
// wake any more. Proves runScheduler()'s due/future classification (the
// targeted --org path, retained for testing/incident use) behaves correctly
// against shard-computed next_due values, and that behaviour is identical in
// GMT and BST windows (i.e. DST-independent).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScheduler } = require('./run-scheduler');
const { computeNextDueAt } = require('../observation-state/cadence-policy');
const shard = require('../observation-state/shard-assignment');

// Minimal fake client supporting the runScheduler dry-run query shapes.
function fakeClient(rows) {
  return {
    from() {
      let filtered = [...rows];
      let mode = null;
      const b = {
        select() { return b; },
        in(col, vals) { if (mode === null) mode = 'due'; filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
        not(col, op, val) { mode = 'due'; const ex = val.replace(/[()]/g, '').split(','); filtered = filtered.filter((r) => !ex.includes(r.status)); return b; },
        or(expr) { if (mode === 'due') { const iso = expr.split('lte.')[1]; filtered = filtered.filter((r) => r.next_due_at === null || r.next_due_at <= iso); } return b; },
        eq(col, val) { if (col === 'status' && val === 'running') mode = 'stale'; filtered = filtered.filter((r) => r[col] === val); return b; },
        lt(col, val) { filtered = filtered.filter((r) => r[col] < val); return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: filtered, error: null }); },
        then(f) { return Promise.resolve({ data: filtered, error: null }).then(f); },
      };
      return b;
    },
  };
}

function stateRow(org, type, nextDueAt) {
  return { organisation_id: org, observation_type: type, next_due_at: nextDueAt, status: 'observed', updated_at: '2026-01-01T00:00:00.000Z' };
}

const ORG = 'ORG-INTEG-1';

describe('fixed-UTC 15-minute shard scheduling — due/future classification', () => {
  test('a shard state is future before its assigned slot and due at/after it', async () => {
    // Establish the org's next daily slot from a completion instant.
    const nextDue = computeNextDueAt('2026-01-19T00:00:00.000Z', 'spf', ORG);
    const slotMs = Date.parse(nextDue);
    const rows = [stateRow(ORG, 'spf', nextDue)];

    const before = new Date(slotMs - 60000).toISOString();
    const wakeBefore = await runScheduler({ orgIds: [ORG], dryRun: true, now: before }, { client: fakeClient(rows) });
    assert.deepStrictEqual(wakeBefore.cohort, [], 'not due one minute before the slot');

    const wakeAt = await runScheduler({ orgIds: [ORG], dryRun: true, now: nextDue }, { client: fakeClient(rows) });
    const plan = wakeAt.plan.find((p) => p.organisationId === ORG);
    assert.ok(plan && plan.classification.due.includes('spf'), 'due exactly at the slot instant');
  });

  test('DST-independent: identical classification in a GMT (Jan) and a BST (Jul) window', async () => {
    for (const base of ['2026-01-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z']) {
      const nextDue = computeNextDueAt(base, 'dmarc', ORG);
      const rows = [stateRow(ORG, 'dmarc', nextDue)];
      const notYet = await runScheduler({ orgIds: [ORG], dryRun: true, now: new Date(Date.parse(nextDue) - 60000).toISOString() }, { client: fakeClient(rows) });
      assert.deepStrictEqual(notYet.cohort, []);
      const due = await runScheduler({ orgIds: [ORG], dryRun: true, now: nextDue }, { client: fakeClient(rows) });
      assert.ok(due.plan.find((p) => p.organisationId === ORG).classification.due.includes('dmarc'));
    }
  });

  test('the assigned slot lands on a 15-minute UTC boundary (no DST offset)', () => {
    const d = new Date(computeNextDueAt('2026-01-19T00:00:00.000Z', 'spf', ORG));
    assert.equal(d.getUTCSeconds(), 0);
    assert.equal((d.getUTCHours() * 60 + d.getUTCMinutes()) % 15, 0);
    assert.equal(d.getUTCHours() * 4 + d.getUTCMinutes() / 15, shard.dailySlotIndex(ORG));
  });

  // Guard rails transferred from the deleted dual-wake DST test: the negative
  // guarantees remain valuable even though the London/dual-wake product design
  // is superseded.
  test('London-local helpers are absent from the active cadence module', () => {
    const cp = require('../observation-state/cadence-policy');
    assert.equal(cp.next0930LondonAfter, undefined);
    assert.equal(cp.next0930LondonWeeklyAfter, undefined);
    assert.equal(cp.londonWallClockToUtcMs, undefined);
  });
  test('no active observation type maps to a London or 08:30 (superseded) policy', () => {
    const { OBSERVATION_TYPE_CADENCE_POLICY } = require('../observation-state/cadence-policy');
    for (const p of Object.values(OBSERVATION_TYPE_CADENCE_POLICY)) {
      assert.ok(!/london|0830/.test(p), `active policy ${p} must not be a superseded London/08:30 policy`);
    }
  });
  test('a single wake at any 15-minute boundary suffices — no second wake needed for a slot to be due', async () => {
    // A state due at slot S is due at the S wake itself (one wake), never
    // requiring a second offset wake as the dual-wake design did.
    const nextDue = computeNextDueAt('2026-01-19T00:00:00.000Z', 'spf', ORG);
    const rows = [stateRow(ORG, 'spf', nextDue)];
    const at = await runScheduler({ orgIds: [ORG], dryRun: true, now: nextDue }, { client: fakeClient(rows) });
    assert.ok(at.plan.find((p) => p.organisationId === ORG).classification.due.includes('spf'));
  });
});
