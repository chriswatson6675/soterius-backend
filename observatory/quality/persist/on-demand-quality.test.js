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

test('tls — byte-identical, row carries source_run_id', async () => {
  const facts = { domain: 'example.com', endpoint_state: 'RESPONSE_OBSERVED', negotiated_version: 'TLSv1.3', collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreTlsQuality(facts);
  const { client, calls } = fakeClient({ data: { id: 'row-6' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'tls', facts, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-1' }, { client });

  assert.strictEqual(r.result.score, direct.score);
  const insertedRow = calls.find((c) => c[0] === 'insert')[1][0];
  assert.strictEqual(insertedRow.source_run_id, 'collection-run-1');
});

test('certificate — byte-identical for a CHAIN_VERIFIED domain', async () => {
  const facts = { domain: 'example.com', endpoint_state: 'RESPONSE_OBSERVED', certificate_present: 'CERTIFICATE_PRESENTED', tls_verification_result: 'CHAIN_VERIFIED', leaf_key_type: 'RSA', leaf_key_bits: 2048, leaf_is_wildcard: false, leaf_lifetime_days: 90, collected_at: '2026-07-12T00:00:00.000Z' };
  const direct = scoreCertificateQuality(facts);
  const { client } = fakeClient({ data: { id: 'row-7' }, error: null });

  const r = await persistOnDemandQuality({ signal: 'certificate', facts, runId: 'run-1', runLabel: 'label', sourceRunId: 'collection-run-1' }, { client });

  assert.strictEqual(r.result.score, direct.score);
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
