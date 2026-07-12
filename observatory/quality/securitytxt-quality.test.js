'use strict';

// SECURITYTXT-QM-v1.0 unit tests (SLG-127 design / SLG-128 calibration).
// Run: node --test backend/observatory/quality/securitytxt-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreSecuritytxtQuality, QUALITY_VERSION, MODEL_ID } = require('./securitytxt-quality');

const conformantFetch = (over = {}) => ({
  fetch_state: 'FOUND', content_type: 'text/plain', http_status: 200, ...over,
});
const htmlFetch = (over = {}) => ({
  fetch_state: 'FOUND', content_type: 'text/html; charset=UTF-8', http_status: 200, ...over,
});
const notFoundFetch = () => ({ fetch_state: 'NOT_FOUND', content_type: null, http_status: 404 });

const parse = (over = {}) => ({
  contact: [' security@example.com'], expires: [' 2099-01-01T00:00:00.000Z'],
  encryption: [], acknowledgments: [], preferred_languages: [], canonical: [], policy: [], hiring: [],
  content_state: 'UNSIGNED', ...over,
});

const f = (over = {}) => ({
  domain: 'example.com',
  file_state: 'PRESENT_CANONICAL',
  collected_at: '2026-07-09T00:00:00.000Z',
  canonical_fetch: conformantFetch(),
  legacy_fetch: notFoundFetch(),
  canonical_parse: parse(),
  legacy_parse: null,
  ...over,
});

describe('SECURITYTXT-QM-v1.0 — version', () => {
  it('is v1.0', () => { assert.equal(QUALITY_VERSION, '1.0'); assert.equal(MODEL_ID, 'SECURITYTXT-QM-v1.0'); });
});

describe('SECURITYTXT-QM-v1.0 — primary ladder', () => {
  it('conformant, Contact + future Expires → 100 (CEILING)', () => {
    const r = scoreSecuritytxtQuality(f());
    assert.equal(r.score, 100);
    assert.equal(r.primaryLabel, 'CEILING');
  });

  it('conformant, Contact present, Expires missing → 50 (MIDDLE)', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ expires: [] }) }));
    assert.equal(r.score, 50);
    assert.equal(r.primaryLabel, 'MIDDLE');
  });

  it('conformant, Contact present, Expires past-dated (stale) → 50 (MIDDLE)', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ expires: [' 2020-01-01T00:00:00.000Z'] }) }));
    assert.equal(r.score, 50);
    assert.equal(r.primaryLabel, 'MIDDLE');
  });

  it('conformant, Contact present, Expires unparsable → 50 (MIDDLE), not promoted by inference', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ expires: ['Fri Feb 5 12:26:43 2027 IST'] }) }));
    assert.equal(r.score, 50);
    assert.equal(r.primaryLabel, 'MIDDLE');
  });

  it('conformant, Contact missing → 10 (MINIMAL)', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ contact: [] }) }));
    assert.equal(r.score, 10);
    assert.equal(r.primaryLabel, 'MINIMAL');
  });

  it('file_state ABSENT → 0 (FLOOR)', () => {
    const r = scoreSecuritytxtQuality(f({
      file_state: 'ABSENT', canonical_fetch: notFoundFetch(), legacy_fetch: notFoundFetch(),
      canonical_parse: null, legacy_parse: null,
    }));
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'FLOOR');
  });

  it('SPA catch-all: FOUND but content_type text/html at both locations → 0 (FLOOR), not scored as present', () => {
    const r = scoreSecuritytxtQuality(f({
      file_state: 'PRESENT_CANONICAL', canonical_fetch: htmlFetch(), legacy_fetch: notFoundFetch(),
      canonical_parse: null, legacy_parse: null,
    }));
    assert.equal(r.scored, true);
    assert.equal(r.score, 0);
    assert.equal(r.primaryLabel, 'FLOOR');
  });
});

describe('SECURITYTXT-QM-v1.0 — dual-location gate priority', () => {
  it('canonical non-conformant, legacy conformant → falls back to legacy_parse', () => {
    const r = scoreSecuritytxtQuality(f({
      file_state: 'PRESENT_LEGACY_ONLY',
      canonical_fetch: htmlFetch(), legacy_fetch: conformantFetch(),
      canonical_parse: null, legacy_parse: parse(),
    }));
    assert.equal(r.score, 100);
  });

  it('canonical conformant takes priority over legacy even if legacy also conformant', () => {
    const r = scoreSecuritytxtQuality(f({
      file_state: 'PRESENT_BOTH',
      canonical_fetch: conformantFetch(), legacy_fetch: conformantFetch(),
      canonical_parse: parse({ contact: [] }),           // canonical: MINIMAL
      legacy_parse: parse(),                               // legacy: would be CEILING
    }));
    assert.equal(r.score, 10);
    assert.equal(r.primaryLabel, 'MINIMAL');
  });
});

describe('SECURITYTXT-QM-v1.0 — Unknown ≠ Absent', () => {
  it('file_state INDETERMINATE → not scored, never floored', () => {
    const r = scoreSecuritytxtQuality(f({ file_state: 'INDETERMINATE' }));
    assert.equal(r.scored, false);
    assert.equal(r.reason, 'NOT_DETERMINED');
    assert.equal(r.score, null);
  });
});

describe('SECURITYTXT-QM-v1.0 — optional fields, evidence-only, never scored (SLG-127 §3)', () => {
  it('Encryption present → flagged, score unaffected', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ encryption: [' https://example.com/key.txt'] }) }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('ENCRYPTION_PRESENT'));
  });

  it('PGP-signed → flagged, score unaffected', () => {
    const r = scoreSecuritytxtQuality(f({ canonical_parse: parse({ content_state: 'SIGNED' }) }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('PGP_SIGNED'));
  });

  it('Canonical, Preferred-Languages, Policy, Acknowledgments, Hiring all present → flagged, score unaffected', () => {
    const r = scoreSecuritytxtQuality(f({
      canonical_parse: parse({
        canonical: [' https://example.com/.well-known/security.txt'],
        preferred_languages: [' en'], policy: [' https://example.com/policy'],
        acknowledgments: [' https://example.com/hall-of-fame'], hiring: [' https://example.com/jobs'],
      }),
    }));
    assert.equal(r.score, 100);
    assert.ok(r.flags.includes('CANONICAL_PRESENT'));
    assert.ok(r.flags.includes('PREFERRED_LANGUAGES_PRESENT'));
    assert.ok(r.flags.includes('POLICY_PRESENT'));
    assert.ok(r.flags.includes('ACKNOWLEDGMENTS_PRESENT'));
    assert.ok(r.flags.includes('HIRING_PRESENT'));
  });

  it('no optional fields present → no flags, score unaffected', () => {
    const r = scoreSecuritytxtQuality(f());
    assert.deepEqual(r.flags, []);
    assert.equal(r.score, 100);
  });
});

describe('SECURITYTXT-QM-v1.0 — ordinal preservation', () => {
  it('CEILING > MIDDLE > MINIMAL > FLOOR', () => {
    const ceiling = scoreSecuritytxtQuality(f()).score;
    const middle = scoreSecuritytxtQuality(f({ canonical_parse: parse({ expires: [] }) })).score;
    const minimal = scoreSecuritytxtQuality(f({ canonical_parse: parse({ contact: [] }) })).score;
    const floor = scoreSecuritytxtQuality(f({ file_state: 'ABSENT', canonical_fetch: notFoundFetch(), canonical_parse: null })).score;
    assert.ok(ceiling > middle);
    assert.ok(middle > minimal);
    assert.ok(minimal > floor);
  });
});
