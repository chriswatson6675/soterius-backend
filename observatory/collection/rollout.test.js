'use strict';

// Sprint 9 — Observation envelope rollout across all 9 Observatory-native
// collectors. One table-driven suite: for every signal it proves the acceptance
// points offline (no DB/network) — canonical Observation produced, ownership
// chain complete, provenance + raw evidence + observed facts preserved, no
// interpreted value stored, outcome mapping correct, and the Quality Model
// unaffected.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { spfAdapter, deriveCollectionOutcome: spfOutcome } = require('../../collection/signals/spf/spf-observation');
const { dmarcAdapter, deriveCollectionOutcome: dmarcOutcome } = require('../../collection/signals/dmarc/dmarc-observation');
const { caaAdapter, deriveCollectionOutcome: caaOutcome } = require('../../collection/signals/caa/caa-observation');
const { mtastsAdapter, deriveCollectionOutcome: mtastsOutcome } = require('../../collection/signals/mtasts/mtasts-observation');
const { dkimAdapter, deriveCollectionOutcome: dkimOutcome } = require('../../collection/signals/dkim/dkim-observation');
const { tlsAdapter, deriveCollectionOutcome: tlsOutcome } = require('../../collection/signals/tls/tls-observation');
const { certificateAdapter, deriveCollectionOutcome: certOutcome } = require('../../collection/signals/tls/certificate-observation');
const { securityHeadersAdapter, deriveCollectionOutcome: shOutcome } = require('../../collection/signals/securityheaders/securityheaders-observation');
const { securityTxtAdapter, deriveCollectionOutcome: stOutcome } = require('../../collection/signals/securitytxt/securitytxt-observation');

const { scoreSpfQuality } = require('./../quality/spf-quality');
const { scoreDmarcQuality } = require('./../quality/dmarc-quality');
const { scoreCaaQuality } = require('./../quality/caa-quality');
const { scoreMtaStsQuality } = require('./../quality/mtasts-quality');
const { scoreDkimQuality } = require('./../quality/dkim-quality');
const { scoreTlsQuality } = require('./../quality/tls-quality');
const { scoreCertificateQuality } = require('./../quality/certificate-quality');
const { scoreSecurityHeadersQuality } = require('./../quality/securityheaders-quality');
const { scoreSecuritytxtQuality } = require('./../quality/securitytxt-quality');

const run = { id: 'run-1', programme_id: 'prog-1' };
const FORBIDDEN = ['score', 'final_score', 'primary_score', 'primary_label', 'quality_version', 'risk_band', 'grade', 'rating'];

