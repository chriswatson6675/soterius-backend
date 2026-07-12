'use strict';

// DNSSEC-QM-v1.0 unit tests (SLG-078 design / SLG-080 calibration).
// Run: node --test backend/observatory/quality/dnssec-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDnssecQuality, QUALITY_VERSION, MODEL_ID } = require('./dnssec-quality');

const f = (o = {}) => ({
  dns_ds_present: false, dns_dnskey_present: false,
  ds_digest_types: [], dnskey_algorithms: [],
  ds_collection_error: null, dnskey_collection_error: null,
  ...o,
});

describe('DNSSEC-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'DNSSEC-QM-v1.0'); });
});

describe('DNSSEC-QM-v1.0 — primary bands', () => {
  it('unsigned (DS=false, DNSKEY=false) → 0', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: false })).score, 0));
  it('island (DS=false, DNSKEY=true) → 40', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true })).score, 40));
  it('anchored (DS=true, DNSKEY=true) → 100', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true })).score, 100));

  it('primaryLabel matches state', () => {
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: false })).primaryLabel, 'UNSIGNED');
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true })).primaryLabel, 'ISLAND');
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true })).primaryLabel, 'ANCHORED');
  });
});

describe('DNSSEC-QM-v1.0 — unknown / not-scored (P1)', () => {
  it('DS unknown → not scored', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: null, ds_collection_error: 'DNS_SERVFAIL' }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'OBSERVATION_INCOMPLETE');
    assert.equal(r.score, null);
  });

  it('DNSKEY unknown → not scored', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: null, dnskey_collection_error: 'DNS_SERVFAIL' }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'OBSERVATION_INCOMPLETE');
    assert.equal(r.score, null);
  });

  it('both unknown → not scored', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: null, dns_dnskey_present: null }));
    assert.equal(r.scored, false);
    assert.equal(r.score, null);
  });

  // The explicit regression case named in the commissioning brief: DS confirmed
  // absent must NEVER be used to infer UNSIGNED when DNSKEY is unobserved — DNSKEY's
  // true value is exactly what distinguishes UNSIGNED (0) from ISLAND (40).
  it('DS=false with DNSKEY unknown is NOT inferred as unsigned', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: null, dnskey_collection_error: 'DNS_SERVFAIL' }));
    assert.equal(r.scored, false);
    assert.notEqual(r.score, 0);
    assert.equal(r.primaryLabel, undefined);
  });

  // The symmetric case: DS confirmed present must NEVER be used to infer ANCHORED
  // when DNSKEY is unobserved (the sidra.org / SLG-077 §2.1 signature).
  it('DS=true with DNSKEY unknown is NOT inferred as anchored', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: null, dnskey_collection_error: 'DNS_SERVFAIL' }));
    assert.equal(r.scored, false);
    assert.notEqual(r.score, 100);
  });

  it('collection error reasons are preserved on the not-scored result', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: null, ds_collection_error: 'DNS_TIMEOUT' }));
    assert.equal(r.dsCollectionError, 'DNS_TIMEOUT');
  });
});

describe('DNSSEC-QM-v1.0 — anomalous state (empirically n=0 nationally)', () => {
  it('DS=true, DNSKEY=false → not scored, distinct reason (never silently folded into another state)', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: false }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'ANOMALOUS_STATE_DS_WITHOUT_DNSKEY');
    assert.equal(r.score, null);
  });
});

describe('DNSSEC-QM-v1.0 — DS-digest-modernity multiplier (calibrated ×0.95)', () => {
  it('SHA-1 DS digest present on anchored → 95', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1] })).score, 95));

  it('SHA-1 alongside a modern digest still triggers the full reduction (no finer split — SLG-080 §3.1)', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1, 2] })).score, 95));

  it('modern digest only (no SHA-1) → 100, no reduction', () =>
    assert.equal(scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [2] })).score, 100));

  it('multiplier never fires outside ANCHORED (structurally impossible — no DS digest without a DS)', () => {
    // Island cannot carry ds_digest_types in practice (no DS), but even if a caller
    // passed one, the multiplier must not apply outside ANCHORED.
    const r = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true, ds_digest_types: [1] }));
    assert.equal(r.score, 40);
    assert.deepEqual(r.applied, []);
  });

  it('applied[] records the multiplier name and factor', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1] }));
    assert.deepEqual(r.applied, [{ name: 'SHA-1 DS digest present', factor: 0.95 }]);
  });
});

describe('DNSSEC-QM-v1.0 — DNSKEY-algorithm-modernity flag (UNCALIBRATED — must never influence score)', () => {
  it('legacy algorithm (5) present on anchored → flagged, score UNCHANGED at 100', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, dnskey_algorithms: [5] }));
    assert.equal(r.score, 100);
    assert.deepEqual(r.flags, ['UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM']);
  });

  it('legacy algorithm (7) present on island → flagged, score UNCHANGED at 40', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true, dnskey_algorithms: [7] }));
    assert.equal(r.score, 40);
    assert.deepEqual(r.flags, ['UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM']);
  });

  it('legacy algorithm (10) present combined with SHA-1 DS → both evaluated independently, only the calibrated one affects score', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1], dnskey_algorithms: [10] }));
    assert.equal(r.score, 95); // SHA-1 multiplier applied
    assert.deepEqual(r.flags, ['UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM']); // algorithm flagged, not applied
  });

  it('modern algorithms (13, 14, 15) are correctly EXCLUDED from the legacy set (SLG-079 correction)', () => {
    const r13 = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, dnskey_algorithms: [13] }));
    const r14 = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, dnskey_algorithms: [14] }));
    const r15 = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, dnskey_algorithms: [15] }));
    assert.deepEqual(r13.flags, []);
    assert.deepEqual(r14.flags, []);
    assert.deepEqual(r15.flags, []);
  });

  it('no legacy algorithm present → flags empty', () => {
    const r = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, dnskey_algorithms: [13] }));
    assert.deepEqual(r.flags, []);
  });
});

describe('DNSSEC-QM-v1.0 — ordinal preservation (structural, not merely observed)', () => {
  it('worst-case anchored (max reduction) still exceeds island by a wide margin', () => {
    const worstAnchored = scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1] })).score;
    const island = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true })).score;
    assert.equal(worstAnchored, 95);
    assert.equal(island, 40);
    assert.ok(worstAnchored > island);
    assert.equal(worstAnchored - island, 55);
  });

  it('island exceeds unsigned', () => {
    const island = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true })).score;
    const unsigned = scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: false })).score;
    assert.ok(island > unsigned);
  });

  it('the four realised values are exactly {0, 40, 95, 100} — no fifth value is producible', () => {
    const values = new Set([
      scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: false })).score,
      scoreDnssecQuality(f({ dns_ds_present: false, dns_dnskey_present: true })).score,
      scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [1] })).score,
      scoreDnssecQuality(f({ dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [2] })).score,
    ]);
    assert.deepEqual([...values].sort((a, b) => a - b), [0, 40, 95, 100]);
  });
});
