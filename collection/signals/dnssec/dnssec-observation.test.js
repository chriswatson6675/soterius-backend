'use strict';

// Sprint 6 — DNSSEC reference Observation persistence.
// Validates the sprint's six acceptance points without a live DB.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDnssecObservation, deriveCollectionOutcome, persistDnssecObservation,
  OUTCOME, COLLECTOR_VERSION,
} = require('./dnssec-observation');
const { scoreDnssecQuality } = require('../../../observatory/quality/dnssec-quality');

// ── Fixtures: realistic collector outputs (shape of dnssec-collector.js) ─────

const anchoredFacts = {
  dns_ds_present: true, ds_collection_error: null,
  ds_records: [{ key_tag: 12345, algorithm: 13, digest_type: 2, digest: 'abcd' }],
  ds_record_count: 1, ds_algorithms: [13], ds_digest_types: [2], ds_key_tags: [12345],
  dns_dnskey_present: true, dnskey_collection_error: null,
  dnskey_records: [{ flags: 257, protocol: 3, algorithm: 13, public_key: 'AwEAA...' }],
  dnskey_record_count: 1, dnskey_ksk_count: 1, dnskey_zsk_count: 0, dnskey_other_flags_count: 0,
  dnskey_algorithms: [13], dnskey_key_tags: [12345],
};

const unsignedFacts = {
  dns_ds_present: false, ds_collection_error: null, ds_records: [], ds_record_count: 0,
  ds_algorithms: [], ds_digest_types: [], ds_key_tags: [],
  dns_dnskey_present: false, dnskey_collection_error: null, dnskey_records: [], dnskey_record_count: 0,
  dnskey_ksk_count: 0, dnskey_zsk_count: 0, dnskey_other_flags_count: 0,
  dnskey_algorithms: [], dnskey_key_tags: [],
};

const islandFacts = { ...unsignedFacts, dns_dnskey_present: true, dnskey_record_count: 1,
  dnskey_records: [{ flags: 256, protocol: 3, algorithm: 13, public_key: 'x' }], dnskey_algorithms: [13] };

const timeoutFacts = {
  dns_ds_present: null, ds_collection_error: 'DNS_TIMEOUT', ds_records: [], ds_record_count: null,
  ds_algorithms: [], ds_digest_types: [], ds_key_tags: [],
  dns_dnskey_present: null, dnskey_collection_error: 'DNS_TIMEOUT', dnskey_records: [], dnskey_record_count: null,
  dnskey_ksk_count: null, dnskey_zsk_count: null, dnskey_other_flags_count: null,
  dnskey_algorithms: [], dnskey_key_tags: [],
};

const servfailFacts = { ...timeoutFacts, ds_collection_error: 'DNS_SERVFAIL', dnskey_collection_error: 'DNS_SERVFAIL' };

const run = { id: 'run-1', programme_id: 'prog-1' };
const build = (facts, extra = {}) => buildDnssecObservation({ domain: 'example.com', facts, run, observedAt: '2026-01-01T00:00:00.000Z', ...extra });

// ── deriveCollectionOutcome ──────────────────────────────────────────────────

describe('deriveCollectionOutcome — mechanical four-state, never signed-ness', () => {
  test('anchored (DS+DNSKEY present) → OBSERVED_PRESENT', () => assert.equal(deriveCollectionOutcome(anchoredFacts), OUTCOME.OBSERVED_PRESENT));
  test('island (DNSKEY present, DS absent) → OBSERVED_PRESENT (material observed)', () => assert.equal(deriveCollectionOutcome(islandFacts), OUTCOME.OBSERVED_PRESENT));
  test('unsigned (both absent, both resolved) → OBSERVED_ABSENT', () => assert.equal(deriveCollectionOutcome(unsignedFacts), OUTCOME.OBSERVED_ABSENT));
  test('timeout on both axes → NOT_OBSERVED (never ABSENT)', () => {
    assert.equal(deriveCollectionOutcome(timeoutFacts), OUTCOME.NOT_OBSERVED);
    assert.notEqual(deriveCollectionOutcome(timeoutFacts), OUTCOME.OBSERVED_ABSENT);
  });
  test('resolver failure → COLLECTION_ERROR', () => assert.equal(deriveCollectionOutcome(servfailFacts), OUTCOME.COLLECTION_ERROR));
  test('one axis resolved, other timed out → NOT_OBSERVED (incomplete, not a clean absence)', () => {
    const partial = { ...anchoredFacts, dns_dnskey_present: null, dnskey_collection_error: 'DNS_TIMEOUT' };
    assert.equal(deriveCollectionOutcome(partial), OUTCOME.NOT_OBSERVED);
  });
});

// ── Envelope completeness ────────────────────────────────────────────────────

