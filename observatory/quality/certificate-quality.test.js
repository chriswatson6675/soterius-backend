'use strict';

// CERTIFICATE-QM-v1.0 unit tests (SLG-107 design / SLG-108 calibration / SLG-109 falsification).
// Run: node --test backend/observatory/quality/certificate-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreCertificateQuality, QUALITY_VERSION, MODEL_ID,
  PRIMARY_CEILING, PRIMARY_FLOOR,
} = require('./certificate-quality');

const f = (o = {}) => ({
  endpoint_state: 'RESPONSE_OBSERVED',
  certificate_present: 'CERTIFICATE_PRESENTED',
  tls_verification_result: 'CHAIN_VERIFIED',
  leaf_key_type: 'RSA',
  leaf_key_bits: 2048,
  leaf_key_curve: null,
  leaf_is_wildcard: false,
  leaf_is_self_signed: false,
  leaf_lifetime_days: 90,
  ...o,
});

describe('CERTIFICATE-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'CERTIFICATE-QM-v1.0'); });
});

describe('CERTIFICATE-QM-v1.0 — Unknown ≠ Absent (unscored states)', () => {
  it('CONNECTION_ERROR is never scored', () => {
    const r = scoreCertificateQuality(f({ endpoint_state: 'CONNECTION_ERROR', certificate_present: null, tls_verification_result: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_OBSERVED');
    assert.equal(r.score, null);
  });

  it('TLS_ERROR is never scored', () => {
    const r = scoreCertificateQuality(f({ endpoint_state: 'TLS_ERROR', certificate_present: null, tls_verification_result: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_OBSERVED');
  });

  it('RESPONSE_OBSERVED with NO_CERTIFICATE is never scored (not floored)', () => {
    const r = scoreCertificateQuality(f({ certificate_present: 'NO_CERTIFICATE', tls_verification_result: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NO_CERTIFICATE_EVIDENCE');
    assert.equal(r.score, null);
  });

  it('RESPONSE_OBSERVED with HANDSHAKE_INCOMPLETE is never scored', () => {
    const r = scoreCertificateQuality(f({ certificate_present: 'HANDSHAKE_INCOMPLETE', tls_verification_result: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NO_CERTIFICATE_EVIDENCE');
  });

  it('CERTIFICATE_PRESENTED with no verification result fails loudly, not silently scored', () => {
    const r = scoreCertificateQuality(f({ tls_verification_result: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'INVALID_OBSERVATION');
  });
});

describe('CERTIFICATE-QM-v1.0 — Primary (binary trust-chain-validity gate)', () => {
  it('CHAIN_VERIFIED → 100 (CEILING)', () => {
    const r = scoreCertificateQuality(f());
    assert.equal(r.score, 100);
    assert.equal(r.primary, PRIMARY_CEILING);
    assert.equal(r.primaryLabel, 'CEILING');
  });

  for (const state of ['HOSTNAME_MISMATCH', 'CERT_EXPIRED', 'CHAIN_UNVERIFIABLE', 'SELF_SIGNED', 'SELF_SIGNED_IN_CHAIN', 'OTHER_TLS_ERROR']) {
    it(`${state} → 0 (FLOOR) — no ranking among failure sub-types`, () => {
      const r = scoreCertificateQuality(f({ tls_verification_result: state }));
      assert.equal(r.scored, true);
      assert.equal(r.score, 0);
      assert.equal(r.primary, PRIMARY_FLOOR);
      assert.equal(r.primaryLabel, 'FLOOR');
    });
  }

  it('a floored domain ignores every multiplier condition (wildcard + weak key + long lifetime all present)', () => {
    const r = scoreCertificateQuality(f({
      tls_verification_result: 'CERT_EXPIRED',
      leaf_key_bits: 1024, leaf_is_wildcard: true, leaf_lifetime_days: 365,
    }));
    assert.equal(r.score, 0);
    assert.equal(r.m1, null);
    assert.equal(r.m2, null);
    assert.equal(r.m3, null);
  });
});

describe('CERTIFICATE-QM-v1.0 — self-signed is a diagnostic annotation, not a scoring input', () => {
  it('self-signed masked as CERT_EXPIRED still floors, and is surfaced in evidence.selfSigned', () => {
    const r = scoreCertificateQuality(f({ tls_verification_result: 'CERT_EXPIRED', leaf_is_self_signed: true }));
    assert.equal(r.score, 0);
    assert.equal(r.evidence.selfSigned, true);
  });

  it('explicit SELF_SIGNED result also floors identically (no separate deduction)', () => {
    const r = scoreCertificateQuality(f({ tls_verification_result: 'SELF_SIGNED', leaf_is_self_signed: true }));
    assert.equal(r.score, 0);
  });
});

describe('CERTIFICATE-QM-v1.0 — M1 Key Strength (resolves RSA-vs-EC)', () => {
  it('RSA 2048 bits → no reduction', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: 'RSA', leaf_key_bits: 2048 }));
    assert.equal(r.m1, 1.0);
    assert.equal(r.score, 100);
  });

  it('RSA 4096 bits → no reduction (no extra credit above the floor either)', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: 'RSA', leaf_key_bits: 4096 }));
    assert.equal(r.m1, 1.0);
    assert.equal(r.score, 100);
  });

  it('RSA 1024 bits → 0.50 reduction (CABF §6.1.5 sub-floor)', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: 'RSA', leaf_key_bits: 1024 }));
    assert.equal(r.m1, 0.5);
    assert.equal(r.score, 50);
  });

  it('EC prime256v1 → no reduction — no ranking between RSA and EC families', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: 'EC', leaf_key_bits: null, leaf_key_curve: 'prime256v1' }));
    assert.equal(r.m1, 1.0);
    assert.equal(r.score, 100);
  });

  it('EC secp384r1 → no reduction (no ranking between curves either)', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: 'EC', leaf_key_bits: null, leaf_key_curve: 'secp384r1' }));
    assert.equal(r.m1, 1.0);
    assert.equal(r.score, 100);
  });

  it('undetermined key type/bits (null) is never penalised — Unknown ≠ Absent applies within the multiplier', () => {
    const r = scoreCertificateQuality(f({ leaf_key_type: null, leaf_key_bits: null }));
    assert.equal(r.m1, 1.0);
  });
});

