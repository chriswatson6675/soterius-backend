'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { persistOnDemandQuality, SIGNALS } = require('./on-demand-quality');

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

// Same chainable fake-Supabase-builder pattern used throughout this codebase
// (observation-session.test.js, collection-session.test.js).
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

test('all ten signals have an adapter registered', () => {
  assert.deepStrictEqual(
    SIGNALS.slice().sort(),
    ['caa', 'certificate', 'dkim', 'dmarc', 'dnssec', 'mtasts', 'securityheaders', 'securitytxt', 'spf', 'tls'],
  );
});

// ── Byte-identity: the adapter never re-implements a model — it must produce
//    the exact score a direct call to score*Quality() produces (ENG-007 §7). ──

test('spf — persisted final_score matches a direct scoreSpfQuality() call', async () => {
  const facts = { domain: 'example.com', spf_present: true, spf_mechanism: '-all', spf_syntax_errors: [], collected_at: '2026-07-12T00:00:00.000Z', signal_version: 1 };
  const direct = scoreSpfQuality(facts);
  const { client, calls } = fakeClient({ data: { id: 'row-1' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'spf', facts, runId: 'run-1', runLabel: 'ONDEMAND-QUALITY-spf-example.com' }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.result.score, direct.score);
  assert.strictEqual(r.result.primaryLabel, direct.primaryLabel);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.final_score, direct.score);
  assert.strictEqual(insertedRow.domain, 'example.com');
  assert.deepStrictEqual(calls[0], ['from', 'signal_quality_spf']);
});