// Per-signal config. `present` is a QM-valid fixture; `outcomes` exercises the
// four-state mapping; `payloadKey` must survive onto the row; `qm` scores facts;
// `rowIsSuperset` = the built row contains the payload verbatim (flat signals),
// so scoring the row must equal scoring the facts.
const SIGNALS = [
  {
    name: 'SPF', adapter: spfAdapter, derive: spfOutcome, qm: scoreSpfQuality, rowIsSuperset: true,
    present: { spf_present: true, spf_mechanism: '-all', spf_syntax_errors: [], spf_lookup_count: 2, spf_collection_error: null },
    payloadKey: ['spf_mechanism', '-all'],
    outcomes: [
      [{ spf_present: true }, 'OBSERVED_PRESENT'],
      [{ spf_present: false }, 'OBSERVED_ABSENT'],
      [{ spf_present: null, spf_collection_error: 'DNS_TIMEOUT' }, 'NOT_OBSERVED'],
      [{ spf_present: null, spf_collection_error: 'DNS_SERVFAIL' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.score, 100),
  },
  {
    name: 'DMARC', adapter: dmarcAdapter, derive: dmarcOutcome, qm: scoreDmarcQuality, rowIsSuperset: true,
    present: { dmarc_present: true, dmarc_policy: 'reject', dmarc_multiple_records: false, dmarc_collection_error: null },
    payloadKey: ['dmarc_policy', 'reject'],
    outcomes: [
      [{ dmarc_present: true }, 'OBSERVED_PRESENT'],
      [{ dmarc_present: false, dmarc_collection_error: null }, 'OBSERVED_ABSENT'],
      [{ dmarc_present: null, dmarc_collection_error: 'DNS_TIMEOUT' }, 'NOT_OBSERVED'],
      [{ dmarc_present: null, dmarc_collection_error: 'DNS_FAILURE' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.score, 100),
  },
  {
    name: 'CAA', adapter: caaAdapter, derive: caaOutcome, qm: scoreCaaQuality, rowIsSuperset: true,
    present: { dns_caa_present: true, caa_records: [{ tag: 'issue', value: 'letsencrypt.org' }], caa_record_count: 1, caa_issue_count: 1, caa_issuewild_count: 0, caa_iodef_count: 0, caa_unknown_tag_count: 0, caa_critical_count: 0, caa_issue_values: ['letsencrypt.org'], caa_issuewild_values: [], caa_iodef_values: [], caa_tags_present: ['issue'], caa_collection_error: null },
    payloadKey: ['caa_issue_count', 1],
    outcomes: [
      [{ dns_caa_present: true }, 'OBSERVED_PRESENT'],
      [{ dns_caa_present: false }, 'OBSERVED_ABSENT'],
      [{ dns_caa_present: null, caa_collection_error: 'DNS_TIMEOUT' }, 'NOT_OBSERVED'],
      [{ dns_caa_present: null, caa_collection_error: 'DNS_SERVFAIL' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.scored, true),
  },
  {
    name: 'MTA-STS', adapter: mtastsAdapter, derive: mtastsOutcome, qm: scoreMtaStsQuality, rowIsSuperset: true,
    present: { dns_sts_present: true, dns_collection_error: null, dns_id: '20260101', policy_present: true, policy_fetch_error: null, policy_parse_success: true, policy_mode: 'enforce', policy_max_age: 86400, policy_mx_patterns: ['*.example.com'], policy_mx_count: 1 },
    payloadKey: ['policy_mode', 'enforce'],
    outcomes: [
      [{ dns_sts_present: true, policy_present: true }, 'OBSERVED_PRESENT'],
      [{ dns_sts_present: false, dns_collection_error: null }, 'OBSERVED_ABSENT'],
      [{ dns_sts_present: null, dns_collection_error: 'DNS_TIMEOUT' }, 'NOT_OBSERVED'],
      [{ dns_sts_present: true, policy_present: null, policy_fetch_error: 'CONNECTION_REFUSED' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.scored, true),
  },
  {
    name: 'DKIM', adapter: dkimAdapter, derive: dkimOutcome, qm: scoreDkimQuality, rowIsSuperset: false,
    present: { dkim_present: true, dkim_collection_status: null, dkim_record_count: 1, dkim_selectors_probed: ['google'], dkim_selectors_found: ['google'], dkim_probe_set_version: 1, dkim_keys: [{ parse_success: true, public_key_present: true, key_bits: 2048, key_type: 'rsa', flags: [] }] },
    payloadKey: ['dkim_record_count', 1],
    stripKey: 'dkim_keys',
    outcomes: [
      [{ dkim_present: true }, 'OBSERVED_PRESENT'],
      [{ dkim_present: null, dkim_collection_status: 'NOT_DETECTED' }, 'OBSERVED_ABSENT'],
      [{ dkim_present: null, dkim_collection_status: 'DNS_TIMEOUT' }, 'NOT_OBSERVED'],
      [{ dkim_present: null, dkim_collection_status: 'DNS_FAILURE' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.score, 100),
  },
  {
    name: 'TLS', adapter: tlsAdapter, derive: tlsOutcome, qm: scoreTlsQuality, rowIsSuperset: false, evidenceIsFacts: true,
    present: { endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.3', cipher_suite_standard: 'TLS_AES_128_GCM_SHA256', cipher_key_exchange: null, forward_secrecy: true, alpn_protocol: 'h2', http2_negotiated: true, collected_at: 'T' },
    payloadKeyEvidence: ['negotiated_version', 'TLSv1.3'],
    outcomes: [
      [{ endpoint_state: 'RESPONSE_OBSERVED' }, 'OBSERVED_PRESENT'],
      [{ endpoint_state: 'TLS_ERROR' }, 'COLLECTION_ERROR'],
      [{ endpoint_state: 'CONNECTION_ERROR' }, 'NOT_OBSERVED'],
    ],
    qmExpect: r => assert.equal(r.score, 100),
  },
  {
    name: 'Certificate', adapter: certificateAdapter, derive: certOutcome, qm: scoreCertificateQuality, rowIsSuperset: false, evidenceIsFacts: true,
    present: { endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED', tls_verification_result: 'CHAIN_VERIFIED', tls_error_code: null, leaf_key_type: 'EC', leaf_key_bits: 256, leaf_is_wildcard: false, leaf_is_self_signed: false, leaf_lifetime_days: 90, leaf_days_remaining: 60, leaf_issuer_cn: "Let's Encrypt", leaf_issuer_o: 'LE', leaf_subject_cn: 'example.com', leaf_fingerprint_sha256: 'ab', collected_at: 'T' },
    payloadKeyEvidence: ['tls_verification_result', 'CHAIN_VERIFIED'],
    outcomes: [
      [{ endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED' }, 'OBSERVED_PRESENT'],
      [{ endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'NO_CERTIFICATE' }, 'OBSERVED_ABSENT'],
      [{ endpoint_state: 'CONNECTION_ERROR' }, 'NOT_OBSERVED'],
      [{ endpoint_state: 'TLS_ERROR' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.score, 100),
  },
  {
    name: 'Security Headers', adapter: securityHeadersAdapter, derive: shOutcome, qm: scoreSecurityHeadersQuality, rowIsSuperset: false,
    present: { endpoint_state: 'RESPONSE_OBSERVED', http_probe_state: 'RESPONSE_OBSERVED', signal_version: 'SOT-SECURITYHEADERS-001-v2', collector_version: '2.0.0', https_fetch: { fetch_outcome: 'RESPONSE_OBSERVED' }, http_probe: {}, header_inventory: { strict_transport_security: { present: true }, content_security_policy: { present: true } } },
    payloadKey: ['endpoint_state', 'RESPONSE_OBSERVED'],
    jsonbKey: 'header_inventory',
    outcomes: [
      [{ endpoint_state: 'RESPONSE_OBSERVED' }, 'OBSERVED_PRESENT'],
      [{ endpoint_state: 'TIMEOUT' }, 'NOT_OBSERVED'],
      [{ endpoint_state: 'CONNECTION_ERROR' }, 'NOT_OBSERVED'],
      [{ endpoint_state: 'TLS_ERROR' }, 'COLLECTION_ERROR'],
    ],
    qmExpect: r => assert.equal(r.scored, true),
  },
  {
    name: 'security.txt', adapter: securityTxtAdapter, derive: stOutcome, qm: scoreSecuritytxtQuality, rowIsSuperset: false,
    present: { signal_id: 'securitytxt', signal_version: 1, file_state: 'PRESENT_CANONICAL', canonical_fetch: { fetch_state: 'FOUND' }, legacy_fetch: { fetch_state: 'NOT_FOUND' }, canonical_parse: { fields: {} }, legacy_parse: null, collected_at: 'T' },
    payloadKey: ['file_state', 'PRESENT_CANONICAL'],
    jsonbKey: 'canonical_fetch',
    droppedKey: 'signal_id',
    outcomes: [
      [{ file_state: 'PRESENT_CANONICAL' }, 'OBSERVED_PRESENT'],
      [{ file_state: 'PRESENT_BOTH' }, 'OBSERVED_PRESENT'],
      [{ file_state: 'ABSENT' }, 'OBSERVED_ABSENT'],
      [{ file_state: 'INDETERMINATE' }, 'NOT_OBSERVED'],
    ],
    qmExpect: r => assert.equal(typeof r.scored, 'boolean'),
  },
];

for (const S of SIGNALS) {
  describe(`${S.name} — canonical Observation`, () => {
    const build = (facts) => S.adapter.buildObservation({ domain: 'example.test', facts, run, observedAt: 'T' });

    test('adapter shape: tableName, programme, buildObservation', () => {
      assert.ok(S.adapter.tableName);
      assert.ok(S.adapter.programme.key);
      assert.equal(typeof S.adapter.buildObservation, 'function');
    });

    test('ownership chain + provenance envelope produced', () => {
      const row = build(S.present);
      assert.equal(row.collection_run_id, 'run-1');
      assert.equal(row.collection_programme_id, 'prog-1');
      assert.equal(row.collector, S.adapter.signal);
      assert.ok(row.collector_version);
      assert.ok(row.collection_method);
      assert.equal(row.collected_at, 'T');
      assert.equal(row.organisation_id, null);       // nullable by contract
      assert.ok(['OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED', 'COLLECTION_ERROR'].includes(row.collection_outcome));
    });

    test('payload / raw evidence preserved', () => {
      const row = build(S.present);
      if (S.payloadKey) assert.equal(row[S.payloadKey[0]], S.payloadKey[1]);
      if (S.evidenceIsFacts) assert.deepEqual(row.evidence, S.present);                 // TLS/Cert: full evidence JSONB
      if (S.payloadKeyEvidence) assert.equal(row.evidence[S.payloadKeyEvidence[0]], S.payloadKeyEvidence[1]);
      if (S.jsonbKey) assert.deepEqual(row[S.jsonbKey], S.present[S.jsonbKey]);          // SecHeaders/security.txt JSONB block
      if (S.stripKey) assert.equal(S.stripKey in row, false);                           // DKIM: child-table material excluded
      if (S.droppedKey) assert.equal(S.droppedKey in row, false);                       // security.txt: non-column key dropped
    });

    test('no interpreted value stored', () => {
      const row = build(S.present);
      for (const k of FORBIDDEN) assert.equal(k in row, false, `${S.name} row must not carry '${k}'`);
    });

    test('deriveCollectionOutcome maps every applicable state', () => {
      for (const [facts, expected] of S.outcomes) {
        assert.equal(S.derive(facts), expected, `${S.name}: ${JSON.stringify(facts)} → ${expected}`);
      }
    });

    test('Quality Model unaffected by the envelope', () => {
      const factsResult = S.qm(S.present);
      S.qmExpect(factsResult);
      if (S.rowIsSuperset) {
        // Flat signals: the built row is a superset of the facts, so scoring it
        // must equal scoring the bare facts — the envelope is provably inert.
        assert.deepEqual(S.qm(build(S.present)), factsResult);
      }
    });
  });
}
