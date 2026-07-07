'use strict';

// DKIM-QM-v1.0 unit tests (SLG-054 frozen model).
// Run: node --test backend/observatory/quality/dkim-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDkimQuality, QUALITY_VERSION, MODEL_ID } = require('./dkim-quality');

const key = (o = {}) => ({ parse_success: true, public_key_present: true, key_bits: 2048, key_type: 'rsa', flags: null, ...o });

describe('DKIM-QM-v1.0 — version', () => {
  it('is frozen v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'DKIM-QM-v1.0'); });
});

describe('DKIM-QM-v1.0 — primary bands', () => {
  it('>=2048-bit usable key scores 100', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 2048 })] });
    assert.equal(r.score, 100); assert.equal(r.primary, 100);
  });
  it('4096-bit is treated as >=2048 (100)', () => {
    assert.equal(scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 4096 })] }).score, 100);
  });
  it('1024-bit usable key scores 85', () => {
    assert.equal(scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 1024 })] }).score, 85);
  });
  it('<1024-bit usable key scores 40', () => {
    assert.equal(scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 768 })] }).score, 40);
  });
  it('strongest usable key sets the primary (mixed 1024+2048 -> 100)', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 1024 }), key({ key_bits: 2048 })] });
    assert.equal(r.primary, 100); assert.equal(r.score, 100); // 1024 alongside 2048 is NOT penalised (>=floor)
  });
});

describe('DKIM-QM-v1.0 — floor & not-scored', () => {
  it('NOT_DETECTED (no keys) scores 0 (bounded floor)', () => {
    assert.equal(scoreDkimQuality({ dkim_present: null, dkim_collection_status: 'NOT_DETECTED', dkim_keys: [] }).score, 0);
  });
  it('present but all keys unparseable (catch-all) scores 0', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ parse_success: false, key_bits: null })] });
    assert.equal(r.score, 0);
  });
  it('present but only revoked keys scores 0', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ public_key_present: false, key_bits: null })] });
    assert.equal(r.score, 0);
  });
  it('DNS_FAILURE is NOT scored', () => {
    const r = scoreDkimQuality({ dkim_present: null, dkim_collection_status: 'DNS_FAILURE', dkim_keys: [] });
    assert.equal(r.scored, false); assert.equal(r.score, null); assert.equal(r.reason, 'OBSERVATION_INCOMPLETE');
  });
});

describe('DKIM-QM-v1.0 — secondary multipliers (reduce-only)', () => {
  it('M1 malformed present: 2048 -> 95', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 2048 }), key({ parse_success: false, key_bits: null })] });
    assert.equal(r.score, 95);
  });
  it('M2 live sub-1024 residual: 2048 -> 80', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 2048 }), key({ key_bits: 768 })] });
    assert.equal(r.score, 80);
  });
  it('M3 strongest key testing (t=y): 2048 -> 90', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 2048, flags: ['y'] })] });
    assert.equal(r.score, 90);
  });
  it('multipliers compound and never increase (M1×M2 on 2048 -> 76)', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [
      key({ key_bits: 2048 }), key({ key_bits: 512 }), key({ parse_success: false, key_bits: null }),
    ] });
    assert.equal(r.score, 76); // 100 × 0.95 × 0.80
  });
  it('a testing flag on a NON-strongest key does not fire M3', () => {
    const r = scoreDkimQuality({ dkim_present: true, dkim_keys: [key({ key_bits: 2048 }), key({ key_bits: 1024, flags: ['y'] })] });
    assert.equal(r.score, 100);
  });
});