test('spf — unobserved facts are not persisted (Unknown ≠ Absent)', async () => {
  const facts = { domain: 'example.com', spf_present: null };
  const { client, calls } = fakeClient({ data: null, error: null });

  const r = await persistOnDemandQuality({ signal: 'spf', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, false);
  assert.strictEqual(r.result.scored, false);
  assert.strictEqual(calls.some((c) => c[0] === 'insert'), false, 'no insert attempted for an unscored observation');
});

test('dkim — byte-identical to a direct scoreDkimQuality() call', async () => {
  const facts = { domain: 'example.com', dkim_collection_status: 'OK', dkim_keys: [{ parse_success: true, public_key_present: true, key_bits: 2048, flags: [] }], collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreDkimQuality(facts);
  const { client, calls } = fakeClient({ data: { id: 'row-2' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'dkim', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.max_key_bits, direct.maxBits);
});

test('dmarc — byte-identical, and dmarc_policy is null for a floor state', async () => {
  const facts = { domain: 'example.com', dmarc_present: false, collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreDmarcQuality(facts);
  const { client, calls } = fakeClient({ data: { id: 'row-3' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'dmarc', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.dmarc_policy, null, 'absent is not one of reject/quarantine/none');
});

test('dnssec — byte-identical for an ANCHORED domain', async () => {
  const facts = { domain: 'example.com', dns_ds_present: true, dns_dnskey_present: true, ds_digest_types: [2], dnskey_algorithms: [8], collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreDnssecQuality(facts);
  const { client } = fakeClient({ data: { id: 'row-4' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'dnssec', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  assert.strictEqual(r.result.primaryLabel, 'ANCHORED');
});

test('mtasts — byte-identical for an ENFORCE domain', async () => {
  const facts = { domain: 'example.com', dns_sts_present: true, policy_present: true, policy_parse_success: true, policy_mode: 'enforce', policy_max_age: 604800, collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreMtaStsQuality(facts);
  const { client } = fakeClient({ data: { id: 'row-5' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'mtasts', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.result.score, direct.score);
});

// TLS's realistic signal_tls_v1 row: promotedScalars() (tls-extractor.js)
// never sets cipher_key_exchange at the top level — it lives only inside
// `evidence`, the full extractor output. This is what .select('*') actually
// returns, and this fixture models it exactly (not a hand-flattened object).
test('tls — realistic persisted row (cipher_key_exchange absent at top level, present only in evidence) scores correctly', async () => {
  const persistedRow = {
    id: 'obs-1', domain: 'example.com', run_id: 'collector-run-1',
    collection_run_id: 'collection-run-1', collection_programme_id: 'programme-1',
    collector: 'tls', collector_version: 'tls-extractor@1.0.0', collection_method: 'TLS',
    organisation_id: null, repository_authority_ref: null, collection_outcome: 'OBSERVED_PRESENT',
    signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
    endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.2',
    cipher_suite_standard: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    forward_secrecy: true, alpn_protocol: 'h2', http2_negotiated: true,
    // cipher_key_exchange: intentionally ABSENT at top level — this is the
    // real shape promotedScalars() produces.
    evidence: {
      endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.2',
      cipher_suite_openssl: 'ECDHE-RSA-AES128-GCM-SHA256',
      cipher_suite_standard: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      cipher_key_exchange: 'ECDHE', cipher_symmetric_alg: 'AES_128_GCM', cipher_mac_hash: 'SHA256',
      forward_secrecy: true, alpn_protocol: 'h2', http2_negotiated: true,
    },
  };

  const expected = scoreTlsQuality({
    endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.2',
    cipher_suite_standard: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    cipher_key_exchange: 'ECDHE', alpn_protocol: 'h2', http2_negotiated: true,
  });
  assert.strictEqual(expected.scored, true);
  assert.strictEqual(expected.primaryLabel, 'UPPER_MIDDLE', 'sanity: this fixture exercises the exact case the missing reconstruction broke');

  // Proves the fix matters: scoring the RAW persisted row with no
  // reconstruction — the pre-fix behaviour — produces the wrong result.
  const withoutReconstruction = scoreTlsQuality(persistedRow);
  assert.strictEqual(withoutReconstruction.scored, false);
  assert.strictEqual(withoutReconstruction.reason, 'NOT_CLASSIFIABLE');

  const { client, calls } = fakeClient({ data: { id: 'row-6' }, error: null });
  const r = await persistOnDemandQuality({ signal: 'tls', facts: persistedRow, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-1' }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.result.score, expected.score);
  assert.strictEqual(r.result.primaryLabel, 'UPPER_MIDDLE');
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.source_run_id, 'collection-run-1');
  assert.strictEqual(insertedRow.collected_at, '2026-07-12T00:00:00.000Z', "buildRow still reads metadata from the ORIGINAL row, not the narrowed scoring facts");
});

// Certificate's realistic signal_certificate_v1 row: the PRIMARY gate
// (tls_verification_result) plus leaf_key_type/leaf_key_bits/leaf_key_curve/
// leaf_lifetime_days all live only inside `evidence` — none are promoted
// columns (migration 015). This fixture models exactly what .select('*')
// returns, not a hand-flattened object.
test('certificate — realistic persisted row (primary gate + multiplier inputs only in evidence) scores correctly', async () => {
  const persistedRow = {
    id: 'obs-2', domain: 'example.com', run_id: 'collector-run-2',
    collection_run_id: 'collection-run-2', collection_programme_id: 'programme-2',
    collector: 'certificate', collector_version: 'certificate-extractor@1.0.0', collection_method: 'TLS',
    organisation_id: null, repository_authority_ref: null, collection_outcome: 'OBSERVED_PRESENT',
    signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
    endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED',
    tls_error_code: null, leaf_days_remaining: 60,
    leaf_issuer_cn: "Let's Encrypt", leaf_issuer_o: "Let's Encrypt",
    leaf_subject_cn: 'example.com', leaf_is_self_signed: false, leaf_is_wildcard: false,
    leaf_fingerprint_sha256: 'abc123',
    // tls_verification_result/leaf_key_type/leaf_key_bits/leaf_key_curve/
    // leaf_lifetime_days: intentionally ABSENT at top level.
    evidence: {
      tls_verification_result: 'CHAIN_VERIFIED', leaf_key_type: 'RSA', leaf_key_bits: 2048,
      leaf_key_curve: null, leaf_lifetime_days: 90,
    },
  };

  const expected = scoreCertificateQuality({
    endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED',
    tls_verification_result: 'CHAIN_VERIFIED', leaf_key_type: 'RSA', leaf_key_bits: 2048,
    leaf_key_curve: null, leaf_is_wildcard: false, leaf_is_self_signed: false, leaf_lifetime_days: 90,
  });
  assert.strictEqual(expected.scored, true);
  assert.strictEqual(expected.primaryLabel, 'CEILING', 'sanity: this fixture exercises the exact case the missing reconstruction broke');

  // Proves the fix matters: scoring the RAW persisted row with no
  // reconstruction — the pre-fix behaviour — never even finds a verification
  // result and always returns INVALID_OBSERVATION.
  const withoutReconstruction = scoreCertificateQuality(persistedRow);
  assert.strictEqual(withoutReconstruction.scored, false);
  assert.strictEqual(withoutReconstruction.reason, 'INVALID_OBSERVATION');

  const { client } = fakeClient({ data: { id: 'row-7' }, error: null });
  const r = await persistOnDemandQuality({ signal: 'certificate', facts: persistedRow, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-2' }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.result.score, expected.score);
  assert.strictEqual(r.result.primaryLabel, 'CEILING');
});

test('securitytxt — byte-identical for a CEILING domain', async () => {
  const facts = {
    domain: 'example.com', file_state: 'FOUND', collected_at: '2026-07-12T00:00:00.000Z',
    canonical_fetch: { fetch_state: 'FOUND', content_type: 'text/plain' },
    canonical_parse: { contact: ['mailto:security@example.com'], expires: ['2030-01-01T00:00:00.000Z'] },
    legacy_fetch: null, legacy_parse: null,
  };
  const direct = scoreSecuritytxtQuality(facts);
  const { client } = fakeClient({ data: { id: 'row-8' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'securitytxt', facts, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-1' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  assert.strictEqual(r.result.primaryLabel, 'CEILING');
});

test('securityheaders — byte-identical, no primary_score/primary_label column written', async () => {
  const facts = {
    domain: 'example.com', endpoint_state: 'RESPONSE_OBSERVED', collected_at: '2026-07-12T00:00:00.000Z',
    header_inventory: { strict_transport_security: { present: true }, content_security_policy: { present: true } },
  };
  const direct = scoreSecurityHeadersQuality(facts);
  const { client, calls } = fakeClient({ data: { id: 'row-9' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'securityheaders', facts, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-1' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual('primary_score' in insertedRow, false);
  assert.strictEqual('primary_label' in insertedRow, false);
});

// ── CAA — population-aware scoring, and the UNCALIBRATED_STATE_PROHIBITED skip. ──

test('caa — self RRset, byte-identical to a direct scoreCaaQuality() call with the same population', async () => {
  const facts = { domain: 'example.com', dns_caa_present: true, caa_records: [{ tag: 'issue', value: 'letsencrypt.org', flags: 0 }], collected_at: '2026-07-12T00:00:00.000Z' };
  const population = new Map([['example.com', facts]]);
  const direct = scoreCaaQuality(facts, population);
  const { client, calls } = fakeClient({ data: { id: 'row-10' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'caa', facts, runId: 'run-1', runLabel: 'label', population }, { client });

  assert.strictEqual(r.result.score, direct.score);
  assert.strictEqual(r.result.source, 'self');
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.record_source, 'self');
  assert.ok(insertedRow.baseline_sha256, 'a per-domain evidence hash substitutes for the batch baseline SHA');
});

test('caa — inherits from an ancestor supplied via the population map', async () => {
  const ancestorFacts = { domain: 'example.com', dns_caa_present: true, caa_records: [{ tag: 'issue', value: 'letsencrypt.org', flags: 0 }], collected_at: '2026-07-12T00:00:00.000Z' };
  const facts = { domain: 'mail.example.com', dns_caa_present: false, caa_records: [], collected_at: '2026-07-12T00:00:00.000Z' };
  const population = new Map([['example.com', ancestorFacts], ['mail.example.com', facts]]);
  const direct = scoreCaaQuality(facts, population);
  const { client, calls } = fakeClient({ data: { id: 'row-11' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'caa', facts, runId: 'run-1', runLabel: 'label', population }, { client });

  assert.strictEqual(r.result.score, direct.score);
  assert.strictEqual(r.result.source, 'ancestor');
  assert.strictEqual(r.result.inheritedFrom, 'example.com');
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.inherited_from, 'example.com');
});

test('caa — UNCALIBRATED_STATE_PROHIBITED is skipped (not persisted, not fabricated as null score)', async () => {
  const facts = { domain: 'example.com', dns_caa_present: true, caa_records: [{ tag: 'issue', value: ';', flags: 0 }], collected_at: '2026-07-12T00:00:00.000Z' };
  const { client, calls } = fakeClient({ data: null, error: null });

  const r = await persistOnDemandQuality({ signal: 'caa', facts, runId: 'run-1', runLabel: 'label', population: new Map() }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, false);
  assert.strictEqual(r.result.reason, 'UNCALIBRATED_STATE_PROHIBITED');
  assert.strictEqual(calls.some((c) => c[0] === 'insert'), false);
});

test('caa — missing population defaults to an empty Map, never crashes', async () => {
  const facts = { domain: 'example.com', dns_caa_present: false, caa_records: [], collected_at: '2026-07-12T00:00:00.000Z' };
  const { client } = fakeClient({ data: { id: 'row-12' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'caa', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.source, 'none');
});

// ── Error handling ──────────────────────────────────────────────────────────

test('unknown signal is rejected without touching the client', async () => {
  const r = await persistOnDemandQuality({ signal: 'nope', facts: { domain: 'x.com' }, runId: 'r', runLabel: 'l' }, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no on-demand quality adapter/);
});

test('a DB insert failure is surfaced, not swallowed', async () => {
  const facts = { domain: 'example.com', spf_present: true, spf_mechanism: '-all', collected_at: '2026-07-12T00:00:00.000Z' };
  const { client } = fakeClient({ data: null, error: { message: 'connection refused' } });

  const r = await persistOnDemandQuality({ signal: 'spf', facts, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /connection refused/);
});
