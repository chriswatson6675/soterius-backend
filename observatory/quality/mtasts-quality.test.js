'use strict';

// MTASTS-QM-v1.0 unit tests (SLG-086 design / SLG-087 calibration).
// Run: node --test backend/observatory/quality/mtasts-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreMtaStsQuality, QUALITY_VERSION, MODEL_ID } = require('./mtasts-quality');

const f = (o = {}) => ({
  dns_sts_present: false, policy_present: null, policy_parse_success: null,
  policy_mode: null, policy_max_age: null, policy_tls_valid: null,
  policy_redirect_count: 0, dns_multiple_sts_records: false, policy_unknown_fields: {},
  ...o,
});

describe('MTASTS-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'MTASTS-QM-v1.0'); });
});

describe('MTASTS-QM-v1.0 — primary bands', () => {
  it('ABSENT (dns_sts_present=false) → 0, regardless of any stray policy fields', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: false, policy_present: true, policy_parse_success: true, policy_mode: 'enforce' }));
    assert.equal(r.scored, true);
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'ABSENT');
  });

  it('PUBLISHED_UNUSABLE — fetch failed (policy_present=false) → 0', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: false }));
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'PUBLISHED_UNUSABLE');
  });

  it('PUBLISHED_UNUSABLE — parse failed (policy_present=true, parse_success=false) → 0', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: false }));
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'PUBLISHED_UNUSABLE');
  });

  it('NONE → 15', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'none' }));
    assert.equal(r.score, 15);
    assert.equal(r.primaryLabel, 'NONE');
  });

  it('TESTING → 25', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'testing' }));
    assert.equal(r.score, 25);
    assert.equal(r.primaryLabel, 'TESTING');
  });

  it('ENFORCE, clean → 100', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800,
    }));
    assert.equal(r.score, 100);
    assert.equal(r.primaryLabel, 'ENFORCE');
    assert.deepEqual(r.applied, []);
  });
});

describe('MTASTS-QM-v1.0 — unknown / not-scored (P1)', () => {
  it('dns_sts_present unknown → not scored, no primaryLabel', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'DNS_UNOBSERVED');
    assert.equal(r.score, null);
    assert.equal(r.primaryLabel, null);
  });

  it('DNS present but policy outcome undetermined → not scored, NOT defaulted to PUBLISHED_UNUSABLE', () => {
    const r = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'POLICY_UNOBSERVED');
    assert.notEqual(r.score, 0);
    assert.equal(r.primaryLabel, null);
  });
});

describe('MTASTS-QM-v1.0 — joint DNS-gating (SLG-086 §2, L-1 discoverability exclusion)', () => {
  it('a fetchable, valid enforce policy with NO DNS record still scores ABSENT (0), not 100', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: false, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 31557600,
    }));
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'ABSENT');
  });
});

describe('MTASTS-QM-v1.0 — short-cache-lifetime multiplier (calibrated ×0.95, ENFORCE only)', () => {
  it('max_age below 1 week on ENFORCE → 95', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 300,
    }));
    assert.equal(r.score, 95);
    assert.deepEqual(r.applied, [{ name: 'Short cache lifetime (<1 week)', factor: 0.95 }]);
  });

  it('max_age at exactly 1 week → no reduction (boundary is exclusive)', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800,
    }));
    assert.equal(r.score, 100);
  });

  it('the multiplier does NOT apply to TESTING even with a short max_age — confined to ENFORCE (SLG-086 §4)', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'testing', policy_max_age: 300,
    }));
    assert.equal(r.score, 25);
    assert.deepEqual(r.applied, []);
  });

  it('the multiplier does NOT apply to NONE even with a short max_age', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'none', policy_max_age: 300,
    }));
    assert.equal(r.score, 15);
    assert.deepEqual(r.applied, []);
  });
});

describe('MTASTS-QM-v1.0 — uncalibrated flags (computed, never applied to score)', () => {
  it('TLS-invalid own endpoint on ENFORCE is flagged but score unaffected', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800, policy_tls_valid: false,
    }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('UNCALIBRATED_TLS_INVALID_OWN_ENDPOINT'));
  });

  it('redirect-based retrieval on ENFORCE is flagged but score unaffected', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800, policy_redirect_count: 2,
    }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('UNCALIBRATED_REDIRECT_BASED_RETRIEVAL'));
  });

  it('multiple DNS records on ENFORCE is flagged but score unaffected', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800, dns_multiple_sts_records: true,
    }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('UNCALIBRATED_MULTIPLE_DNS_RECORDS'));
  });

  it('non-standard policy fields on ENFORCE is flagged but score unaffected', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800, policy_unknown_fields: { extra: 'x' },
    }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('UNCALIBRATED_NONSTANDARD_POLICY_FIELDS'));
  });

  it('flags are not evaluated for non-ENFORCE states', () => {
    const r = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'testing', policy_tls_valid: false, policy_redirect_count: 3,
    }));
    assert.deepEqual(r.flags, []);
  });
});

describe('MTASTS-QM-v1.0 — ordinal preservation', () => {
  it('worst-case ENFORCE (95) exceeds best-case TESTING (25)', () => {
    const worstEnforce = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 1,
    })).score;
    const bestTesting = scoreMtaStsQuality(f({
      dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'testing',
    })).score;
    assert.ok(worstEnforce > bestTesting);
  });

  it('TESTING (25) always exceeds NONE (15) — both fixed, no multiplier applies to either', () => {
    const testing = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'testing' })).score;
    const none = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'none' })).score;
    assert.ok(testing > none);
  });

  it('NONE (15) always exceeds ABSENT/PUBLISHED_UNUSABLE (0)', () => {
    const none = scoreMtaStsQuality(f({ dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'none' })).score;
    assert.ok(none > 0);
  });
});
