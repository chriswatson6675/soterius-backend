'use strict';

// processing-ledger.test.js — persistent exactly-once ledger over the state model.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openLedger } = require('./processing-ledger');
const { STATES } = require('./processing-state');

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ledger-')), 'ledger.ndjson'); }
// deterministic, monotonically-advancing clock
function clock(startMs = 1_700_000_000_000) { let t = startMs; return () => new Date(t += 1000); }

test('openLedger requires a path', () => {
  assert.throws(() => openLedger({}), /requires a path/);
});

test('claim an unseen company → claimed, with created/updated timestamps and unseen→claimed history', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  const r = L.claim('01234567');
  assert.deepStrictEqual({ claimed: r.claimed, state: r.state }, { claimed: true, state: STATES.CLAIMED });
  assert.strictEqual(L.getState('01234567'), STATES.CLAIMED);
  assert.ok(L.has('01234567'));
  const rec = L.getRecord('01234567');
  assert.deepStrictEqual(rec.events.map((e) => e.state), [STATES.UNSEEN, STATES.CLAIMED]);
  assert.ok(rec.createdAt && rec.updatedAt && rec.createdAt <= rec.updatedAt);
});

test('duplicate claim is rejected (exactly-once) and appends no history', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('A');
  const before = L.history('A').length;
  const r = L.claim('A');
  assert.deepStrictEqual(r, { claimed: false, state: STATES.CLAIMED, reason: 'already-claimed' });
  assert.strictEqual(L.history('A').length, before, 'no extra event written');
});

test('happy-path progression via update, validated by the state model', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('B');
  assert.strictEqual(L.update('B', STATES.MATCHED), STATES.MATCHED);
  assert.strictEqual(L.update('B', STATES.ENRICHED), STATES.ENRICHED);
  assert.strictEqual(L.update('B', STATES.PERSISTED), STATES.PERSISTED);
  assert.strictEqual(L.update('B', STATES.COMPLETE), STATES.COMPLETE);
  assert.strictEqual(L.getState('B'), STATES.COMPLETE);
  assert.deepStrictEqual(L.history('B').map((e) => e.state),
    [STATES.UNSEEN, STATES.CLAIMED, STATES.MATCHED, STATES.ENRICHED, STATES.PERSISTED, STATES.COMPLETE]);
});

test('illegal transitions are rejected (delegated to processing-state)', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('C');
  assert.throws(() => L.update('C', STATES.COMPLETE), /invalid transition/);   // claimed → complete
  assert.throws(() => L.update('C', 'banana'), /unknown to state/);
  assert.strictEqual(L.getState('C'), STATES.CLAIMED, 'state unchanged after rejected update');
});

test('update on an unrecorded company throws', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  assert.throws(() => L.update('NOPE', STATES.CLAIMED), /unknown company/);
});

test('a completed (terminal) company is never re-claimed', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('D'); L.update('D', STATES.NO_MATCH);   // terminal
  assert.strictEqual(L.claim('D').claimed, false);
  assert.throws(() => L.update('D', STATES.CLAIMED), /invalid transition/);
});

test('failed company can be re-claimed (retry permitted by the state model)', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('E'); L.update('E', STATES.FAILED);
  const r = L.claim('E');
  assert.strictEqual(r.claimed, true);
  assert.deepStrictEqual(L.history('E').map((x) => x.state), [STATES.UNSEEN, STATES.CLAIMED, STATES.FAILED, STATES.CLAIMED]);
});

test('persistence + resumability: a reopened ledger preserves state and still prevents re-claim', () => {
  const file = tmpFile();
  const A = openLedger({ path: file, now: clock() });
  A.claim('F'); A.update('F', STATES.MATCHED);

  const B = openLedger({ path: file, now: clock() });   // models a restart
  assert.strictEqual(B.getState('F'), STATES.MATCHED);
  assert.strictEqual(B.claim('F').claimed, false, 'claim does not survive as re-claimable across restart');
  assert.strictEqual(B.update('F', STATES.ENRICHED), STATES.ENRICHED, 'progression continues after restart');
});

test('companies are independent; size and listing reflect all recorded', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('G'); L.claim('H'); L.update('G', STATES.NO_MATCH);
  assert.strictEqual(L.getState('G'), STATES.NO_MATCH);
  assert.strictEqual(L.getState('H'), STATES.CLAIMED);
  assert.strictEqual(L.size(), 2);
  assert.deepStrictEqual(L.companyNumbers().sort(), ['G', 'H']);
});

test('returned records/history are copies (mutation-safe); state-key coercion to string', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim(778899);                                   // numeric key
  assert.strictEqual(L.getState('778899'), STATES.CLAIMED);
  const h = L.history('778899'); h.push({ state: 'x', at: 'y' });
  assert.strictEqual(L.history('778899').length, 2, 'mutating returned history does not affect the ledger');
});

test('timestamps advance on update', () => {
  const L = openLedger({ path: tmpFile(), now: clock() });
  L.claim('I');
  const t1 = L.getRecord('I').updatedAt;
  L.update('I', STATES.MATCHED);
  const t2 = L.getRecord('I').updatedAt;
  assert.ok(t2 > t1, 'updatedAt advanced');
  assert.strictEqual(L.getRecord('I').createdAt, L.history('I')[0].at, 'createdAt is the first event');
});
