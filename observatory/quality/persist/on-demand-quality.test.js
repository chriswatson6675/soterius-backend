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

// Sequence-aware variant (matches observation-session.test.js's own fakeClient):
// DKIM's reconstructFacts issues a genuine child-table SELECT (resolved via
// awaiting the builder itself, through .then()) BEFORE the eventual quality
// INSERT (resolved via .single()) — two distinct queries need two distinct
// canned results, consumed in order.
function fakeSequencedClient(results) {
  const queue = Array.isArray(results) ? [...results] : [results];
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

// Realistic signal_facts_dkim row: dkim_keys is NEVER a column on this table
// — dkim-observation.js strips it before insert and fans it out to the
// child table signal_facts_dkim_keys. This is what .select('*') on
// signal_facts_dkim actually returns.
// Regression fixture for the DKIM Quality Model boundary audit (2026-07-17):
// distinct id vs. collection_run_id, so a test asserting the WRONG one is
// used (the actual historical defect) fails clearly rather than passing
// vacuously. persistDkimKeys (dkim-observation.js, fixed in 99f66f0) writes
// signal_facts_dkim_keys.dkim_run_id = the parent row's own id — this
// module's reconstructFacts must read it back the same way.
function dkimPersistedRow(overrides = {}) {
  return {
    id: 'facts-row-parent-id', domain: 'example.com',
    collection_run_id: 'collection-run-1-NOT-THE-FK-VALUE', collection_programme_id: 'programme-1',
    collector: 'dkim', collector_version: 'dkim-collector@1.0.0', collection_method: 'DNS',
    organisation_id: null, repository_authority_ref: null, collection_outcome: 'OBSERVED_PRESENT',
    signal_version: 1, collected_at: '2026-07-12T00:00:00.000Z',
    dkim_present: true, dkim_collection_status: 'OK',
    dkim_selectors_found: ['default'],
    // dkim_keys: intentionally ABSENT — not a column on this table at all.
    ...overrides,
  };
}

function dkimKeyRow(selector, overrides = {}) {
  return {
    selector, raw_record: `v=DKIM1; k=rsa; p=${selector}`, parse_success: true, version: 'DKIM1',
    key_type: 'rsa', key_bits: 2048, public_key_present: true, hash_algorithms: ['sha256'],
    service_type: '*', flags: [], syntax_errors: [],
    ...overrides,
  };
}

test('dkim — realistic persisted row (dkim_keys absent, read back from the child table) scores correctly', async () => {
  const persistedRow = dkimPersistedRow();
  const childKeyRows = [dkimKeyRow('default')];

  const expected = scoreDkimQuality({ ...persistedRow, dkim_keys: childKeyRows });
  assert.strictEqual(expected.scored, true);
  assert.strictEqual(expected.primaryLabel, '>=2048', 'sanity: this fixture exercises the exact case the missing child-table read broke');

  // Proves the fix matters: scoring the raw persisted row with no key
  // read-back — the pre-fix behaviour — defaults dkim_keys to [] and always
  // reports "no usable key", regardless of the domain's real key strength.
  const withoutReconstruction = scoreDkimQuality(persistedRow);
  assert.strictEqual(withoutReconstruction.scored, true);
  assert.strictEqual(withoutReconstruction.primaryLabel, 'no usable key (bounded)');
  assert.notStrictEqual(withoutReconstruction.score, expected.score);

  const { client, calls } = fakeSequencedClient([
    { data: childKeyRows, error: null },      // the child-table SELECT
    { data: { id: 'row-2' }, error: null },   // the signal_quality_dkim INSERT
  ]);

  const r = await persistOnDemandQuality({ signal: 'dkim', facts: persistedRow, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.result.score, expected.score);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.max_key_bits, expected.maxBits);
  const childSelect = calls.find((c) => c[0] === 'from' && c[1] === 'signal_facts_dkim_keys');
  assert.ok(childSelect, 'must query the child table before scoring');

  // The actual historical defect: reconstructFacts must join on the PARENT
  // ROW's own id (the real dkim_run_id FK target), never collection_run_id.
  // A test that only checks "some eq() call happened" would pass whichever
  // value was used — this asserts the specific value.
  const eqCall = calls.find((c) => c[0] === 'eq' && c[1] === 'dkim_run_id');
  assert.ok(eqCall, 'must filter the child-table query by dkim_run_id');
  assert.strictEqual(eqCall[2], persistedRow.id, 'must join on the parent row\'s own id (the real FK target)');
  assert.notStrictEqual(eqCall[2], persistedRow.collection_run_id, 'must NOT join on collection_run_id — that was the historical defect');
});

test('dkim — no selector discovered at all: legitimate absence, scores as the existing governed "no usable key" outcome, NOT incomplete', async () => {
  const persistedRow = dkimPersistedRow({ dkim_present: null, dkim_collection_status: 'NOT_DETECTED', dkim_selectors_found: [] });
  const { client, calls } = fakeSequencedClient([
    { data: [], error: null },                // child-table SELECT — genuinely nothing to find
    { data: { id: 'row-2' }, error: null },
  ]);

  const r = await persistOnDemandQuality({ signal: 'dkim', facts: persistedRow, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.persisted, true, 'a genuine "nothing found" must still score — it is a valid scoreable observation, not incomplete evidence');
  assert.strictEqual(r.result.primaryLabel, 'no usable key (bounded)');
  assert.strictEqual(r.result.score, 0);
});

test('dkim — selectors discovered but child persistence completely failed: blocked from scoring as a false full success', async () => {
  const persistedRow = dkimPersistedRow({ dkim_selectors_found: ['default', 'google'] });
  const { client, calls } = fakeSequencedClient([
    { data: [], error: null },                // child-table SELECT — nothing actually persisted (total failure)
    { data: { id: 'row-2' }, error: null },
  ]);

  const r = await persistOnDemandQuality({ signal: 'dkim', facts: persistedRow, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.persisted, false, 'must NOT be scored as a clean success when the collector found selectors but zero were actually persisted');
  assert.strictEqual(r.result.scored, false);
  assert.strictEqual(r.result.reason, 'CHILD_EVIDENCE_INCOMPLETE');
  assert.strictEqual(r.result.score, null);
  assert.strictEqual(calls.some((c) => c[0] === 'insert'), false, 'no quality row is written for incomplete evidence');
});

test('dkim — selectors discovered but only some child rows persisted (partial failure): also blocked, not silently scored on the partial set', async () => {
  const persistedRow = dkimPersistedRow({ dkim_selectors_found: ['default', 'google', 'k2'] });
  const { client } = fakeSequencedClient([
    { data: [dkimKeyRow('default')], error: null }, // only 1 of 3 discovered selectors actually persisted
    { data: { id: 'row-2' }, error: null },
  ]);

  const r = await persistOnDemandQuality({ signal: 'dkim', facts: persistedRow, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.persisted, false);
  assert.strictEqual(r.result.reason, 'CHILD_EVIDENCE_INCOMPLETE');
});

test('dkim — a malformed/unusable key that DID fully persist is still scored via the existing governed model, not treated as incomplete', async () => {
  // parse_success: false is a real, already-governed outcome (M1 multiplier /
  // "no usable key" floor) inside scoreDkimQuality itself — this must remain
  // untouched by the completeness gate, which only compares COUNTS, not
  // key validity.
  const persistedRow = dkimPersistedRow({ dkim_selectors_found: ['default'] });
  const malformedKey = dkimKeyRow('default', { parse_success: false, public_key_present: false, key_bits: null });
  const { client } = fakeSequencedClient([
    { data: [malformedKey], error: null },   // the one discovered selector DID persist — just isn't usable
    { data: { id: 'row-2' }, error: null },
  ]);

  const expected = scoreDkimQuality({ ...persistedRow, dkim_keys: [malformedKey] });
  const r = await persistOnDemandQuality({ signal: 'dkim', facts: persistedRow, runId: 'run-1', runLabel: 'label' }, { client });

  assert.strictEqual(r.persisted, true, 'a fully-persisted-but-unusable key is a valid scoreable observation, not incomplete evidence');
  assert.strictEqual(r.result.primaryLabel, expected.primaryLabel);
  assert.strictEqual(r.result.score, expected.score);
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
