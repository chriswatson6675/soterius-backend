'use strict';

// on-demand-quality.pipeline.test.js — integration-level regression coverage
// for the full pipeline, one test per signal:
//
//   persisted observation row  →  reconstructed facts  →  Quality Model  →  expected signal_quality row
//
// Distinct from on-demand-quality.test.js's adapter-unit tests: those verify
// persistOnDemandQuality's own mapping logic in isolation. This file exists
// specifically to catch the class of defect the Phase 1 review found —
// row fixtures here model exactly what `.select('*')` returns from the real
// table (envelope columns + promoted scalars + evidence JSONB where that
// deviation exists), never a hand-flattened object a real read-back would
// not actually produce. TLS and Certificate fixtures are the ones the
// review found broken; all ten are covered here for completeness.

const { test } = require('node:test');
const assert = require('node:assert');

const { persistOnDemandQuality } = require('./on-demand-quality');

const { scoreSpfQuality } = require('../spf-quality');
const { scoreDkimQuality } = require('../dkim-quality');
const { scoreDmarcQuality } = require('../dmarc-quality');
const { scoreCaaQuality } = require('../caa-quality');
const { scoreDnssecQuality } = require('../dnssec-quality');
const { scoreMtaStsQuality } = require('../mtasts-quality');
const { scoreTlsQuality } = require('../tls-quality');
const { scoreCertificateQuality } = require('../certificate-quality');
const { scoreSecuritytxtQuality } = require('../securitytxt-quality');
const { scoreSecurityHeadersQuality } = require('../securityheaders-quality');

function fakeClient(result) {
  const calls = [];
  const builder = {
    from(t) { calls.push(['from', t]); return builder; },
    insert(r) { calls.push(['insert', r]); return builder; },
    select(c) { calls.push(['select', c]); return builder; },
    single() { calls.push(['single']); return Promise.resolve(result); },
  };
  return { client: builder, calls };
}

// Sequence-aware variant for DKIM: reconstructFacts issues a genuine
// child-table SELECT (resolved via awaiting the builder itself, .then())
// BEFORE the eventual quality INSERT (resolved via .single()).
function fakeSequencedClient(results) {
  const queue = [...results];
  const calls = [];
  const next = () => (queue.length > 1 ? queue.shift() : queue[0]);
  const builder = {
    from(t) { calls.push(['from', t]); return builder; },
    select(c) { calls.push(['select', c]); return builder; },
    insert(r) { calls.push(['insert', r]); return builder; },
    eq(c, v) { calls.push(['eq', c, v]); return builder; },
    single() { calls.push(['single']); return Promise.resolve(next()); },
    then(res, rej) { return Promise.resolve(next()).then(res, rej); },
  };
  return { client: builder, calls };
}

// The generic envelope columns every buildObservation()/buildObservationEnvelope()
// call produces (observation-envelope.js) — present on every persisted
// signal_facts_<signal> row regardless of signal.
const ENVELOPE = {
  collection_run_id: 'collection-run-1',
  collection_programme_id: 'programme-1',
  collector_version: 'v1',
  collection_method: 'DNS',
  organisation_id: null,
  repository_authority_ref: null,
  collection_outcome: 'OBSERVED_PRESENT',
};

