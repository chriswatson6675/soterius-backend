'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./test-helpers/fake-supabase');
const ledger = require('./progress-ledger');

const RUN = 'run-1';

describe('initItems — idempotent per-organisation ledger', () => {
  test('creates one PENDING item per domain', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a.com', 'b.com', 'c.com'], db);
    const items = await ledger.listItems(RUN, db);
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.status === 'PENDING' && i.attempts === 0));
  });

  test('re-initialising a resumed run does not duplicate or reset items', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a.com', 'b.com'], db);
    await ledger.markCompleted(RUN, 'a.com', { observationId: 'obs-1', attempts: 1 }, db);
    // resume: init again with the same + one new domain
    await ledger.initItems(RUN, ['a.com', 'b.com', 'c.com'], db);
    const items = await ledger.listItems(RUN, db);
    assert.equal(items.length, 3);              // no duplicate a.com/b.com
    const a = items.find((i) => i.domain === 'a.com');
    assert.equal(a.status, 'COMPLETED');        // progress preserved, not reset
    assert.equal(a.observation_id, 'obs-1');
  });

  test('de-duplicates domains within a single init', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a.com', 'a.com', 'b.com'], db);
    const items = await ledger.listItems(RUN, db);
    assert.equal(items.length, 2);
  });
});

describe('outstandingDomains — the resume work-list', () => {
  test('excludes COMPLETED and PERMANENT, includes PENDING/RUNNING/FAILED', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['done.com', 'pending.com', 'failed.com', 'dead.com', 'inflight.com'], db);
    await ledger.markCompleted(RUN, 'done.com', { observationId: 'o1' }, db);
    await ledger.markFailed(RUN, 'failed.com', { failureClass: 'RETRYABLE', error: 'timeout' }, db);
    await ledger.markFailed(RUN, 'dead.com', { failureClass: 'PERMANENT', error: 'NXDOMAIN', permanent: true }, db);
    await ledger.markRunning(RUN, 'inflight.com', 1, db);

    const outstanding = (await ledger.outstandingDomains(RUN, db)).sort();
    assert.deepEqual(outstanding, ['failed.com', 'inflight.com', 'pending.com']);
  });
});

describe('counts — drives the completion summary', () => {
  test('tallies statuses and failure classes', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a', 'b', 'c', 'd', 'e'], db);
    await ledger.markCompleted(RUN, 'a', { observationId: 'o1' }, db);
    await ledger.markCompleted(RUN, 'b', { observationId: 'o2' }, db);
    await ledger.markFailed(RUN, 'c', { failureClass: 'PERMANENT', permanent: true }, db);
    await ledger.markFailed(RUN, 'd', { failureClass: 'PERMANENT', permanent: true }, db);
    await ledger.markFailed(RUN, 'e', { failureClass: 'RETRYABLE' }, db);

    const c = await ledger.counts(RUN, db);
    assert.equal(c.total, 5);
    assert.equal(c.completed, 2);
    assert.equal(c.permanent, 2);
    assert.equal(c.failed, 1);
    assert.equal(c.failedTotal, 3);
    assert.deepEqual(c.byFailureClass, { PERMANENT: 2, RETRYABLE: 1 });
  });
});

describe('markCompleted / markFailed persist retry metadata without evidence', () => {
  test('records observation pointer + attempt count on completion', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a'], db);
    await ledger.markRunning(RUN, 'a', 1, db);
    await ledger.markCompleted(RUN, 'a', { observationId: 'obs-xyz', attempts: 2 }, db);
    const [item] = db._rows('collection_run_items');
    assert.equal(item.status, 'COMPLETED');
    assert.equal(item.observation_id, 'obs-xyz');
    assert.equal(item.attempts, 2);
  });

  test('records failure class + truncated error on failure', async () => {
    const db = createFakeSupabase();
    await ledger.initItems(RUN, ['a'], db);
    await ledger.markFailed(RUN, 'a', { failureClass: 'RETRYABLE', error: 'x'.repeat(1000), attempts: 3 }, db);
    const [item] = db._rows('collection_run_items');
    assert.equal(item.status, 'FAILED');
    assert.equal(item.last_failure_class, 'RETRYABLE');
    assert.equal(item.last_error.length, 500);
    assert.equal(item.attempts, 3);
  });
});