describe('CERTIFICATE-QM-v1.0 — M2 Wildcard Exposure', () => {
  it('non-wildcard → no reduction', () => {
    const r = scoreCertificateQuality(f({ leaf_is_wildcard: false }));
    assert.equal(r.m2, 1.0);
    assert.equal(r.score, 100);
  });

  it('wildcard → 0.95 reduction', () => {
    const r = scoreCertificateQuality(f({ leaf_is_wildcard: true }));
    assert.equal(r.m2, 0.95);
    assert.equal(r.score, 95);
  });

  it('null (D-2, no SAN to evaluate) → treated as not-wildcard-exposed, no reduction', () => {
    const r = scoreCertificateQuality(f({ leaf_is_wildcard: null }));
    assert.equal(r.m2, 1.0);
    assert.equal(r.score, 100);
  });
});

describe('CERTIFICATE-QM-v1.0 — M3 Lifetime/Issuance Modernity (recalibrated 100-day threshold)', () => {
  it('90-day (Let\'s Encrypt/ACME default) → no reduction', () => {
    const r = scoreCertificateQuality(f({ leaf_lifetime_days: 90 }));
    assert.equal(r.m3, 1.0);
    assert.equal(r.score, 100);
  });

  it('exactly 100 days → no reduction (boundary is inclusive of the short tier)', () => {
    const r = scoreCertificateQuality(f({ leaf_lifetime_days: 100 }));
    assert.equal(r.m3, 1.0);
  });

  it('101 days → 0.95 reduction (just over threshold)', () => {
    const r = scoreCertificateQuality(f({ leaf_lifetime_days: 101 }));
    assert.equal(r.m3, 0.95);
    assert.equal(r.score, 95);
  });

  it('397 days (CABF ceiling, still fully compliant) → reduced, not floored', () => {
    const r = scoreCertificateQuality(f({ leaf_lifetime_days: 397 }));
    assert.equal(r.m3, 0.95);
    assert.equal(r.score, 95);
  });

  it('undetermined lifetime (null) is never penalised', () => {
    const r = scoreCertificateQuality(f({ leaf_lifetime_days: null }));
    assert.equal(r.m3, 1.0);
  });
});

describe('CERTIFICATE-QM-v1.0 — multiplier composition', () => {
  it('wildcard AND long lifetime compound multiplicatively: 100 × 0.95 × 0.95 = 90.25', () => {
    const r = scoreCertificateQuality(f({ leaf_is_wildcard: true, leaf_lifetime_days: 200 }));
    assert.equal(r.m2, 0.95);
    assert.equal(r.m3, 0.95);
    assert.equal(r.score, 90.25);
  });

  it('all three multipliers can compound (weak key + wildcard + long lifetime): 100 × 0.5 × 0.95 × 0.95 = 45.125 → 45.13', () => {
    const r = scoreCertificateQuality(f({
      leaf_key_type: 'RSA', leaf_key_bits: 1024, leaf_is_wildcard: true, leaf_lifetime_days: 200,
    }));
    assert.equal(r.score, 45.13);
  });
});

describe('CERTIFICATE-QM-v1.0 — no duplication with SOT-TLS-001 / M4 not implemented', () => {
  it('scoring ignores any TLS-session fields present on the input object', () => {
    const r = scoreCertificateQuality(f({
      negotiated_version: 'TLSv1', cipher_suite_standard: 'GARBAGE', forward_secrecy: false, alpn_protocol: null,
    }));
    assert.equal(r.score, 100);
  });

  it('the returned object has no M4/AIA-derived field — M4 was removed at calibration, not merely defaulted', () => {
    const r = scoreCertificateQuality(f());
    assert.equal('m4' in r, false);
    assert.equal('aiaOcspPresent' in (r.evidence || {}), false);
  });
});
