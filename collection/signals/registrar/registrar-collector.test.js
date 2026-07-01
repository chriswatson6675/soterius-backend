'use strict';

// registrar-collector.test.js — SOT-REGISTRAR-001 Test Suite
//
// Tests use injectable mocks exclusively.
// No live HTTP requests or database calls are made in this suite.
//
// Coverage:
//   1. _parseIanaHtml — HTML table parsing
//   2. assessRegistrar — all four query outcome states
//   3. Evidence block — field completeness, Amendment 1 vocabulary separation
//   4. extractPromotedScalars — scalar column extraction
//   5. downloadIanaDataset — retry and error handling
//   6. runCollector — orchestration and metrics
//
// Usage: node --test backend/signal-lab/signals/registrar/registrar-collector.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessRegistrar,
  downloadIanaDataset,
  runCollector,
  extractPromotedScalars,
  QUERY_OUTCOMES,
  ACCREDITATION_STATUS,
  _parseIanaHtml,
} = require('./registrar-collector');

// ── Evidence schema ───────────────────────────────────────────────────────────

const EXPECTED_EVIDENCE_KEYS = new Set([
  'icann_query_outcome',
  'registrar_accreditation_status',
  'registrar_iana_id',
  'registrar_name',
  'registrar_accreditation_date',
  'registrar_raa_version',
  'registrar_country_code',
  'registrar_country_name',
  'registrar_registrant_country_alignment',
  'registrar_ssad_participant',
  'registrar_abuse_email_published',
  'registrar_abuse_telephone_published',
  'registrar_whois_policy_published',
  'registrar_registration_agreement_published',
  'icann_query_timestamp',
  'icann_query_iana_id',
]);

function assertEvidenceSchema(evidence) {
  const keys = new Set(Object.keys(evidence));
  for (const k of EXPECTED_EVIDENCE_KEYS) {
    assert.ok(keys.has(k), `Evidence missing field: ${k}`);
  }
  for (const k of keys) {
    assert.ok(EXPECTED_EVIDENCE_KEYS.has(k), `Evidence has unexpected field: ${k}`);
  }
  assert.equal(keys.size, 16, `Evidence must have exactly 16 fields; got ${keys.size}`);
}

// ── Mock IANA HTML fixtures ───────────────────────────────────────────────────

function makeIanaHtml(rows) {
  const trRows = rows.map(([id, name, status, rdap = '']) =>
    `<tr><td>${id}</td><td>${name}</td><td>${status}</td><td>${rdap}</td></tr>`,
  ).join('\n');
  return `<html><body><table><tbody>\n${trRows}\n</tbody></table></body></html>`;
}

const SAMPLE_HTML = makeIanaHtml([
  ['146', 'GoDaddy.com, LLC', 'Accredited', 'https://rdap.godaddy.com/v1/'],
  ['292', 'MarkMonitor Inc.', 'Accredited', 'https://rdap.markmonitor.com/rdap/'],
  ['4',   'Advanced Systems Consulting, Inc.', 'Terminated', ''],
  ['1',   'Reserved', 'Reserved', ''],
  ['999', 'Example Registrar', 'Accredited', ''],
]);

// ── 1. _parseIanaHtml ─────────────────────────────────────────────────────────

describe('_parseIanaHtml', () => {
  test('parses accredited registrar rows', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const entry = lookup.get('146');
    assert.ok(entry, 'IANA ID 146 should be in lookup');
    assert.equal(entry.name, 'GoDaddy.com, LLC');
    assert.equal(entry.accreditationStatus, ACCREDITATION_STATUS.ACCREDITED);
  });

  test('parses terminated registrar', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const entry = lookup.get('4');
    assert.ok(entry, 'IANA ID 4 should be in lookup');
    assert.equal(entry.accreditationStatus, ACCREDITATION_STATUS.TERMINATED);
  });

  test('maps Reserved status to null accreditationStatus', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const entry = lookup.get('1');
    assert.ok(entry, 'IANA ID 1 (Reserved) should be in lookup');
    assert.equal(entry.accreditationStatus, null);
  });

  test('returns total row count', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    assert.equal(lookup.size, 5);
  });

  test('ignores header rows (no numeric first cell)', () => {
    const html = makeIanaHtml([['not-a-number', 'Name', 'Status']]);
    const lookup = _parseIanaHtml(html);
    assert.equal(lookup.size, 0);
  });

  test('handles HTML entities in registrar names', () => {
    const html = makeIanaHtml([['200', 'Test &amp; Co', 'Accredited']]);
    const lookup = _parseIanaHtml(html);
    assert.equal(lookup.get('200')?.name, 'Test & Co');
  });
});

// ── 2. assessRegistrar — QUERY_SUCCESS (Accredited) ──────────────────────────

