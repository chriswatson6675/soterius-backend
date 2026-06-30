'use strict';

// authorised-status-gate.test.js — pure FCA status classification (all PoC-observed statuses).

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyStatus, normaliseStatus, isRecognised, DECISION } = require('./authorised-status-gate');

test('normaliseStatus: lowercase, collapse whitespace, trim', () => {
  assert.strictEqual(normaliseStatus('  Authorised '), 'authorised');
  assert.strictEqual(normaliseStatus('No Longer Registered as a PSD Agent'), 'no longer registered as a psd agent');
  assert.strictEqual(normaliseStatus(null), '');
  assert.strictEqual(normaliseStatus(undefined), '');
});

test('Authorised → retain (the target population)', () => {
  const r = classifyStatus('Authorised');
  assert.strictEqual(r.decision, DECISION.RETAIN);
  assert.strictEqual(r.recognised, true);
  assert.strictEqual(classifyStatus('AUTHORISED').decision, DECISION.RETAIN, 'case-insensitive');
  assert.strictEqual(classifyStatus(' authorised ').decision, DECISION.RETAIN);
});

test('all other PoC-observed statuses → discard (recognised)', () => {
  for (const s of [
    'Appointed representative',
    'Registered',
    'No longer authorised',
    'No longer registered as an Appointed Representative',
    'No Longer Registered as a PSD Agent',
    'No longer regulated',
    'Revoked',
    'Cancelled',
  ]) {
    const r = classifyStatus(s);
    assert.strictEqual(r.decision, DECISION.DISCARD, `${s} → discard`);
    assert.strictEqual(r.recognised, true, `${s} should be recognised`);
  }
});

test('unrecognised / empty status → discard, recognised:false (observable, not silent)', () => {
  const u = classifyStatus('Some Brand New Status');
  assert.strictEqual(u.decision, DECISION.DISCARD);
  assert.strictEqual(u.recognised, false);

  const e = classifyStatus('');
  assert.strictEqual(e.decision, DECISION.DISCARD);
  assert.strictEqual(e.recognised, false);

  const n = classifyStatus(null);
  assert.strictEqual(n.decision, DECISION.DISCARD);
  assert.strictEqual(n.recognised, false);
});

test('research config routes a discardable status to research (the retained-for-research exception)', () => {
  assert.strictEqual(classifyStatus('Registered', { research: ['Registered'] }).decision, DECISION.RESEARCH);
  assert.strictEqual(classifyStatus('Appointed representative', { research: ['appointed representative'] }).decision, DECISION.RESEARCH, 'config is case-insensitive');
  // a status NOT in the research list is still discarded
  assert.strictEqual(classifyStatus('Revoked', { research: ['Registered'] }).decision, DECISION.DISCARD);
});

test('retain always wins over research config (research is an exception to discard, not to authorisation)', () => {
  assert.strictEqual(classifyStatus('Authorised', { research: ['Authorised'] }).decision, DECISION.RETAIN);
});

test('the verbatim status is preserved on the result (observable fact)', () => {
  const r = classifyStatus('No Longer Registered as a PSD Agent');
  assert.strictEqual(r.status, 'No Longer Registered as a PSD Agent');
  assert.strictEqual(r.normalised, 'no longer registered as a psd agent');
});

test('isRecognised: "No longer …" family and known sets recognised; junk not', () => {
  assert.ok(isRecognised('no longer registered as an emd agent'));
  assert.ok(isRecognised('authorised'));
  assert.ok(isRecognised('revoked'));
  assert.ok(!isRecognised('totally unknown'));
  assert.ok(!isRecognised(''));
});

test('deterministic: same input → same output', () => {
  const a = classifyStatus('Appointed representative', { research: ['Registered'] });
  const b = classifyStatus('Appointed representative', { research: ['Registered'] });
  assert.deepStrictEqual(a, b);
});
