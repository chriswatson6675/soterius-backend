'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('./subject-registry');

test('exactly the three admitted constitutional subjects', () => {
  assert.deepStrictEqual([...R.SUBJECT_TYPES].sort(), ['Observation', 'RepositoryChange', 'RepositoryDecision']);
});

test('isValidSubjectType — admits the three, rejects others', () => {
  assert.ok(R.isValidSubjectType('Observation'));
  assert.ok(R.isValidSubjectType('RepositoryDecision'));
  assert.ok(R.isValidSubjectType('RepositoryChange'));
  assert.ok(!R.isValidSubjectType('ObservationSession'));
  assert.ok(!R.isValidSubjectType('Nonsense'));
});

test('ObservationSession is rejected WITH a constitutional reason (P-10 layer-mix)', () => {
  assert.ok(!R.isValidSubjectType('ObservationSession'));
  const reason = R.rejectionReason('ObservationSession');
  assert.match(reason, /operational execution mechanism/);
  assert.match(reason, /P-10/);
  assert.throws(() => R.assertValidSubjectType('ObservationSession'), /not admitted/);
});

test('assertValidSubjectType — unknown type names the admitted set', () => {
  assert.throws(() => R.assertValidSubjectType('Widget'), /admitted: Observation, RepositoryDecision, RepositoryChange/);
});

test('readSubject — Observation resolves via an injected resolver', async () => {
  const out = await R.readSubject('Observation', 'obs-1', {
    resolveObservation: async (id) => ({ id, fact: 'dmarc=reject' }),
  });
  assert.strictEqual(out.resolved, true);
  assert.deepStrictEqual(out.subject, { id: 'obs-1', fact: 'dmarc=reject' });
});

test('readSubject — without a resolver, returns an honest reference (Unknown != Absent)', async () => {
  const out = await R.readSubject('Observation', 'obs-1', {});
  assert.strictEqual(out.resolved, false);
  assert.match(out.reason, /resolver not provided/);
  assert.strictEqual(out.subjectId, 'obs-1');
});

test('readSubject — RepositoryChange/Decision report their store as pending, not fabricated', async () => {
  const change = await R.readSubject('RepositoryChange', 'ra-v42', {});
  assert.strictEqual(change.resolved, false);
  assert.match(change.reason, /not yet materialised/);
  const decision = await R.readSubject('RepositoryDecision', 'approval-7', {});
  assert.strictEqual(decision.resolved, false);
});

test('readSubject — dispatch on an unadmitted subject throws (single governed gate)', async () => {
  await assert.rejects(() => R.readSubject('ObservationSession', 'x', {}), /not admitted/);
});
