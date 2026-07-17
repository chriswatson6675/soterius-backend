'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findDueCandidates, groupByOrganisation, groupDueTypesByOrganisation, classifyOrganisationDnsStates } = require('./due-selection');

// Minimal fake client distinguishing the two queries findDueCandidates issues
// by which terminal filter each one uses (.or(next_due_at...) vs
// .eq('status','running').lt('updated_at', ...)).
function fakeClient(rows) {
  return {
    from(table) {
      if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
      let filtered = rows;
      let mode = null; // 'due' | 'stale'
      const builder = {
        select() { return builder; },
        in() { return builder; },
        not() { mode = 'due'; return builder; },
        or(expr) {
          if (mode === 'due') {
            const nowIso = expr.split('lte.')[1];
            filtered = filtered.filter((r) => r.next_due_at === null || r.next_due_at <= nowIso);
          }
          return builder;
        },
        eq(col, val) { if (col === 'status' && val === 'running') mode = 'stale'; return builder; },
        lt(col, val) { if (mode === 'stale') filtered = filtered.filter((r) => r.status === 'running' && r.updated_at < val); return builder; },
        order() { return builder; },
        limit() {
          if (mode === 'due') filtered = filtered.filter((r) => r.status !== 'suspended' && r.status !== 'running');
          return Promise.resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

function row(organisationId, observationType, { nextDueAt = null, status = 'observed', updatedAt = '2026-07-16T00:00:00.000Z' } = {}) {
  return { organisation_id: organisationId, observation_type: observationType, next_due_at: nextDueAt, status, updated_at: updatedAt };
}

describe('findDueCandidates', () => {
  test('a due state (next_due_at in the past) is selected', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: '2026-07-15T00:00:00.000Z' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:00:00.000Z' }, { client: fakeClient(rows) });
    assert.equal(result.length, 1);
    assert.equal(result[0].organisationId, 'ORG-1');
  });

  test('a never-yet-observed state (next_due_at null) is selected', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: null, status: 'never_observed' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:00:00.000Z' }, { client: fakeClient(rows) });
    assert.equal(result.length, 1);
  });

  test('a future state is not selected', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: '2026-07-20T00:00:00.000Z' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:00:00.000Z' }, { client: fakeClient(rows) });
    assert.equal(result.length, 0);
  });

  test('a suspended state is not selected', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: '2026-07-15T00:00:00.000Z', status: 'suspended' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:00:00.000Z' }, { client: fakeClient(rows) });
    assert.equal(result.length, 0);
  });

  test('a currently-running (claimed) state within its lease is not selected', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: '2026-07-15T00:00:00.000Z', status: 'running', updatedAt: '2026-07-16T00:00:00.000Z' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:05:00.000Z', leaseMs: 900000 }, { client: fakeClient(rows) });
    assert.equal(result.length, 0);
  });

  test('a stale running state (past the lease) IS selected — crash recovery', async () => {
    const rows = [row('ORG-1', 'spf', { nextDueAt: '2026-07-15T00:00:00.000Z', status: 'running', updatedAt: '2026-07-16T00:00:00.000Z' })];
    const result = await findDueCandidates({ now: '2026-07-16T00:30:00.000Z', leaseMs: 900000 }, { client: fakeClient(rows) });
    assert.equal(result.length, 1);
  });
});

describe('groupByOrganisation', () => {
  test('deduplicates while preserving first-seen order', () => {
    const candidates = [
      { organisationId: 'ORG-2', observationType: 'spf' },
      { organisationId: 'ORG-1', observationType: 'spf' },
      { organisationId: 'ORG-2', observationType: 'dkim' },
      { organisationId: 'ORG-3', observationType: 'spf' },
    ];
    assert.deepStrictEqual(groupByOrganisation(candidates), ['ORG-2', 'ORG-1', 'ORG-3']);
  });

  test('an empty candidate list produces an empty result', () => {
    assert.deepStrictEqual(groupByOrganisation([]), []);
  });
});

describe('groupDueTypesByOrganisation', () => {
  test('preserves exactly which types are due per organisation (cadence-safety fix)', () => {
    const candidates = [
      { organisationId: 'ORG-1', observationType: 'spf' },
      { organisationId: 'ORG-1', observationType: 'dkim' },
      { organisationId: 'ORG-2', observationType: 'dnssec' },
    ];
    const result = groupDueTypesByOrganisation(candidates);
    assert.deepStrictEqual(result, [
      { organisationId: 'ORG-1', dueTypes: ['spf', 'dkim'] },
      { organisationId: 'ORG-2', dueTypes: ['dnssec'] },
    ]);
  });

  test('an organisation with only DNSSEC due reports only DNSSEC, not the other four', () => {
    const candidates = [{ organisationId: 'ORG-1', observationType: 'dnssec' }];
    assert.deepStrictEqual(groupDueTypesByOrganisation(candidates), [{ organisationId: 'ORG-1', dueTypes: ['dnssec'] }]);
  });

  test('an organisation with only CAA due reports only CAA', () => {
    const candidates = [{ organisationId: 'ORG-1', observationType: 'caa' }];
    assert.deepStrictEqual(groupDueTypesByOrganisation(candidates), [{ organisationId: 'ORG-1', dueTypes: ['caa'] }]);
  });

  test('all five due for one organisation reports all five', () => {
    const candidates = ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'].map((observationType) => ({ organisationId: 'ORG-1', observationType }));
    assert.deepStrictEqual(groupDueTypesByOrganisation(candidates), [{ organisationId: 'ORG-1', dueTypes: ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'] }]);
  });

  test('an empty candidate list produces an empty result', () => {
    assert.deepStrictEqual(groupDueTypesByOrganisation([]), []);
  });
});

describe('classifyOrganisationDnsStates', () => {
  function fakeStoreClient(rows) {
    return {
      from(table) {
        if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
        let filtered = rows;
        const builder = {
          select() { return builder; },
          eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
          in(col, vals) { filtered = filtered.filter((r) => vals.includes(r[col])); return builder; },
          then(onFulfilled) { return Promise.resolve({ data: filtered, error: null }).then(onFulfilled); },
        };
        return builder;
      },
    };
  }
  function osRow(observationType, status) {
    return { organisation_id: 'ORG-1', observation_type: observationType, collection_group: 'dns_batch', status, attempt_count: 0 };
  }

  test('classifies due, future, and suspended types independently', async () => {
    const client = fakeStoreClient([
      osRow('spf', 'observed'), osRow('dkim', 'observed'), osRow('dmarc', 'observed'),
      osRow('dnssec', 'observed'), osRow('caa', 'suspended'),
    ]);
    const result = await classifyOrganisationDnsStates('ORG-1', ['spf', 'dkim'], { client });
    assert.deepStrictEqual(result.due.sort(), ['dkim', 'spf']);
    assert.deepStrictEqual(result.future.sort(), ['dmarc', 'dnssec']);
    assert.deepStrictEqual(result.suspended, ['caa']);
  });

  test('a suspended type is never classified as due even if named in dueTypes', async () => {
    const client = fakeStoreClient([osRow('spf', 'suspended')]);
    const result = await classifyOrganisationDnsStates('ORG-1', ['spf'], { client });
    assert.deepStrictEqual(result.due, []);
    assert.deepStrictEqual(result.suspended, ['spf']);
  });

  test('no existing rows classifies as entirely empty', async () => {
    const client = fakeStoreClient([]);
    const result = await classifyOrganisationDnsStates('ORG-1', [], { client });
    assert.deepStrictEqual(result, { due: [], future: [], suspended: [] });
  });
});