describe('assessRegistrar — QUERY_SUCCESS (Accredited)', () => {
  let lookup;
  test.before(() => {
    lookup = _parseIanaHtml(SAMPLE_HTML);
  });

  test('returns QUERY_SUCCESS outcome for known accredited IANA ID', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.QUERY_SUCCESS);
  });

  test('sets registrar_accreditation_status to ACCREDITED', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_accreditation_status, ACCREDITATION_STATUS.ACCREDITED);
  });

  test('sets registrar_name from IANA dataset', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_name, 'GoDaddy.com, LLC');
  });

  test('sets registrar_iana_id to the queried ID', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_iana_id, '146');
  });

  test('sets icann_query_iana_id to the queried ID', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.icann_query_iana_id, '146');
  });

  test('icann_query_timestamp is a valid ISO 8601 timestamp', () => {
    const ev = assessRegistrar('146', lookup);
    assert.ok(ev.icann_query_timestamp, 'timestamp should be present');
    assert.doesNotThrow(() => new Date(ev.icann_query_timestamp));
    assert.notEqual(new Date(ev.icann_query_timestamp).getTime(), NaN);
  });

  test('evidence block has exactly 16 fields', () => {
    const ev = assessRegistrar('146', lookup);
    assertEvidenceSchema(ev);
  });

  test('v1.0 source-limited fields are null (country, date, raa, ssad, abuse)', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_country_code, null);
    assert.equal(ev.registrar_country_name, null);
    assert.equal(ev.registrar_accreditation_date, null);
    assert.equal(ev.registrar_raa_version, null);
    assert.equal(ev.registrar_ssad_participant, null);
    assert.equal(ev.registrar_abuse_email_published, null);
    assert.equal(ev.registrar_abuse_telephone_published, null);
  });

  test('Scope 3 fields are always null in v1.0', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_whois_policy_published, null);
    assert.equal(ev.registrar_registration_agreement_published, null);
  });

  test('registrar_registrant_country_alignment is null (country_code null)', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.registrar_registrant_country_alignment, null);
  });
});

// ── 3. assessRegistrar — QUERY_SUCCESS (Terminated) ──────────────────────────

describe('assessRegistrar — QUERY_SUCCESS (Terminated)', () => {
  let lookup;
  test.before(() => {
    lookup = _parseIanaHtml(SAMPLE_HTML);
  });

  test('returns QUERY_SUCCESS for terminated registrar', () => {
    const ev = assessRegistrar('4', lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.QUERY_SUCCESS);
  });

  test('sets registrar_accreditation_status to TERMINATED', () => {
    const ev = assessRegistrar('4', lookup);
    assert.equal(ev.registrar_accreditation_status, ACCREDITATION_STATUS.TERMINATED);
  });

  test('evidence block has exactly 16 fields', () => {
    const ev = assessRegistrar('4', lookup);
    assertEvidenceSchema(ev);
  });
});

// ── 4. assessRegistrar — NOT_FOUND ───────────────────────────────────────────

