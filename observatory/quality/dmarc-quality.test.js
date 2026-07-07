'use strict';

// DMARC-QM-v1.0 unit tests (SLG-059 design / SLG-060 calibration).
// Run: node --test backend/observatory/quality/dmarc-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDmarcQuality, QUALITY_VERSION, MODEL_ID } = require('./dmarc-quality');

const f = (o = {}) => ({
  dmarc_present: true, dmarc_collection_error: null, dmarc_multiple_records: false,
  dmarc_policy: 'reject', dmarc_subdomain_policy: null, dmarc_pct: null, dmarc_parse_success: true, ...o,
});

describe('DMARC-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'DMARC-QM-v1.0'); });
});

describe('DMARC-QM-v1.0 — primary bands', () => {
  it('p=reject → 100', () => assert.equal(scoreDmarcQuality(f({ dmarc_policy: 'reject' })).score, 100));
  it('p=quarantine → 75', () => assert.equal(scoreDmarcQuality(f({ dmarc_policy: 'quarantine' })).score, 75));
  it('p=none → 40', () => assert.equal(scoreDmarcQuality(f({ dmarc_policy: 'none' })).score, 40));
});

describe('DMARC-QM-v1.0 — floor & not-scored', () => {
  it('confirmed absent → 0', () => assert.equal(scoreDmarcQuality(f({ dmarc_present: false, dmarc_policy: null })).score, 0));
  it('multiple records → 0 (RFC §6.6.3)', () => assert.equal(scoreDmarcQuality(f({ dmarc_multiple_records: true })).score, 0));
  it('no valid p → 0', () => assert.equal(scoreDmarcQuality(f({ dmarc_policy: null })).score, 0));
  it('DNS failure → not scored', () => {
    const r = scoreDmarcQuality(f({ dmarc_present: null, dmarc_collection_error: 'DNS_SERVFAIL' }));
    assert.equal(r.scored, false); assert.equal(r.score, null);
  });
});

describe('DMARC-QM-v1.0 — reduce-only multipliers', () => {
  it('M1 pct<100 on reject → 90', () => assert.equal(scoreDmarcQuality(f({ dmarc_pct: 50 })).score, 90));
  it('M2 sp weaker than p (reject/none) → 90', () => assert.equal(scoreDmarcQuality(f({ dmarc_subdomain_policy: 'none' })).score, 90));
  it('M3 malformed with valid p on reject → 95', () => assert.equal(scoreDmarcQuality(f({ dmarc_parse_success: false })).score, 95));
  it('M2 cannot fire on p=none (sp not weaker than none) → 40', () =>
    assert.equal(scoreDmarcQuality(f({ dmarc_policy: 'none', dmarc_subdomain_policy: 'none' })).score, 40));
  it('sp stronger than p does not increase (reject/reject) → 100', () =>
    assert.equal(scoreDmarcQuality(f({ dmarc_subdomain_policy: 'reject' })).score, 100));
  it('pct=100 is no reduction → 100', () => assert.equal(scoreDmarcQuality(f({ dmarc_pct: 100 })).score, 100));
  it('compounding M1×M2 on quarantine → 60.75', () =>
    assert.equal(scoreDmarcQuality(f({ dmarc_policy: 'quarantine', dmarc_pct: 10, dmarc_subdomain_policy: 'none' })).score, 60.75));
  it('ordinal preserved: worst reject (all 3) 76.95 > clean quarantine 75', () => {
    const worstReject = scoreDmarcQuality(f({ dmarc_policy: 'reject', dmarc_pct: 10, dmarc_subdomain_policy: 'none', dmarc_parse_success: false })).score;
    const cleanQuar = scoreDmarcQuality(f({ dmarc_policy: 'quarantine' })).score;
    assert.equal(worstReject, 76.95); assert.ok(worstReject > cleanQuar);
  });
});