describe('buildDnssecObservation — full envelope populated from the run', () => {
  test('every contract envelope field is present and correctly sourced', () => {
    const obs = build(anchoredFacts);
    assert.equal(obs.collection_run_id, 'run-1');           // Collection Run reference
    assert.equal(obs.collection_programme_id, 'prog-1');    // Collection Programme reference
    assert.equal(obs.collector, 'dnssec');                  // collector identity
    assert.equal(obs.collector_version, COLLECTOR_VERSION); // collector version
    assert.equal(obs.collection_method, 'DoH:cloudflare-dns.com'); // provenance
    assert.equal(obs.collected_at, '2026-01-01T00:00:00.000Z');    // timing (observed_at)
    assert.equal(obs.collection_outcome, 'OBSERVED_PRESENT');      // collection outcome
    assert.equal(obs.signal_version, 1);
  });

  test('organisation_id is nullable and defaults to null (contract P-5)', () => {
    assert.equal(build(anchoredFacts).organisation_id, null);
    assert.equal(build(anchoredFacts).repository_authority_ref, null);
  });

  test('organisation_id is carried through when a resolver eventually supplies it', () => {
    const obs = build(anchoredFacts, { organisationId: 'ORG-ABC', repositoryAuthorityRef: 'ra@2026-01-01' });
    assert.equal(obs.organisation_id, 'ORG-ABC');
    assert.equal(obs.repository_authority_ref, 'ra@2026-01-01');
  });

  test('missing run / facts / domain throw before producing a partial row', () => {
    assert.throws(() => buildDnssecObservation({ domain: 'x', facts: anchoredFacts }), /Collection Run .* is required/);
    assert.throws(() => buildDnssecObservation({ domain: 'x', facts: anchoredFacts, run: { id: 'r' } }), /programme_id/);
    assert.throws(() => buildDnssecObservation({ facts: anchoredFacts, run }), /domain is required/);
  });
});

// ── Raw evidence + observed facts preserved; nothing interpreted stored ──────

describe('evidence preservation and the evidence/interpretation boundary', () => {
  test('raw evidence (ds_records / dnskey_records) is preserved verbatim', () => {
    const obs = build(anchoredFacts);
    assert.deepEqual(obs.ds_records, anchoredFacts.ds_records);
    assert.deepEqual(obs.dnskey_records, anchoredFacts.dnskey_records);
  });

  test('observed facts (derived, mechanical) are preserved', () => {
    const obs = build(anchoredFacts);
    assert.deepEqual(obs.ds_algorithms, [13]);
    assert.deepEqual(obs.dnskey_key_tags, [12345]);
    assert.equal(obs.dnskey_ksk_count, 1);
  });

  test('NOTHING interpreted is stored — no score, band, or Quality-Model label', () => {
    const obs = build(anchoredFacts);
    const forbidden = ['score', 'final_score', 'primary_score', 'primary_label',
      'quality_version', 'risk_band', 'grade', 'rating'];
    for (const key of forbidden) assert.equal(key in obs, false, `Observation must not carry '${key}'`);
  });
});

// ── One Collection Run owns many Observations ────────────────────────────────

describe('one Collection Run owns many Observations', () => {
  test('observations for different domains under one run share run+programme, differ by domain', () => {
    const a = buildDnssecObservation({ domain: 'a.com', facts: anchoredFacts, run });
    const b = buildDnssecObservation({ domain: 'b.com', facts: unsignedFacts, run });
    assert.equal(a.collection_run_id, b.collection_run_id);
    assert.equal(a.collection_programme_id, b.collection_programme_id);
    assert.notEqual(a.domain, b.domain);
    assert.equal(a.collection_outcome, 'OBSERVED_PRESENT');
    assert.equal(b.collection_outcome, 'OBSERVED_ABSENT');
  });
});

// ── The existing DNSSEC Quality Model still functions unchanged ──────────────

describe('DNSSEC Quality Model is unaffected by the envelope', () => {
  test('scoring the full Observation row === scoring the bare facts (envelope is inert to the QM)', () => {
    for (const facts of [anchoredFacts, unsignedFacts, islandFacts, timeoutFacts]) {
      const obs = build(facts);
      assert.deepEqual(scoreDnssecQuality(obs), scoreDnssecQuality(facts));
    }
  });

  test('anchored still scores 100; unsigned 0; island 40; timeout not scored (regression pin)', () => {
    assert.equal(scoreDnssecQuality(build(anchoredFacts)).score, 100);
    assert.equal(scoreDnssecQuality(build(unsignedFacts)).score, 0);
    assert.equal(scoreDnssecQuality(build(islandFacts)).score, 40);
    assert.equal(scoreDnssecQuality(build(timeoutFacts)).scored, false);
  });
});

// ── Persistence (fake client) ────────────────────────────────────────────────

describe('persistDnssecObservation — inserts into signal_facts_dnssec', () => {
  function fakeClient(result) {
    const calls = [];
    const builder = {
      from(t)   { calls.push(['from', t]);  return builder; },
      insert(r) { calls.push(['insert', r]); return builder; },
      select(c) { calls.push(['select', c]); return builder; },
      single()  { calls.push(['single']);    return Promise.resolve(result); },
    };
    return { client: builder, calls };
  }

  test('persists the built row and returns its id', async () => {
    const { client, calls } = fakeClient({ data: { id: 'obs-1' }, error: null });
    const result = await persistDnssecObservation({ domain: 'example.com', facts: anchoredFacts, run }, client);
    assert.deepEqual(result, { success: true, id: 'obs-1' });
    assert.deepEqual(calls[0], ['from', 'signal_facts_dnssec']);
    const inserted = calls[1][1][0];
    assert.equal(inserted.collection_run_id, 'run-1');
    assert.equal(inserted.collector, 'dnssec');
    assert.equal(inserted.collection_outcome, 'OBSERVED_PRESENT');
  });

  test('surfaces a DB error without throwing', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'insert failed' } });
    const result = await persistDnssecObservation({ domain: 'example.com', facts: anchoredFacts, run }, client);
    assert.deepEqual(result, { success: false, error: 'insert failed' });
  });
});