describe('assessRegistrar — NOT_FOUND', () => {
  let lookup;
  test.before(() => {
    lookup = _parseIanaHtml(SAMPLE_HTML);
  });

  test('returns NOT_FOUND for unknown IANA ID', () => {
    const ev = assessRegistrar('9999', lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.NOT_FOUND);
  });

  test('registrar_accreditation_status is null (Amendment 1)', () => {
    const ev = assessRegistrar('9999', lookup);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_name is null for NOT_FOUND', () => {
    const ev = assessRegistrar('9999', lookup);
    assert.equal(ev.registrar_name, null);
  });

  test('registrar_iana_id is set to the queried ID', () => {
    const ev = assessRegistrar('9999', lookup);
    assert.equal(ev.registrar_iana_id, '9999');
  });

  test('Reserved entry treated as NOT_FOUND (no valid accreditation status)', () => {
    const ev = assessRegistrar('1', lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.NOT_FOUND);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('evidence block has exactly 16 fields', () => {
    const ev = assessRegistrar('9999', lookup);
    assertEvidenceSchema(ev);
  });
});

// ── 5. assessRegistrar — IANA_ID_ABSENT ──────────────────────────────────────

describe('assessRegistrar — IANA_ID_ABSENT', () => {
  let lookup;
  test.before(() => {
    lookup = _parseIanaHtml(SAMPLE_HTML);
  });

  test('returns IANA_ID_ABSENT when ianaId is null', () => {
    const ev = assessRegistrar(null, lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.IANA_ID_ABSENT);
  });

  test('returns IANA_ID_ABSENT when ianaId is undefined', () => {
    const ev = assessRegistrar(undefined, lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.IANA_ID_ABSENT);
  });

  test('registrar_accreditation_status is null (Amendment 1)', () => {
    const ev = assessRegistrar(null, lookup);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_iana_id is null', () => {
    const ev = assessRegistrar(null, lookup);
    assert.equal(ev.registrar_iana_id, null);
  });

  test('icann_query_iana_id is null', () => {
    const ev = assessRegistrar(null, lookup);
    assert.equal(ev.icann_query_iana_id, null);
  });

  test('evidence block has exactly 16 fields', () => {
    const ev = assessRegistrar(null, lookup);
    assertEvidenceSchema(ev);
  });
});

// ── 6. assessRegistrar — QUERY_ERROR (null lookup) ───────────────────────────

describe('assessRegistrar — QUERY_ERROR (dataset unavailable)', () => {
  test('returns QUERY_ERROR when lookup is null', () => {
    const ev = assessRegistrar('146', null);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.QUERY_ERROR);
  });

  test('registrar_accreditation_status is null (Amendment 1)', () => {
    const ev = assessRegistrar('146', null);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_iana_id is preserved even on QUERY_ERROR', () => {
    const ev = assessRegistrar('146', null);
    assert.equal(ev.registrar_iana_id, '146');
  });

  test('icann_query_timestamp is always present', () => {
    const ev = assessRegistrar('146', null);
    assert.ok(ev.icann_query_timestamp);
    assert.doesNotThrow(() => new Date(ev.icann_query_timestamp));
  });

  test('evidence block has exactly 16 fields', () => {
    const ev = assessRegistrar('146', null);
    assertEvidenceSchema(ev);
  });
});

// ── 7. Amendment 1 — vocabulary separation invariants ────────────────────────

describe('Amendment 1 — vocabulary separation (icann_query_outcome vs registrar_accreditation_status)', () => {
  let lookup;
  test.before(() => {
    lookup = _parseIanaHtml(SAMPLE_HTML);
  });

  test('registrar_accreditation_status is null for NOT_FOUND', () => {
    const ev = assessRegistrar('9999', lookup);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_accreditation_status is null for QUERY_ERROR', () => {
    const ev = assessRegistrar('146', null);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_accreditation_status is null for IANA_ID_ABSENT', () => {
    const ev = assessRegistrar(null, lookup);
    assert.equal(ev.registrar_accreditation_status, null);
  });

  test('registrar_accreditation_status is non-null only for QUERY_SUCCESS', () => {
    const ev = assessRegistrar('146', lookup);
    assert.equal(ev.icann_query_outcome, QUERY_OUTCOMES.QUERY_SUCCESS);
    assert.notEqual(ev.registrar_accreditation_status, null);
  });

  test('icann_query_outcome is never null', () => {
    for (const [id, lk] of [
      ['146', lookup],   // QUERY_SUCCESS
      ['9999', lookup],  // NOT_FOUND
      [null, lookup],    // IANA_ID_ABSENT
      ['146', null],     // QUERY_ERROR
    ]) {
      const ev = assessRegistrar(id, lk);
      assert.notEqual(ev.icann_query_outcome, null, `icann_query_outcome should not be null for id=${id}`);
    }
  });
});

// ── 8. extractPromotedScalars ─────────────────────────────────────────────────

describe('extractPromotedScalars', () => {
  test('extracts all 7 promoted scalar fields', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const ev = assessRegistrar('146', lookup);
    const scalars = extractPromotedScalars(ev);

    const expectedKeys = [
      'registrar_iana_id',
      'icann_query_outcome',
      'registrar_accreditation_status',
      'registrar_country_code',
      'registrar_raa_version',
      'registrar_ssad_participant',
      'icann_query_timestamp',
    ];
    for (const k of expectedKeys) {
      assert.ok(k in scalars, `Missing promoted scalar: ${k}`);
    }
    assert.equal(Object.keys(scalars).length, 7);
  });

  test('promoted icann_query_outcome matches evidence icann_query_outcome', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const ev = assessRegistrar('146', lookup);
    const scalars = extractPromotedScalars(ev);
    assert.equal(scalars.icann_query_outcome, ev.icann_query_outcome);
  });

  test('promoted registrar_accreditation_status matches evidence', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const ev = assessRegistrar('146', lookup);
    const scalars = extractPromotedScalars(ev);
    assert.equal(scalars.registrar_accreditation_status, ev.registrar_accreditation_status);
  });

  test('null promoted scalars for NOT_FOUND (accreditation_status)', () => {
    const lookup = _parseIanaHtml(SAMPLE_HTML);
    const ev = assessRegistrar('9999', lookup);
    const scalars = extractPromotedScalars(ev);
    assert.equal(scalars.registrar_accreditation_status, null);
  });
});

// ── 9. downloadIanaDataset — mock injection ───────────────────────────────────

