'use strict';

// normalise.test.js — unit tests for the ISO 17442 LEI normaliser (ENG-031)
// and the GCN-004 register-identifier placeholder normaliser (ENG-030's
// Repository Authority integration package). Both are now called from
// build.js's merge/union-find pipeline; build.js itself is a top-level
// script with real filesystem side effects (per identity.test.js's own
// comment on why it isn't required directly by a test) — the merge
// pipeline's use of these normalisers is instead verified by re-running the
// ENG-031 migration assessment against the real dataset. This file proves
// each normaliser function's own behaviour in isolation.

const { test } = require('node:test');
const assert = require('node:assert');

const { normaliseLei, normaliseRegisterId } = require('./normalise');

test('normaliseLei accepts a real, valid LEI (ABN AMRO Bank NV)', () => {
  assert.strictEqual(normaliseLei('BFXS5XCH7N0Y05NIXW11'), 'BFXS5XCH7N0Y05NIXW11');
});

test('normaliseLei accepts a real, valid LEI (Adyen N.V.)', () => {
  assert.strictEqual(normaliseLei('724500973ODKK3IFQ447'), '724500973ODKK3IFQ447');
});

test('normaliseLei uppercases and strips surrounding whitespace', () => {
  assert.strictEqual(normaliseLei('  bfxs5xch7n0y05nixw11  '), 'BFXS5XCH7N0Y05NIXW11');
});

test('normaliseLei rejects the ENG-031 artifact: a CSV embedded-header value, not a real LEI', () => {
  assert.strictEqual(normaliseLei('Head Office LEI'), null);
});

test('normaliseLei rejects a string that is the right length but fails the check-digit test', () => {
  // Flip the last character of a real, valid LEI.
  const tampered = 'BFXS5XCH7N0Y05NIXW12';
  assert.strictEqual(normaliseLei(tampered), null);
});

test('normaliseLei rejects strings shorter or longer than 20 characters', () => {
  assert.strictEqual(normaliseLei('BFXS5XCH7N0Y05NIXW1'), null); // 19 chars
  assert.strictEqual(normaliseLei('BFXS5XCH7N0Y05NIXW111'), null); // 21 chars
});

test('normaliseLei rejects non-alphanumeric characters', () => {
  assert.strictEqual(normaliseLei('BFXS-5XCH7N0Y05NIXW11'), null);
});

test('normaliseLei rejects null/undefined/empty', () => {
  assert.strictEqual(normaliseLei(null), null);
  assert.strictEqual(normaliseLei(undefined), null);
  assert.strictEqual(normaliseLei(''), null);
  assert.strictEqual(normaliseLei('   '), null);
});

test('normaliseLei does not enforce a "characters 5-6 are always 00" rule (verified false for real LEIs)', () => {
  // Position 5-6 (1-indexed) of 'BFXS5XCH7N0Y05NIXW11' is '5X', not '00' —
  // and it is still a real, valid, GLEIF-issued LEI.
  const lei = 'BFXS5XCH7N0Y05NIXW11';
  assert.notStrictEqual(lei.slice(4, 6), '00');
  assert.strictEqual(normaliseLei(lei), lei);
});

// --- normaliseRegisterId (frcAudit / hmrcAml / pbsFirm placeholder) ---------

test('normaliseRegisterId uppercases and strips whitespace', () => {
  assert.strictEqual(normaliseRegisterId('  c001234  '), 'C001234');
  assert.strictEqual(normaliseRegisterId('12137104'), '12137104');
});

test('normaliseRegisterId returns null for null/undefined/empty', () => {
  assert.strictEqual(normaliseRegisterId(null), null);
  assert.strictEqual(normaliseRegisterId(undefined), null);
  assert.strictEqual(normaliseRegisterId(''), null);
  assert.strictEqual(normaliseRegisterId('   '), null);
});

test('normaliseRegisterId performs no format validation (placeholder, per GCN-004 §E.1)', () => {
  // Deliberately permissive — the real per-register convention is not yet
  // decided (ENG-030 §4 open decision #1), so this must not reject a value
  // just because it looks unfamiliar.
  assert.strictEqual(normaliseRegisterId('anything-at-all_123'), 'ANYTHING-AT-ALL_123');
});
