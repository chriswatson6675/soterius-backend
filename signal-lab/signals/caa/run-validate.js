'use strict';

// SOT-CAA-001 — Phase 2 Validation Script
//
// Validates all observable states against the Signal Lab evidence model.
// Mocked scenarios demonstrate controlled record structures without
// dependency on specific third-party DNS configurations.
// Live DNS used only where the observable state is stable and predictable.
//
// Usage:
//   node backend/signal-lab/signals/caa/run-validate.js

const assert = require('node:assert/strict');
const { collectCaa, SIGNAL_ID, SIGNAL_VERSION } = require('./caa-collector');

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

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeDns(records = [], errorCode = null) {
  return {
    async resolveCaa() {
      if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
      return records;
    },
  };
}

// ── Schema check ──────────────────────────────────────────────────────────────

const EXPECTED_KEYS = new Set([
  'dns_caa_present', 'caa_collection_error',
  'caa_records', 'caa_record_count',
  'caa_issue_count', 'caa_issuewild_count', 'caa_iodef_count',
  'caa_unknown_tag_count', 'caa_critical_count',
  'caa_issue_values', 'caa_issuewild_values', 'caa_iodef_values',
  'caa_tags_present',
]);

function checkSchema(label, r) {
  const actual  = new Set(Object.keys(r));
  const missing = [...EXPECTED_KEYS].filter(k => !actual.has(k));
  const extra   = [...actual].filter(k => !EXPECTED_KEYS.has(k));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✔  ${label}: 13 keys present`); passed++;
  } else {
    console.log(`  ✘  ${label}`);
    if (missing.length) console.log(`       missing : ${missing.join(', ')}`);
    if (extra.length)   console.log(`       extra   : ${extra.join(', ')}`);
    failed++; failures.push(label);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — DOMAIN VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

async function validateLive() {
  console.log(`\n${HR}\n PART 1 — DOMAIN VALIDATION\n${HR}`);

  // ── A. DNS Present — mocked, full policy ────────────────────────────────────

  section('A. DNS Present — issue + issuewild + iodef (mocked)');
  console.log('  Note: Controlled mock demonstrates a complete CAA policy structure.');

  const rPresent = await collectCaa('example.com', {
    dnsResolver: makeDns([
      { critical: 0, issue:      'letsencrypt.org' },
      { critical: 0, issuewild:  'sectigo.com' },
      { critical: 0, iodef:      'mailto:security@example.com' },
    ]),
  });

  console.log(`  dns_caa_present    = ${rPresent.dns_caa_present}`);
  console.log(`  caa_record_count   = ${rPresent.caa_record_count}`);
  console.log(`  caa_issue_count    = ${rPresent.caa_issue_count}`);
  console.log(`  caa_issuewild_count= ${rPresent.caa_issuewild_count}`);
  console.log(`  caa_iodef_count    = ${rPresent.caa_iodef_count}`);
  console.log(`  caa_tags_present   = ${JSON.stringify(rPresent.caa_tags_present)}`);
  console.log(`  caa_issue_values   = ${JSON.stringify(rPresent.caa_issue_values)}`);
  console.log();

  check('dns_caa_present = true',                   rPresent.dns_caa_present,     true);
  check('caa_collection_error = null',              rPresent.caa_collection_error, null);
  check('caa_record_count = 3',                     rPresent.caa_record_count,     3);
  check('caa_issue_count = 1',                      rPresent.caa_issue_count,      1);
  check('caa_issuewild_count = 1',                  rPresent.caa_issuewild_count,  1);
  check('caa_iodef_count = 1',                      rPresent.caa_iodef_count,      1);
  check('caa_unknown_tag_count = 0',                rPresent.caa_unknown_tag_count, 0);
  check('caa_critical_count = 0',                   rPresent.caa_critical_count,   0);
  check('caa_tags_present sorted',                  rPresent.caa_tags_present,     ['iodef', 'issue', 'issuewild']);
  check('caa_issue_values[0] = letsencrypt.org',    rPresent.caa_issue_values[0],  'letsencrypt.org');
  check('caa_issuewild_values[0] = sectigo.com',    rPresent.caa_issuewild_values[0], 'sectigo.com');
  check('caa_iodef_values[0] verbatim',             rPresent.caa_iodef_values[0],  'mailto:security@example.com');
  checkSchema('schema: DNS Present',                rPresent);

  // ── B. DNS Absent — example.com (live) ───────────────────────────────────

  section('B. DNS Absent — example.com (live)');
  console.log('  Collecting...');
  const rAbsent = await collectCaa('example.com');
  console.log(`  dns_caa_present    = ${rAbsent.dns_caa_present}`);
  console.log();

  check('dns_caa_present = false',       rAbsent.dns_caa_present,     false);
  check('caa_collection_error = null',   rAbsent.caa_collection_error, null);
  check('caa_record_count = 0',          rAbsent.caa_record_count,     0);
  check('caa_issue_count = 0',           rAbsent.caa_issue_count,      0);
  check('caa_issuewild_count = 0',       rAbsent.caa_issuewild_count,  0);
  check('caa_iodef_count = 0',           rAbsent.caa_iodef_count,      0);
  check('caa_unknown_tag_count = 0',     rAbsent.caa_unknown_tag_count, 0);
  check('caa_critical_count = 0',        rAbsent.caa_critical_count,   0);
  check('caa_records = []',              rAbsent.caa_records,           []);
  check('caa_tags_present = []',         rAbsent.caa_tags_present,      []);
  checkSchema('schema: example.com',     rAbsent);

  // ── C. www. prefix stripping — live ───────────────────────────────────────

  section('C. www. Prefix Stripping — www.example.com (live)');
  console.log('  Collecting...');
  const rWww = await collectCaa('www.example.com');
  check('www. stripped: same result as apex', rWww.dns_caa_present, rAbsent.dns_caa_present);
  check('caa_record_count matches apex',      rWww.caa_record_count, rAbsent.caa_record_count);

  // ── D. Live CAA-present domain — cloudflare.com ───────────────────────────

  section('D. CAA Present — cloudflare.com (live)');
  console.log('  Collecting...');
  const rCf = await collectCaa('cloudflare.com');
  console.log(`  dns_caa_present    = ${rCf.dns_caa_present}`);
  console.log(`  caa_record_count   = ${rCf.caa_record_count}`);
  console.log(`  caa_tags_present   = ${JSON.stringify(rCf.caa_tags_present)}`);
  console.log(`  caa_issue_values   = ${JSON.stringify(rCf.caa_issue_values)}`);
  console.log(`  caa_issuewild_values = ${JSON.stringify(rCf.caa_issuewild_values)}`);
  console.log(`  caa_iodef_values   = ${JSON.stringify(rCf.caa_iodef_values)}`);
  console.log();

  check('cloudflare.com dns_caa_present = true', rCf.dns_caa_present, true);
  checkTruthy('caa_record_count > 0',            rCf.caa_record_count > 0);
  checkTruthy('caa_records is array',            Array.isArray(rCf.caa_records));
  checkSchema('schema: cloudflare.com',          rCf);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — DNS STATE COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

async function validateDnsStates() {
  console.log(`\n${HR}\n PART 2 — DNS STATE COVERAGE\n${HR}`);

  section('DNS Unknown — ETIMEDOUT');
  const rTimeout = await collectCaa('x.example', { dnsResolver: makeDns([], 'ETIMEDOUT') });
  check('dns_caa_present = null',          rTimeout.dns_caa_present,      null);
  check('caa_collection_error = DNS_TIMEOUT', rTimeout.caa_collection_error, 'DNS_TIMEOUT');
  check('caa_record_count = null',         rTimeout.caa_record_count,     null);
  check('caa_issue_count = null',          rTimeout.caa_issue_count,      null);
  checkSchema('schema: DNS_TIMEOUT',       rTimeout);

  section('DNS Unknown — ESERVFAIL');
  const rServfail = await collectCaa('x.example', { dnsResolver: makeDns([], 'ESERVFAIL') });
  check('caa_collection_error = DNS_SERVFAIL', rServfail.caa_collection_error, 'DNS_SERVFAIL');
  check('dns_caa_present = null',              rServfail.dns_caa_present,      null);
  checkSchema('schema: DNS_SERVFAIL',          rServfail);

  section('DNS Unknown — unrecognised error');
  const rUnk = await collectCaa('x.example', { dnsResolver: makeDns([], 'EUNKNOWN') });
  check('caa_collection_error = DNS_FAILURE', rUnk.caa_collection_error, 'DNS_FAILURE');
  checkSchema('schema: DNS_FAILURE',          rUnk);

  section('DNS Absent — ENODATA thrown');
  const rEnodata = await collectCaa('x.example', { dnsResolver: makeDns([], 'ENODATA') });
  check('dns_caa_present = false',          rEnodata.dns_caa_present,      false);
  check('caa_collection_error = null',      rEnodata.caa_collection_error, null);
  checkSchema('schema: ENODATA',            rEnodata);

  section('DNS Absent — ENOTFOUND thrown');
  const rEnotfound = await collectCaa('x.example', { dnsResolver: makeDns([], 'ENOTFOUND') });
  check('dns_caa_present = false',          rEnotfound.dns_caa_present, false);

  section('DNS Absent — empty array returned (NODATA equivalent)');
  const rEmpty = await collectCaa('x.example', { dnsResolver: makeDns([]) });
  check('dns_caa_present = false',          rEmpty.dns_caa_present, false);
  check('caa_record_count = 0',             rEmpty.caa_record_count, 0);
  checkSchema('schema: empty array',        rEmpty);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — RECORD STRUCTURE COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

async function validateRecordStructures() {
  console.log(`\n${HR}\n PART 3 — RECORD STRUCTURE COVERAGE\n${HR}`);

  section('issue-only policy');
  const rIssue = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issue: 'letsencrypt.org' }]),
  });
  check('caa_issue_count = 1',                    rIssue.caa_issue_count,       1);
  check('caa_issuewild_count = 0',                rIssue.caa_issuewild_count,   0);
  check('caa_iodef_count = 0',                    rIssue.caa_iodef_count,       0);
  check('caa_issue_values = [letsencrypt.org]',   rIssue.caa_issue_values,      ['letsencrypt.org']);
  check('caa_tags_present = [issue]',             rIssue.caa_tags_present,      ['issue']);

  section('issuewild-only record');
  const rWild = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issuewild: 'sectigo.com' }]),
  });
  check('caa_issuewild_count = 1',               rWild.caa_issuewild_count,    1);
  check('caa_issue_count = 0',                   rWild.caa_issue_count,        0);
  check('caa_issuewild_values[0] = sectigo.com', rWild.caa_issuewild_values[0], 'sectigo.com');
  check('caa_tags_present = [issuewild]',        rWild.caa_tags_present,        ['issuewild']);

  section('iodef record — mailto URI');
  const rIodefMailto = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, iodef: 'mailto:pki@example.com' }]),
  });
  check('caa_iodef_count = 1',                    rIodefMailto.caa_iodef_count, 1);
  check('iodef value verbatim',                   rIodefMailto.caa_iodef_values[0], 'mailto:pki@example.com');

  section('iodef record — https URI');
  const rIodefHttps = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, iodef: 'https://caa.example.com/report' }]),
  });
  check('caa_iodef_count = 1',                    rIodefHttps.caa_iodef_count, 1);
  check('https iodef value verbatim',             rIodefHttps.caa_iodef_values[0], 'https://caa.example.com/report');

  section('unknown tag — accounturi');
  const rUnknown = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, accounturi: 'https://account.example.com' }]),
  });
  check('caa_unknown_tag_count = 1',              rUnknown.caa_unknown_tag_count, 1);
  check('issue/issuewild/iodef counts = 0',       rUnknown.caa_issue_count + rUnknown.caa_issuewild_count + rUnknown.caa_iodef_count, 0);
  check('accounturi in tags_present',             rUnknown.caa_tags_present.includes('accounturi'), true);
  check('unknown tag preserved in caa_records',   rUnknown.caa_records[0].tag,   'accounturi');
  check('unknown tag value preserved verbatim',   rUnknown.caa_records[0].value, 'https://account.example.com');

  section('mixed policy — issue + issuewild + iodef + unknown');
  const rMixed = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issue:      'letsencrypt.org' },
      { critical: 0, issue:      'digicert.com' },
      { critical: 0, issuewild:  'sectigo.com' },
      { critical: 0, iodef:      'mailto:caa@example.com' },
      { critical: 0, accounturi: 'https://account.example.com' },
    ]),
  });
  check('caa_record_count = 5',           rMixed.caa_record_count,       5);
  check('caa_issue_count = 2',            rMixed.caa_issue_count,        2);
  check('caa_issuewild_count = 1',        rMixed.caa_issuewild_count,    1);
  check('caa_iodef_count = 1',            rMixed.caa_iodef_count,        1);
  check('caa_unknown_tag_count = 1',      rMixed.caa_unknown_tag_count,  1);
  check('caa_tags_present sorted',        rMixed.caa_tags_present,       ['accounturi', 'iodef', 'issue', 'issuewild']);
  checkSchema('schema: mixed policy',     rMixed);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 4 — FLAG COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

async function validateFlags() {
  console.log(`\n${HR}\n PART 4 — FLAG COVERAGE\n${HR}`);

  section('flags = 0 (not critical)');
  const rF0 = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issue: 'letsencrypt.org' }]),
  });
  check('caa_critical_count = 0',       rF0.caa_critical_count, 0);
  check('flags=0 preserved in records', rF0.caa_records[0].flags, 0);

  section('flags = 128 (issuer critical bit set)');
  const rF128 = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 128, issue: 'digicert.com' }]),
  });
  check('caa_critical_count = 1',         rF128.caa_critical_count, 1);
  check('flags=128 preserved in records', rF128.caa_records[0].flags, 128);
  check('dns_caa_present = true',         rF128.dns_caa_present, true);

  section('mixed: 2 critical + 2 non-critical');
  const rFMixed = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0,   issue:     'letsencrypt.org' },
      { critical: 128, issue:     'digicert.com' },
      { critical: 0,   issuewild: 'sectigo.com' },
      { critical: 128, issuewild: 'comodoca.com' },
    ]),
  });
  check('caa_critical_count = 2', rFMixed.caa_critical_count, 2);
  check('caa_record_count = 4',   rFMixed.caa_record_count,   4);

  section('reserved flag bits (flags=64) — not the critical bit');
  const rF64 = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 64, issue: 'example.com' }]),
  });
  check('flags=64 preserved verbatim', rF64.caa_records[0].flags, 64);
  check('caa_critical_count = 0',      rF64.caa_critical_count,  0); // bit 7 (MSB=128) not set
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 5 — VALUE HANDLING
// ─────────────────────────────────────────────────────────────────────────────

async function validateValues() {
  console.log(`\n${HR}\n PART 5 — VALUE HANDLING\n${HR}`);

  section('empty issue value (prohibits CA issuance)');
  const rEmpty = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issue: '' }]),
  });
  check('empty value in caa_issue_values',         rEmpty.caa_issue_values,      ['']);
  check('empty value in caa_records[0].value',     rEmpty.caa_records[0].value,  '');
  check('caa_issue_count = 1',                     rEmpty.caa_issue_count,       1);
  check('dns_caa_present = true',                  rEmpty.dns_caa_present,       true);

  section('CA identifier verbatim — no normalisation');
  const rVerbatim = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issue: 'LetsEncrypt.Org' }]),
  });
  check('value preserved without lowercasing',     rVerbatim.caa_issue_values[0], 'LetsEncrypt.Org');

  section('CA identifier with parameters verbatim');
  const rParams = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, issue: 'letsencrypt.org; validationmethods=dns-01' }]),
  });
  check('value with params preserved verbatim',    rParams.caa_issue_values[0], 'letsencrypt.org; validationmethods=dns-01');
  check('caa_records[0].value with params',        rParams.caa_records[0].value, 'letsencrypt.org; validationmethods=dns-01');

  section('iodef mailto verbatim');
  const rMailto = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, iodef: 'mailto:pki@example.com' }]),
  });
  check('mailto iodef verbatim',                   rMailto.caa_iodef_values[0], 'mailto:pki@example.com');

  section('iodef https verbatim');
  const rHttps = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, iodef: 'https://caa.example.com/report' }]),
  });
  check('https iodef verbatim',                    rHttps.caa_iodef_values[0], 'https://caa.example.com/report');
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 6 — EVIDENCE PRESERVATION
// ─────────────────────────────────────────────────────────────────────────────

async function validateEvidence() {
  console.log(`\n${HR}\n PART 6 — EVIDENCE PRESERVATION\n${HR}`);

  section('DNS return order preserved in caa_records');
  const rOrder = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, iodef:  'mailto:z@example.com' },
      { critical: 0, issue:  'zzz.com' },
      { critical: 0, issuewild: 'aaa.com' },
    ]),
  });
  check('caa_records[0].tag = iodef',     rOrder.caa_records[0].tag, 'iodef');
  check('caa_records[1].tag = issue',     rOrder.caa_records[1].tag, 'issue');
  check('caa_records[2].tag = issuewild', rOrder.caa_records[2].tag, 'issuewild');

  section('caa_issue_values order matches DNS return order (not sorted)');
  const rValueOrder = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issue: 'zzz.com' },
      { critical: 0, issue: 'aaa.com' },
      { critical: 0, issue: 'mmm.com' },
    ]),
  });
  check('caa_issue_values[0] = zzz.com (as observed)', rValueOrder.caa_issue_values[0], 'zzz.com');
  check('caa_issue_values[1] = aaa.com (as observed)', rValueOrder.caa_issue_values[1], 'aaa.com');
  check('caa_issue_values[2] = mmm.com (as observed)', rValueOrder.caa_issue_values[2], 'mmm.com');

  section('duplicate records preserved (not deduplicated)');
  const rDupe = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issue: 'letsencrypt.org' },
      { critical: 0, issue: 'letsencrypt.org' },
    ]),
  });
  check('caa_record_count = 2',                     rDupe.caa_record_count,   2);
  check('caa_issue_count = 2',                      rDupe.caa_issue_count,    2);
  check('caa_issue_values both entries preserved',  rDupe.caa_issue_values,   ['letsencrypt.org', 'letsencrypt.org']);
  check('caa_records[0] and [1] identical',         rDupe.caa_records[0].value, rDupe.caa_records[1].value);

  section('unknown tag preserved in full in caa_records');
  const rUnkFull = await collectCaa('x.example', {
    dnsResolver: makeDns([{ critical: 0, contactemail: 'admin@example.com' }]),
  });
  check('caa_records[0].flags = 0',                 rUnkFull.caa_records[0].flags, 0);
  check('caa_records[0].tag = contactemail',        rUnkFull.caa_records[0].tag,   'contactemail');
  check('caa_records[0].value verbatim',            rUnkFull.caa_records[0].value, 'admin@example.com');
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 7 — TAGS PRESENT OBSERVATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function validateTagsPresent() {
  console.log(`\n${HR}\n PART 7 — TAGS PRESENT OBSERVATIONS\n${HR}`);

  section('caa_tags_present sorted alphabetically');
  const rSorted = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issuewild: 'sectigo.com' },
      { critical: 0, iodef:     'mailto:a@example.com' },
      { critical: 0, issue:     'letsencrypt.org' },
    ]),
  });
  check('sorted: iodef, issue, issuewild',      rSorted.caa_tags_present, ['iodef', 'issue', 'issuewild']);

  section('caa_tags_present deduplicated across multiple same-tag records');
  const rDeduped = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issue: 'le.org' },
      { critical: 0, issue: 'digicert.com' },
      { critical: 0, issue: 'sectigo.com' },
    ]),
  });
  check('three issue records → tags_present = [issue]', rDeduped.caa_tags_present, ['issue']);

  section('caa_tags_present includes unknown tags');
  const rWithUnknown = await collectCaa('x.example', {
    dnsResolver: makeDns([
      { critical: 0, issue:     'letsencrypt.org' },
      { critical: 0, accounturi: 'https://account.example.com' },
    ]),
  });
  check('accounturi in tags_present',   rWithUnknown.caa_tags_present.includes('accounturi'), true);
  check('issue in tags_present',        rWithUnknown.caa_tags_present.includes('issue'),      true);
  check('tags_present sorted',          rWithUnknown.caa_tags_present,                        ['accounturi', 'issue']);

  section('caa_tags_present empty in absent state');
  const rAbsentTags = await collectCaa('x.example', { dnsResolver: makeDns([], 'ENODATA') });
  check('tags_present = [] when absent', rAbsentTags.caa_tags_present, []);

  section('caa_tags_present empty in unknown state');
  const rUnknownTags = await collectCaa('x.example', { dnsResolver: makeDns([], 'ETIMEDOUT') });
  check('tags_present = [] when unknown', rUnknownTags.caa_tags_present, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 8 — SCHEMA CONSISTENCY
// ─────────────────────────────────────────────────────────────────────────────

async function validateSchema() {
  console.log(`\n${HR}\n PART 8 — SCHEMA CONSISTENCY\n 13 expected keys across all state combinations.\n${HR}`);

  const scenarios = [
    { name: 'present, single issue',       dns: makeDns([{ critical: 0, issue: 'le.org' }]) },
    { name: 'present, all three tags',     dns: makeDns([{ critical: 0, issue: 'le.org' }, { critical: 0, issuewild: 's.com' }, { critical: 0, iodef: 'mailto:a@x.com' }]) },
    { name: 'present, unknown tag',        dns: makeDns([{ critical: 0, accounturi: 'https://a.example.com' }]) },
    { name: 'present, critical flag',      dns: makeDns([{ critical: 128, issue: 'digicert.com' }]) },
    { name: 'present, empty value',        dns: makeDns([{ critical: 0, issue: '' }]) },
    { name: 'present, multiple issues',    dns: makeDns([{ critical: 0, issue: 'le.org' }, { critical: 0, issue: 'digicert.com' }]) },
    { name: 'present, with params',        dns: makeDns([{ critical: 0, issue: 'le.org; validationmethods=dns-01' }]) },
    { name: 'present, duplicate records',  dns: makeDns([{ critical: 0, issue: 'le.org' }, { critical: 0, issue: 'le.org' }]) },
    { name: 'absent (empty array)',        dns: makeDns([]) },
    { name: 'absent (ENODATA)',            dns: makeDns([], 'ENODATA') },
    { name: 'absent (ENOTFOUND)',          dns: makeDns([], 'ENOTFOUND') },
    { name: 'unknown (ETIMEDOUT)',         dns: makeDns([], 'ETIMEDOUT') },
    { name: 'unknown (ESERVFAIL)',         dns: makeDns([], 'ESERVFAIL') },
    { name: 'unknown (other error)',       dns: makeDns([], 'ECONNREFUSED') },
  ];

  section('13 expected keys in all states');
  for (const s of scenarios) {
    const r = await collectCaa('x.example', { dnsResolver: s.dns });
    checkSchema(s.name, r);
  }

  section('Array invariants: always arrays, never null');
  for (const s of scenarios) {
    const r = await collectCaa('x.example', { dnsResolver: s.dns });
    const name = s.name.slice(0, 32);
    check(`${name}: caa_records is Array`,          Array.isArray(r.caa_records),          true);
    check(`${name}: caa_issue_values is Array`,     Array.isArray(r.caa_issue_values),     true);
    check(`${name}: caa_issuewild_values is Array`, Array.isArray(r.caa_issuewild_values), true);
    check(`${name}: caa_iodef_values is Array`,     Array.isArray(r.caa_iodef_values),     true);
    check(`${name}: caa_tags_present is Array`,     Array.isArray(r.caa_tags_present),     true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${HR}\n SOT-CAA-001 — Phase 2 Validation\n Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}\n Date: ${new Date().toISOString()}\n${HR}`);

  try {
    await validateLive();
    await validateDnsStates();
    await validateRecordStructures();
    await validateFlags();
    await validateValues();
    await validateEvidence();
    await validateTagsPresent();
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