describe('downloadIanaDataset — injectable fetch', () => {
  test('resolves lookup map when fetch succeeds', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const lookup = await downloadIanaDataset({ _fetchFn: mockFetch });
    assert.ok(lookup instanceof Map);
    assert.ok(lookup.size > 0);
    assert.ok(lookup.has('146'));
  });

  test('retries on failure and resolves on second attempt', async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 2) throw new Error('transient network error');
      return SAMPLE_HTML;
    };
    const lookup = await downloadIanaDataset({
      _fetchFn: mockFetch,
      retryAttempts: 2,
      retryDelayMs: 0,
    });
    assert.ok(lookup.has('146'));
    assert.equal(attempts, 2);
  });

  test('rejects after exhausting all retry attempts', async () => {
    const mockFetch = async () => {
      throw new Error('persistent network error');
    };
    await assert.rejects(
      () => downloadIanaDataset({ _fetchFn: mockFetch, retryAttempts: 1, retryDelayMs: 0 }),
      /persistent network error/,
    );
  });
});

// ── 10. runCollector — orchestration ─────────────────────────────────────────

describe('runCollector — orchestration', () => {
  function makeMockSupabase(dbError = null) {
    return {
      from: () => ({
        insert: async () => ({ error: dbError }),
      }),
    };
  }

  test('produces one result per unique IANA ID', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const { results } = await runCollector({
      ianaIds:         ['146', '292', '4'],
      supabase:        makeMockSupabase(),
      runId:           'test-run-id',
      upstreamRunId:   'test-upstream-id',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0 },
    });
    assert.equal(results.length, 3);
  });

  test('metrics.successCount equals inserted rows when no DB errors', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const { metrics } = await runCollector({
      ianaIds:         ['146', '292'],
      supabase:        makeMockSupabase(null),
      runId:           'test-run-id',
      upstreamRunId:   'test-upstream-id',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0 },
    });
    assert.equal(metrics.successCount, 2);
    assert.equal(metrics.dbErrorCount, 0);
  });

  test('metrics.dbErrorCount increments on DB error', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const { metrics } = await runCollector({
      ianaIds:         ['146'],
      supabase:        makeMockSupabase({ message: 'insert failed' }),
      runId:           'test-run-id',
      upstreamRunId:   'test-upstream-id',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0 },
    });
    assert.equal(metrics.dbErrorCount, 1);
    assert.equal(metrics.successCount, 0);
  });

  test('all results are QUERY_ERROR when dataset download fails', async () => {
    const mockFetch = async () => { throw new Error('dataset unavailable'); };
    const { results, metrics } = await runCollector({
      ianaIds:         ['146', '292'],
      supabase:        makeMockSupabase(),
      runId:           'test-run-id',
      upstreamRunId:   'test-upstream-id',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0, retryDelayMs: 0 },
    });
    assert.equal(metrics.datasetDownloadFailed, true);
    for (const r of results) {
      assert.equal(r.evidence.icann_query_outcome, QUERY_OUTCOMES.QUERY_ERROR);
    }
  });

  test('onProgress is called for each IANA ID', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const calls = [];
    await runCollector({
      ianaIds:         ['146', '292', '4'],
      supabase:        makeMockSupabase(),
      runId:           'test-run-id',
      upstreamRunId:   'test-upstream-id',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0 },
      onProgress:      (ianaId, i, total, result) => calls.push({ ianaId, i }),
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].i, 0);
    assert.equal(calls[2].i, 2);
  });

  test('metrics.ianaIdAbsentCount reflects upstream null IANA IDs', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const { metrics } = await runCollector({
      ianaIds:          ['146'],
      supabase:         makeMockSupabase(),
      runId:            'run-1',
      upstreamRunId:    'upstream-1',
      ianaIdAbsentCount: 7,
      datasetOptions:   { _fetchFn: mockFetch, retryAttempts: 0 },
    });
    assert.equal(metrics.ianaIdAbsentCount, 7);
  });

  test('outcomeCounts tracks QUERY_SUCCESS and NOT_FOUND', async () => {
    const mockFetch = async () => SAMPLE_HTML;
    const { metrics } = await runCollector({
      ianaIds:         ['146', '9999'],  // 146 = QUERY_SUCCESS, 9999 = NOT_FOUND
      supabase:        makeMockSupabase(),
      runId:           'run-1',
      upstreamRunId:   'upstream-1',
      datasetOptions:  { _fetchFn: mockFetch, retryAttempts: 0 },
    });
    assert.equal(metrics.outcomeCounts[QUERY_OUTCOMES.QUERY_SUCCESS], 1);
    assert.equal(metrics.outcomeCounts[QUERY_OUTCOMES.NOT_FOUND], 1);
  });
});
