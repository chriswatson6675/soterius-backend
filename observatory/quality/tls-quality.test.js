'use strict';

// TLS-QM-v1.0 unit tests (SLG-097 design / SLG-098 calibration).
// Run: node --test backend/observatory/quality/tls-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreTlsQuality, QUALITY_VERSION, MODEL_ID } = require('./tls-quality');

const f = (o = {}) => ({
  endpoint_state: 'RESPONSE_OBSERVED',
  negotiated_version: 'TLSv1.3',
  cipher_suite_standard: 'TLS_AES_256_GCM_SHA384',
  cipher_key_exchange: 'TLS13',
  forward_secrecy: true,
  alpn_protocol: 'h2',
  http2_negotiated: true,
  ...o,
});

describe('TLS-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'TLS-QM-v1.0'); });
});

describe('TLS-QM-v1.0 — primary ladder', () => {
  it('TLSv1.3 → 100 (CEILING)', () => {
    const r = scoreTlsQuality(f());
    assert.equal(r.score, 100);
    assert.equal(r.primaryLabel, 'CEILING');
  });

  it('TLSv1.2 + ECDHE → 90 (UPPER_MIDDLE)', () => {
    const r = scoreTlsQuality(f({
      negotiated_version: 'TLSv1.2', cipher_key_exchange: 'ECDHE',
      cipher_suite_standard: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', forward_secrecy: true,
    }));
    assert.equal(r.score, 90);
    assert.equal(r.primaryLabel, 'UPPER_MIDDLE');
  });

  it('TLSv1.2 + DHE → 90 (UPPER_MIDDLE)', () => {
    const r = scoreTlsQuality(f({
      negotiated_version: 'TLSv1.2', cipher_key_exchange: 'DHE',
      cipher_suite_standard: 'TLS_DHE_RSA_WITH_AES_256_GCM_SHA384', forward_secrecy: true,
    }));
    assert.equal(r.score, 90);
  });

  it('TLSv1.2 + static-RSA (derived field present) → 25 (LOWER_MIDDLE)', () => {
    const r = scoreTlsQuality(f({
      negotiated_version: 'TLSv1.2', cipher_key_exchange: 'RSA',
      cipher_suite_standard: 'TLS_RSA_WITH_AES_256_GCM_SHA384', forward_secrecy: false,
    }));
    assert.equal(r.score, 25);
    assert.equal(r.primaryLabel, 'LOWER_MIDDLE');
  });

  it('TLSv1.1 → 0 (FLOOR)', () => {
    const r = scoreTlsQuality(f({ negotiated_version: 'TLSv1.1', cipher_key_exchange: null, forward_secrecy: null }));
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'FLOOR');
  });

  it('TLSv1 → 0 (FLOOR)', () => {
    assert.equal(scoreTlsQuality(f({ negotiated_version: 'TLSv1' })).score, 0);
  });

  it('SSLv3 → 0 (FLOOR)', () => {
    assert.equal(scoreTlsQuality(f({ negotiated_version: 'SSLv3' })).score, 0);
  });
});

describe('TLS-QM-v1.0 — SLG-097 §2 L-4 resolution (raw cipher name fallback)', () => {
  it('null cipher_key_exchange + TLS_RSA_WITH_ standard name → LOWER_MIDDLE (25), not excluded', () => {
    const r = scoreTlsQuality(f({
      negotiated_version: 'TLSv1.2',
      cipher_key_exchange: null,               // collector L-4: derivation failed
      cipher_suite_standard: 'TLS_RSA_WITH_AES_256_CBC_SHA',
      forward_secrecy: null,
    }));
    assert.equal(r.scored, true);
    assert.equal(r.score, 25);
    assert.equal(r.primaryLabel, 'LOWER_MIDDLE');
  });

  it('null cipher_key_exchange + non-RSA-prefixed standard name → NOT_CLASSIFIABLE, not silently scored', () => {
    const r = scoreTlsQuality(f({
      negotiated_version: 'TLSv1.2',
      cipher_key_exchange: null,
      cipher_suite_standard: 'TLS_SOME_FUTURE_CIPHER_SHA512',
      forward_secrecy: null,
    }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_CLASSIFIABLE');
  });
});

describe('TLS-QM-v1.0 — unknown / not-scored (Unknown ≠ Absent)', () => {
  it('CONNECTION_ERROR → not scored, never floored', () => {
    const r = scoreTlsQuality(f({ endpoint_state: 'CONNECTION_ERROR', negotiated_version: null, cipher_key_exchange: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_OBSERVED');
    assert.equal(r.score, null);
  });

  it('TLS_ERROR → not scored, never floored', () => {
    const r = scoreTlsQuality(f({ endpoint_state: 'TLS_ERROR', negotiated_version: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_OBSERVED');
  });

  it('RESPONSE_OBSERVED with null negotiated_version → INVALID_OBSERVATION, not scored', () => {
    const r = scoreTlsQuality(f({ negotiated_version: null }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'INVALID_OBSERVATION');
  });

  it('unrecognised negotiated_version → not scored, not silently defaulted', () => {
    const r = scoreTlsQuality(f({ negotiated_version: 'TLSv2.0' }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'UNRECOGNISED_VERSION');
  });
});

describe('TLS-QM-v1.0 — ALPN/HTTP-2 evidence-only (SLG-097 §4, never scored)', () => {
  it('h2 negotiated → no ALPN flag, score unaffected', () => {
    const r = scoreTlsQuality(f({ alpn_protocol: 'h2', http2_negotiated: true }));
    assert.equal(r.score, 100);
    assert.ok(!r.flags.includes('ALPN_NOT_H2'));
    assert.ok(!r.flags.includes('ALPN_NOT_NEGOTIATED'));
  });

  it('http/1.1 negotiated → ALPN_NOT_H2 flagged, score unaffected', () => {
    const r = scoreTlsQuality(f({ alpn_protocol: 'http/1.1', http2_negotiated: false }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('ALPN_NOT_H2'));
  });

  it('ALPN not negotiated → ALPN_NOT_NEGOTIATED flagged, score unaffected', () => {
    const r = scoreTlsQuality(f({ alpn_protocol: null, http2_negotiated: null }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('ALPN_NOT_NEGOTIATED'));
  });
});

describe('TLS-QM-v1.0 — ordinal preservation', () => {
  it('CEILING > UPPER_MIDDLE > LOWER_MIDDLE > FLOOR', () => {
    const ceiling = scoreTlsQuality(f()).score;
    const upperMiddle = scoreTlsQuality(f({ negotiated_version: 'TLSv1.2', cipher_key_exchange: 'ECDHE' })).score;
    const lowerMiddle = scoreTlsQuality(f({ negotiated_version: 'TLSv1.2', cipher_key_exchange: 'RSA' })).score;
    const floor = scoreTlsQuality(f({ negotiated_version: 'TLSv1.1', cipher_key_exchange: null })).score;
    assert.ok(ceiling > upperMiddle);
    assert.ok(upperMiddle > lowerMiddle);
    assert.ok(lowerMiddle > floor);
  });
});
