'use strict';

// SOT-TLSRPT-001 — Phase 2 Validation Script
//
// Validates all observable states against the Signal Lab evidence model.
// Uses live domains for real DNS observations.
// Uses controlled mocks for states requiring specific DNS configurations.
//
// Usage:
//   node backend/signal-lab/signals/tlsrpt/run-validate.js

const assert = require('node:assert/strict');
const { collectTlsRpt, parseTlsRptRecord, SIGNAL_ID, SIGNAL_VERSION } = require('./tlsrpt-collector');

const HR  = '═'.repeat(72);
const DIV = '─'.repeat(72);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ✔  ${label}`);
    passed++;
  } catch {
    console.log(`  ✘  ${label}`);
    console.log(`       expected : ${JSON.stringify(expected)}`);
    console.log(`       received : ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function checkTruthy(label, actual) {
  if (actual) { console.log(`  ✔  ${label}`); passed++; }
  else        { console.log(`  ✘  ${label}  (got: ${JSON.stringify(actual)})`); failed++; failures.push(label); }
}

function section(title) { console.log(`\n${DIV}\n ${title}\n${DIV}`); }

function makeDns(records = [], errorCode = null) {
  return {
    resolveTxt: async () => {
      if (errorCode) throw Object.assign(new Error(`DNS: ${errorCode}`), { code: errorCode });
      if (!records.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return records.map(r => [r]);
    },
  };
}

const EXPECTED_KEYS = new Set([
  'dns_tlsrpt_present', 'dns_collection_error',
  'dns_records', 'dns_record_count', 'dns_tlsrpt_record_count', 'dns_multiple_tlsrpt_records',
  'dns_parse_success', 'dns_syntax_errors', 'dns_version', 'dns_unknown_tags',
  'rua_raw', 'rua_uris', 'rua_count', 'rua_mailto_count', 'rua_https_count', 'rua_unknown_scheme_count',
]);

function checkSchema(label, r) {
  const actual  = new Set(Object.keys(r));
  const missing = [...EXPECTED_KEYS].filter(k => !actual.has(k));
  const extra   = [...actual].filter(k => !EXPECTED_KEYS.has(k));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✔  ${label}: 16 keys present`); passed++;
  } else {
    console.log(`  ✘  ${label}`);
    if (missing.length) console.log(`       missing : ${missing.join(', ')}`);
    if (extra.length)   console.log(`       extra   : ${extra.join(', ')}`);
    failed++; failures.push(label);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — LIVE AND MOCKED DOMAIN VALIDATION
//
// Note: TLS-RPT (_tlsrpt.<domain> TXT records) has very low adoption in the
// wild — the majority of domains, including large providers, do not deploy it.
// "DNS Present" scenarios are demonstrated via controlled mocks using the same
// injectable dnsResolver path exercised in production. Live DNS is used only
// where the observable state can be confirmed (DNS Absent, www. stripping).
// ═════════════════════════════════════════════════════════════════════════════

async function validateLive() {
  console.log(`\n${HR}\n PART 1 — DOMAIN VALIDATION\n${HR}`);

  // ── A. DNS Present (mocked — TLS-RPT adoption is sparse in the wild) ──────

  section('A. DNS Present — mocked (mailto + https reporting)');
  console.log('  Note: _tlsrpt.<domain> records are rare. Mocked to demonstrate');
  console.log('  collector behaviour against a well-formed record.');
  const rPresent = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:tlsrpt@example.com,https://reports.example.com']),
  });
  console.log(`  dns_tlsrpt_present = ${rPresent.dns_tlsrpt_present}`);
  console.log(`  dns_version        = ${rPresent.dns_version}`);
  console.log(`  rua_count          = ${rPresent.rua_count}`);
  console.log(`  rua_uris           = ${JSON.stringify(rPresent.rua_uris)}`);
  console.log(`  rua_mailto_count   = ${rPresent.rua_mailto_count}`);
  console.log(`  rua_https_count    = ${rPresent.rua_https_count}`);
  console.log();
  check('dns_tlsrpt_present = true',    rPresent.dns_tlsrpt_present, true);
  check('dns_collection_error = null',  rPresent.dns_collection_error, null);
  check('dns_version = TLSRPTv1',       rPresent.dns_version, 'TLSRPTv1');
  check('dns_parse_success = true',     rPresent.dns_parse_success, true);
  check('rua_count = 2',                rPresent.rua_count, 2);
  check('rua_mailto_count = 1',         rPresent.rua_mailto_count, 1);
  check('rua_https_count = 1',          rPresent.rua_https_count, 1);
  checkTruthy('rua_raw non-null',       rPresent.rua_raw !== null);
  checkTruthy('rua_uris[0] is mailto',  rPresent.rua_uris[0].startsWith('mailto:'));
  checkTruthy('rua_uris[1] is https',   rPresent.rua_uris[1].startsWith('https:'));
  checkSchema('schema: DNS Present',    rPresent);

  // ── B. DNS Absent (live — example.com has no TLS-RPT record) ─────────────

  section('B. DNS Absent — example.com (live)');
  console.log('  Collecting...');
  const exampleCom = await collectTlsRpt('example.com');
  console.log(`  dns_tlsrpt_present = ${exampleCom.dns_tlsrpt_present}`);
  console.log();
  check('dns_tlsrpt_present = false',          exampleCom.dns_tlsrpt_present, false);
  check('dns_collection_error = null',         exampleCom.dns_collection_error, null);
  check('dns_record_count = 0',                exampleCom.dns_record_count, 0);
  check('dns_tlsrpt_record_count = 0',         exampleCom.dns_tlsrpt_record_count, 0);
  check('dns_multiple_tlsrpt_records = false', exampleCom.dns_multiple_tlsrpt_records, false);
  check('dns_parse_success = null',            exampleCom.dns_parse_success, null);
  check('dns_version = null',                  exampleCom.dns_version, null);
  check('rua_raw = null',                      exampleCom.rua_raw, null);
  check('rua_count = 0',                       exampleCom.rua_count, 0);
  checkSchema('schema: example.com',           exampleCom);

  // ── C. www. prefix stripping (live — confirms apex normalisation) ─────────

  section('C. www. Prefix Stripping — www.example.com (live)');
  console.log('  Collecting...');
  const www = await collectTlsRpt('www.example.com');
  check('www. stripped: same result as apex', www.dns_tlsrpt_present, exampleCom.dns_tlsrpt_present);
  check('dns_record_count matches apex',       www.dns_record_count,     exampleCom.dns_record_count);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — DNS STATE COVERAGE (mocked)
// ═════════════════════════════════════════════════════════════════════════════

async function validateDnsStates() {
  console.log(`\n${HR}\n PART 2 — DNS STATE COVERAGE\n${HR}`);

  const GOOD = 'v=TLSRPTv1; rua=mailto:tlsrpt@example.com';

  section('DNS Unknown — ETIMEDOUT');
  const rTimeout = await collectTlsRpt('x.example', { dnsResolver: makeDns([], 'ETIMEDOUT') });
  check('dns_tlsrpt_present = null',          rTimeout.dns_tlsrpt_present, null);
  check('dns_collection_error = DNS_TIMEOUT', rTimeout.dns_collection_error, 'DNS_TIMEOUT');
  check('dns_record_count = null',            rTimeout.dns_record_count, null);
  check('dns_tlsrpt_record_count = null',     rTimeout.dns_tlsrpt_record_count, null);
  check('dns_multiple_tlsrpt_records = null', rTimeout.dns_multiple_tlsrpt_records, null);
  checkSchema('schema: DNS_TIMEOUT',          rTimeout);

  section('DNS Unknown — ESERVFAIL');
  const rServfail = await collectTlsRpt('x.example', { dnsResolver: makeDns([], 'ESERVFAIL') });
  check('dns_collection_error = DNS_SERVFAIL', rServfail.dns_collection_error, 'DNS_SERVFAIL');
  checkSchema('schema: DNS_SERVFAIL',          rServfail);

  section('DNS Unknown — unrecognised error');
  const rUnk = await collectTlsRpt('x.example', { dnsResolver: makeDns([], 'EUNKNOWN') });
  check('dns_collection_error = DNS_FAILURE', rUnk.dns_collection_error, 'DNS_FAILURE');
  checkSchema('schema: DNS_FAILURE',          rUnk);

  section('Non-qualifying TXT records preserved on absence');
  const rNonQual = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=spf1 -all', 'some-other=record']),
  });
  check('dns_tlsrpt_present = false',     rNonQual.dns_tlsrpt_present, false);
  check('dns_record_count = 2',           rNonQual.dns_record_count, 2);
  check('dns_tlsrpt_record_count = 0',    rNonQual.dns_tlsrpt_record_count, 0);
  check('non-TLS-RPT records preserved',  rNonQual.dns_records[0], 'v=spf1 -all');
  checkSchema('schema: non-qualifying',   rNonQual);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 3 — RUA STATE COVERAGE
// ═════════════════════════════════════════════════════════════════════════════

async function validateRuaStates() {
  console.log(`\n${HR}\n PART 3 — RUA STATE COVERAGE\n${HR}`);

  section('mailto reporting URI');
  const rMailto = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:tlsrpt@example.com']),
  });
  check('rua_mailto_count = 1',            rMailto.rua_mailto_count, 1);
  check('rua_https_count = 0',             rMailto.rua_https_count, 0);
  check('rua_uris[0] verbatim',            rMailto.rua_uris[0], 'mailto:tlsrpt@example.com');

  section('https reporting URI');
  const rHttps = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=https://reports.example.com/tlsrpt']),
  });
  check('rua_https_count = 1',             rHttps.rua_https_count, 1);
  check('rua_mailto_count = 0',            rHttps.rua_mailto_count, 0);
  check('rua_uris[0] verbatim',            rHttps.rua_uris[0], 'https://reports.example.com/tlsrpt');

  section('Multiple reporting URIs — order preserved');
  const rMultiUri = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:a@x.com,https://b.example.com,mailto:c@x.com']),
  });
  check('rua_count = 3',                   rMultiUri.rua_count, 3);
  check('rua_mailto_count = 2',            rMultiUri.rua_mailto_count, 2);
  check('rua_https_count = 1',             rMultiUri.rua_https_count, 1);
  check('rua_uris[0] = first',             rMultiUri.rua_uris[0], 'mailto:a@x.com');
  check('rua_uris[1] = second',            rMultiUri.rua_uris[1], 'https://b.example.com');
  check('rua_uris[2] = third',             rMultiUri.rua_uris[2], 'mailto:c@x.com');

  section('Unknown scheme URI');
  const rUnknownScheme = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=ftp://reports.example.com']),
  });
  check('rua_unknown_scheme_count = 1',    rUnknownScheme.rua_unknown_scheme_count, 1);
  check('rua_mailto_count = 0',            rUnknownScheme.rua_mailto_count, 0);
  check('dns_parse_success = false',       rUnknownScheme.dns_parse_success, false);
  checkTruthy('UNKNOWN_SCHEME in errors',  rUnknownScheme.dns_syntax_errors.some(e => e.code === 'UNKNOWN_SCHEME'));
  check('URI preserved verbatim',          rUnknownScheme.rua_uris[0], 'ftp://reports.example.com');

  section('Missing rua= tag');
  const rNoRua = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1']),
  });
  check('dns_tlsrpt_present = true',       rNoRua.dns_tlsrpt_present, true);
  check('dns_parse_success = false',       rNoRua.dns_parse_success, false);
  check('rua_raw = null',                  rNoRua.rua_raw, null);
  check('rua_count = 0',                   rNoRua.rua_count, 0);
  checkTruthy('MISSING_RUA in errors',     rNoRua.dns_syntax_errors.some(e => e.code === 'MISSING_RUA'));
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 4 — MULTIPLE RECORDS
// ═════════════════════════════════════════════════════════════════════════════

async function validateMultipleRecords() {
  console.log(`\n${HR}\n PART 4 — MULTIPLE TLSRPT RECORDS\n${HR}`);

  section('Multiple TLSRPTv1 records — all preserved, first parsed');
  const REC_A = 'v=TLSRPTv1; rua=mailto:first@x.com';
  const REC_B = 'v=TLSRPTv1; rua=mailto:second@x.com';
  const rMulti = await collectTlsRpt('x.example', {
    dnsResolver: makeDns([REC_A, REC_B]),
  });
  check('dns_tlsrpt_present = true',          rMulti.dns_tlsrpt_present, true);
  check('dns_tlsrpt_record_count = 2',         rMulti.dns_tlsrpt_record_count, 2);
  check('dns_multiple_tlsrpt_records = true',  rMulti.dns_multiple_tlsrpt_records, true);
  check('dns_records[0] = REC_A',              rMulti.dns_records[0], REC_A);
  check('dns_records[1] = REC_B',              rMulti.dns_records[1], REC_B);
  checkTruthy('MULTIPLE_RECORDS in errors',    rMulti.dns_syntax_errors.some(e => e.code === 'MULTIPLE_RECORDS'));
  check('rua_raw from first record',           rMulti.rua_raw, 'mailto:first@x.com');
  checkSchema('schema: multiple records',      rMulti);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 5 — EVIDENCE PRESERVATION
// ═════════════════════════════════════════════════════════════════════════════

async function validateEvidence() {
  console.log(`\n${HR}\n PART 5 — EVIDENCE PRESERVATION\n${HR}`);

  section('Raw DNS record preserved verbatim');
  const RAW = 'v=TLSRPTv1; rua=mailto:tlsrpt@example.com';
  const rRaw = await collectTlsRpt('x.example', { dnsResolver: makeDns([RAW]) });
  check('dns_records[0] === raw string', rRaw.dns_records[0], RAW);

  section('rua_raw preserved verbatim (before URI split)');
  const RUA_STRING = 'mailto:a@x.com,https://b.com,mailto:c@x.com';
  const rRuaRaw = await collectTlsRpt('x.example', {
    dnsResolver: makeDns([`v=TLSRPTv1; rua=${RUA_STRING}`]),
  });
  check('rua_raw === original rua= value', rRuaRaw.rua_raw, RUA_STRING);

  section('Unknown tags preserved verbatim');
  const rUnknown = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:x@x.com; x-provider=mailguard; x-region=eu']),
  });
  check('dns_unknown_tags preserved',   rUnknown.dns_unknown_tags, { 'x-provider': 'mailguard', 'x-region': 'eu' });
  check('parse_success = true',         rUnknown.dns_parse_success, true);

  section('Malformed record preserved despite parse failure');
  const MALFORMED = 'v=TLSRPTv1; NOTAVALIDTAG; rua=mailto:x@x.com';
  const rMalformed = await collectTlsRpt('x.example', { dnsResolver: makeDns([MALFORMED]) });
  check('malformed record in dns_records', rMalformed.dns_records[0], MALFORMED);
  check('dns_tlsrpt_present = true',       rMalformed.dns_tlsrpt_present, true);
  check('dns_parse_success = false',       rMalformed.dns_parse_success, false);
  checkTruthy('MALFORMED_TAG in errors',   rMalformed.dns_syntax_errors.some(e => e.code === 'MALFORMED_TAG'));
  check('rua_raw still extracted',         rMalformed.rua_raw, 'mailto:x@x.com');

  section('URI order preserved from rua= value');
  const rOrdered = await collectTlsRpt('x.example', {
    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:zzz@x.com,mailto:aaa@x.com,https://mmm.x.com']),
  });
  check('rua_uris[0] = zzz (as observed)', rOrdered.rua_uris[0], 'mailto:zzz@x.com');
  check('rua_uris[1] = aaa (as observed)', rOrdered.rua_uris[1], 'mailto:aaa@x.com');
  check('rua_uris[2] = mmm (as observed)', rOrdered.rua_uris[2], 'https://mmm.x.com');
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 6 — SCHEMA CONSISTENCY
// ═════════════════════════════════════════════════════════════════════════════

async function validateSchema() {
  console.log(`\n${HR}\n PART 6 — SCHEMA CONSISTENCY\n Verifies 16 expected keys across all state combinations.\n${HR}`);

  const scenarios = [
    { name: 'present, valid mailto',        dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:x@x.com']) },
    { name: 'present, valid https',         dnsResolver: makeDns(['v=TLSRPTv1; rua=https://x.com']) },
    { name: 'present, mixed URIs',          dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:a@x.com,https://b.com']) },
    { name: 'present, unknown tags',        dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:x@x.com; x-foo=bar']) },
    { name: 'present, missing rua',         dnsResolver: makeDns(['v=TLSRPTv1']) },
    { name: 'present, empty rua',           dnsResolver: makeDns(['v=TLSRPTv1; rua=']) },
    { name: 'present, multiple records',    dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:a@x.com', 'v=TLSRPTv1; rua=mailto:b@x.com']) },
    { name: 'absent (ENODATA)',             dnsResolver: makeDns([], 'ENODATA') },
    { name: 'absent (ENOTFOUND)',           dnsResolver: makeDns([], 'ENOTFOUND') },
    { name: 'unknown (ETIMEDOUT)',          dnsResolver: makeDns([], 'ETIMEDOUT') },
    { name: 'unknown (ESERVFAIL)',          dnsResolver: makeDns([], 'ESERVFAIL') },
    { name: 'unknown (other)',              dnsResolver: makeDns([], 'EUNKNOWN') },
    { name: 'non-qualifying TXT records',  dnsResolver: makeDns(['v=spf1 -all']) },
  ];

  section('16 expected keys in all states');
  for (const s of scenarios) {
    const r = await collectTlsRpt('x.example', { dnsResolver: s.dnsResolver });
    checkSchema(s.name, r);
  }

  section('Invariants: always-arrays and always-objects');
  for (const s of scenarios) {
    const r = await collectTlsRpt('x.example', { dnsResolver: s.dnsResolver });
    check(`${s.name.slice(0,40)}: dns_records is array`,       Array.isArray(r.dns_records), true);
    check(`${s.name.slice(0,40)}: dns_syntax_errors is array`, Array.isArray(r.dns_syntax_errors), true);
    check(`${s.name.slice(0,40)}: rua_uris is array`,          Array.isArray(r.rua_uris), true);
    check(`${s.name.slice(0,40)}: dns_unknown_tags is object`,
      typeof r.dns_unknown_tags === 'object' && !Array.isArray(r.dns_unknown_tags), true);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${HR}\n SOT-TLSRPT-001 — Phase 2 Validation\n Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}\n Date: ${new Date().toISOString()}\n${HR}`);

  try {
    await validateLive();
    await validateDnsStates();
    await validateRuaStates();
    await validateMultipleRecords();
    await validateEvidence();
    await validateSchema();
  } catch (err) {
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n${HR}\n VALIDATION SUMMARY\n${HR}`);
  console.log(`  Total checks : ${passed + failed}`);
  console.log(`  Passed       : ${passed}`);
  console.log(`  Failed       : ${failed}`);

  if (failures.length > 0) {
    console.log(`\n  Failed checks:`);
    for (const f of failures) console.log(`    ✘  ${f}`);
    console.log(`\n${HR}\n RESULT: VALIDATION FAILED — additional work required before HE-001\n${HR}\n`);
    process.exit(1);
  } else {
    console.log(`\n${HR}\n RESULT: VALIDATION PASSED — collector ready for HE-001 cohort execution\n${HR}\n`);
  }
}

main();