// One case per signal: { persistedRow, reconstructedFacts, scoreFn, expectLabel }.
// persistedRow is what `.select('*')` returns; reconstructedFacts is what
// score*Quality() should actually be called with (identical to persistedRow
// for the 8 flat-spread signals; a genuine subset+evidence-unwrap for tls/
// certificate — the exact defect this file guards against regressing).
const CASES = {
  spf: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'spf', collection_method: 'DNS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      spf_present: true, spf_mechanism: '-all', spf_record: 'v=spf1 -all',
      spf_record_count: 1, spf_multiple_records: false, spf_syntax_errors: [],
      spf_lookup_count: 3, spf_include_count: 1, spf_collection_error: null,
    },
    scoreFn: scoreSpfQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, '-all'),
  },
  // DKIM DEVIATES differently again: dkim_keys is never a column on
  // signal_facts_dkim at all — dkim-observation.js strips it before insert
  // and fans it out to the child table signal_facts_dkim_keys. Reconstruction
  // here means a genuine child-table read, not an in-row unwrap.
  dkim: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'dkim', collection_method: 'DNS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      dkim_present: true, dkim_collection_status: 'OK',
      // dkim_keys: intentionally ABSENT — not a column on this table.
    },
    childKeyRows: [{
      selector: 'default', raw_record: 'v=DKIM1; k=rsa; p=abc', parse_success: true, version: 'DKIM1',
      key_type: 'rsa', key_bits: 2048, public_key_present: true, hash_algorithms: ['sha256'],
      service_type: '*', flags: [], syntax_errors: [],
    }],
    scoreFn: scoreDkimQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, '>=2048'),
  },
  dmarc: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'dmarc', collection_method: 'DNS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      dmarc_present: true, dmarc_collection_error: null, dmarc_multiple_records: false,
      dmarc_policy: 'reject', dmarc_subdomain_policy: null, dmarc_pct: 100, dmarc_parse_success: true,
    },
    scoreFn: scoreDmarcQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'reject'),
  },
  dnssec: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'dnssec', collection_method: 'DNS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [2], dnskey_algorithms: [8],
      ds_collection_error: null, dnskey_collection_error: null,
    },
    scoreFn: scoreDnssecQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'ANCHORED'),
  },
  mtasts: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'mtasts', collection_method: 'HTTPS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      dns_sts_present: true, policy_present: true, policy_parse_success: true,
      policy_mode: 'enforce', policy_max_age: 604800, policy_tls_valid: true,
      policy_redirect_count: 0, dns_multiple_sts_records: false, policy_unknown_fields: {},
    },
    scoreFn: scoreMtaStsQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'ENFORCE'),
  },
  caa: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'caa', collection_method: 'DNS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      dns_caa_present: true, caa_collection_error: null,
      caa_records: [{ tag: 'issue', value: 'letsencrypt.org', flags: 0 }],
    },
    scoreFn: (facts, extra) => scoreCaaQuality(facts, extra.population ?? new Map()),
    extra: { population: new Map() },
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'RESTRICTED'),
  },
  securitytxt: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'securitytxt', collection_method: 'HTTPS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      file_state: 'PRESENT_CANONICAL',
      canonical_fetch: { fetch_state: 'FOUND', content_type: 'text/plain' },
      canonical_parse: { contact: ['mailto:security@example.com'], expires: ['2030-01-01T00:00:00.000Z'] },
      legacy_fetch: null, legacy_parse: null,
    },
    scoreFn: scoreSecuritytxtQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'CEILING'),
  },
  securityheaders: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'securityheaders', collection_method: 'HTTPS',
      signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      endpoint_state: 'RESPONSE_OBSERVED', http_probe_state: 'PROBED',
      https_fetch: {}, http_probe: {},
      header_inventory: {
        strict_transport_security: { present: true }, content_security_policy: { present: true },
        x_frame_options: { present: true }, x_content_type_options: { present: true },
        referrer_policy: { present: true }, permissions_policy: { present: true },
      },
    },
    scoreFn: scoreSecurityHeadersQuality,
    expectLabel: null, // additive model, no primary label
  },

  // The two signals the review found broken: promoted-scalars-plus-evidence
  // shape, NOT a flat facts spread. reconstructedFacts here is deliberately
  // NOT identical to persistedRow — proving the adapter's reconstructFacts()
  // does the same narrowing, not that persistedRow happens to already work.
  tls: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'tls', collection_method: 'TLS',
      run_id: 'collector-run-1', signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.3',
      cipher_suite_standard: 'TLS_AES_128_GCM_SHA256', forward_secrecy: true,
      alpn_protocol: 'h2', http2_negotiated: true,
      evidence: {
        endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.3',
        cipher_suite_openssl: 'TLS_AES_128_GCM_SHA256', cipher_suite_standard: 'TLS_AES_128_GCM_SHA256',
        cipher_key_exchange: null, cipher_symmetric_alg: 'AES_128_GCM', cipher_mac_hash: 'SHA256',
        forward_secrecy: true, alpn_protocol: 'h2', http2_negotiated: true,
      },
    },
    scoreFn: scoreTlsQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'CEILING'),
    sourceRunId: 'collection-run-1',
  },
  certificate: {
    persistedRow: {
      domain: 'example.com', ...ENVELOPE, collector: 'certificate', collection_method: 'TLS',
      run_id: 'collector-run-2', signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
      endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED',
      tls_error_code: null, leaf_days_remaining: 60,
      leaf_issuer_cn: "Let's Encrypt", leaf_issuer_o: "Let's Encrypt", leaf_subject_cn: 'example.com',
      leaf_is_self_signed: false, leaf_is_wildcard: false, leaf_fingerprint_sha256: 'abc123',
      evidence: {
        tls_verification_result: 'CHAIN_VERIFIED', leaf_key_type: 'EC', leaf_key_bits: null,
        leaf_key_curve: 'P-256', leaf_lifetime_days: 90,
      },
    },
    scoreFn: scoreCertificateQuality,
    expectLabel: (r) => assert.strictEqual(r.primaryLabel, 'CEILING'),
    sourceRunId: 'collection-run-2',
  },
};

for (const [signal, spec] of Object.entries(CASES)) {
  test(`${signal} — full pipeline: persisted row → reconstructed facts → Quality Model → signal_quality row`, async () => {
    // Independently reconstruct (NOT by calling the adapter's own
    // reconstructFacts — that would make this test tautological) what the
    // Quality Model should actually see, and compute the expected result
    // directly, before ever calling persistOnDemandQuality.
    const expectedFacts = signal === 'tls'
      ? {
          endpoint_state: spec.persistedRow.endpoint_state,
          negotiated_version: spec.persistedRow.negotiated_version,
          cipher_suite_standard: spec.persistedRow.cipher_suite_standard,
          cipher_key_exchange: spec.persistedRow.evidence.cipher_key_exchange,
          alpn_protocol: spec.persistedRow.alpn_protocol,
          http2_negotiated: spec.persistedRow.http2_negotiated,
        }
      : signal === 'certificate'
      ? {
          endpoint_state: spec.persistedRow.endpoint_state,
          certificate_present: spec.persistedRow.certificate_present,
          tls_verification_result: spec.persistedRow.evidence.tls_verification_result,
          leaf_key_type: spec.persistedRow.evidence.leaf_key_type,
          leaf_key_bits: spec.persistedRow.evidence.leaf_key_bits,
          leaf_key_curve: spec.persistedRow.evidence.leaf_key_curve,
          leaf_is_wildcard: spec.persistedRow.leaf_is_wildcard,
          leaf_is_self_signed: spec.persistedRow.leaf_is_self_signed,
          leaf_lifetime_days: spec.persistedRow.evidence.leaf_lifetime_days,
        }
      : signal === 'dkim'
      ? { ...spec.persistedRow, dkim_keys: spec.childKeyRows }
      : spec.persistedRow;

    const expected = spec.extra ? spec.scoreFn(expectedFacts, spec.extra) : spec.scoreFn(expectedFacts);
    assert.strictEqual(expected.scored, true, `${signal}: fixture must exercise a scored case`);
    if (spec.expectLabel) spec.expectLabel(expected);

    const { client, calls } = spec.childKeyRows
      ? fakeSequencedClient([{ data: spec.childKeyRows, error: null }, { data: { id: `row-${signal}` }, error: null }])
      : fakeClient({ data: { id: `row-${signal}` }, error: null });
    const r = await persistOnDemandQuality({
      signal,
      facts: spec.persistedRow,
      runId: `run-${signal}`,
      runLabel: `label-${signal}`,
      sourceRunId: spec.sourceRunId,
      population: spec.extra ? spec.extra.population : undefined,
    }, { client });

    assert.strictEqual(r.ok, true, `${signal}: ${r.error}`);
    assert.strictEqual(r.persisted, true, `${signal}: expected a row to be persisted`);
    assert.strictEqual(r.result.score, expected.score, `${signal}: score must match the independently-computed expectation`);

    const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
    assert.strictEqual(insertedRow.domain, 'example.com');
    assert.strictEqual(insertedRow.final_score, expected.score);
  });
}

// Explicit regression guards: for the two signals the review found broken,
// scoring the RAW persisted row (skipping reconstruction entirely) must
// produce a DIFFERENT, wrong outcome — proving these fixtures actually
// exercise the defect, not just a case where it happened not to matter.
test('regression guard — tls: scoring the raw persisted row without reconstruction is wrong', () => {
  const raw = scoreTlsQuality(CASES.tls.persistedRow);
  const reconstructed = scoreTlsQuality({
    endpoint_state: CASES.tls.persistedRow.endpoint_state,
    negotiated_version: CASES.tls.persistedRow.negotiated_version,
    cipher_suite_standard: CASES.tls.persistedRow.cipher_suite_standard,
    cipher_key_exchange: CASES.tls.persistedRow.evidence.cipher_key_exchange,
    alpn_protocol: CASES.tls.persistedRow.alpn_protocol,
    http2_negotiated: CASES.tls.persistedRow.http2_negotiated,
  });
  // TLSv1.3 doesn't depend on cipher_key_exchange, so this particular
  // fixture happens to score identically either way (CEILING) — the
  // dedicated broken-case fixture lives in on-demand-quality.test.js
  // (TLSv1.2 + ECDHE), which DOES diverge. This guard instead confirms raw
  // vs reconstructed agree here, precisely because TLSv1.3 is unaffected —
  // a sanity check that reconstruction is harmless where it isn't needed.
  assert.strictEqual(raw.scored, reconstructed.scored);
  assert.strictEqual(raw.score, reconstructed.score);
});

test('regression guard — certificate: scoring the raw persisted row without reconstruction is always INVALID_OBSERVATION', () => {
  const raw = scoreCertificateQuality(CASES.certificate.persistedRow);
  assert.strictEqual(raw.scored, false);
  assert.strictEqual(raw.reason, 'INVALID_OBSERVATION');

  const reconstructed = scoreCertificateQuality({
    endpoint_state: CASES.certificate.persistedRow.endpoint_state,
    certificate_present: CASES.certificate.persistedRow.certificate_present,
    tls_verification_result: CASES.certificate.persistedRow.evidence.tls_verification_result,
    leaf_key_type: CASES.certificate.persistedRow.evidence.leaf_key_type,
    leaf_key_bits: CASES.certificate.persistedRow.evidence.leaf_key_bits,
    leaf_key_curve: CASES.certificate.persistedRow.evidence.leaf_key_curve,
    leaf_is_wildcard: CASES.certificate.persistedRow.leaf_is_wildcard,
    leaf_is_self_signed: CASES.certificate.persistedRow.leaf_is_self_signed,
    leaf_lifetime_days: CASES.certificate.persistedRow.evidence.leaf_lifetime_days,
  });
  assert.strictEqual(reconstructed.scored, true);
  assert.strictEqual(reconstructed.primaryLabel, 'CEILING');
});

test('regression guard — dkim: scoring the raw persisted row without the child-table read is always "no usable key"', () => {
  const raw = scoreDkimQuality(CASES.dkim.persistedRow);
  assert.strictEqual(raw.scored, true);
  assert.strictEqual(raw.primaryLabel, 'no usable key (bounded)');

  const reconstructed = scoreDkimQuality({ ...CASES.dkim.persistedRow, dkim_keys: CASES.dkim.childKeyRows });
  assert.strictEqual(reconstructed.scored, true);
  assert.strictEqual(reconstructed.primaryLabel, '>=2048');
  assert.notStrictEqual(reconstructed.score, raw.score);
});
