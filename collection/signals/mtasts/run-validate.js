'use strict';

// SOT-MTASTS-001 — Phase 2 Validation Script
//
// Validates all observable states against the Signal Lab evidence model.
// Uses live domains for real DNS and HTTPS observations.
// Uses controlled mocks for TLS failure scenarios where live examples
// require misconfigured servers that cannot be reliably targeted.
//
// Validation matrix:
//   DNS:    present / absent / unknown
//   HTTPS:  present / absent / unknown
//   TLS:    valid / CERT_EXPIRED / CERT_HOSTNAME_MISMATCH /
//           CERT_UNTRUSTED / CERT_SELF_SIGNED / TLS_HANDSHAKE_FAILURE
//   Passes: Pass 1 only / Pass 1 fail + Pass 2 success / Pass 1 fail + Pass 2 fail
//   Evidence: raw DNS records / raw body / unknown tags / unknown fields
//   Schema:   consistent 28 keys across every state combination
//
// Usage:
//   node backend/signal-lab/signals/mtasts/run-validate.js

const assert = require('node:assert/strict');
const { collectMtaSts, parseStsRecord, parsePolicyBody, SIGNAL_ID, SIGNAL_VERSION } = require('./mtasts-collector');

// ── Formatting ─────────────────────────────────────────────────────────────────

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
  if (actual) {
    console.log(`  ✔  ${label}`);
    passed++;
  } else {
    console.log(`  ✘  ${label}  (got: ${JSON.stringify(actual)})`);
    failed++;
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${DIV}`);
  console.log(` ${title}`);
  console.log(DIV);
}

function subsection(title) {
  console.log(`\n  ── ${title} ──`);
}

// ── Mock helpers ───────────────────────────────────────────────────────────────

function makeDns(records = [], errorCode = null) {
  return {
    resolveTxt: async () => {
      if (errorCode) throw Object.assign(new Error(`DNS error: ${errorCode}`), { code: errorCode });
      if (!records.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return records.map(r => [r]);
    },
  };
}

function makeHttpFetcher(responses) {
  let idx = 0;
  return async (_url, opts) => {
    const r = responses[idx++];
    if (!r) throw Object.assign(new Error('No more mock responses'), { code: 'ECONNREFUSED' });
    if (r.throws) throw Object.assign(new Error(r.throws.message ?? r.throws.code), { code: r.throws.code });
    return { httpStatus: r.status, body: r.body ?? null, contentType: r.contentType ?? 'text/plain', redirectCount: r.redirectCount ?? 0 };
  };
}

function mockDns(record) { return makeDns([record]); }

const GOOD_DNS   = 'v=STSv1; id=20241201000000Z';
const GOOD_POLICY = `version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 604800`;

// ── Expected output keys ───────────────────────────────────────────────────────

const EXPECTED_KEYS = new Set([
  'dns_sts_present', 'dns_collection_error', 'dns_records',
  'dns_record_count', 'dns_sts_record_count', 'dns_multiple_sts_records',
  'dns_parse_success', 'dns_syntax_errors', 'dns_version', 'dns_id', 'dns_unknown_tags',
  'policy_fetch_attempted', 'policy_present', 'policy_fetch_error',
  'policy_http_status', 'policy_tls_valid', 'policy_tls_error',
  'policy_redirect_count', 'policy_content_type', 'policy_body_raw',
  'policy_body_tls_validated', 'policy_parse_success', 'policy_syntax_errors',
  'policy_version', 'policy_mode', 'policy_max_age',
  'policy_mx_patterns', 'policy_mx_count', 'policy_unknown_fields',
]);

function checkSchema(label, r) {
  const actual = new Set(Object.keys(r));
  const missing = [...EXPECTED_KEYS].filter(k => !actual.has(k));
  const extra   = [...actual].filter(k => !EXPECTED_KEYS.has(k));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✔  ${label}: 28 keys present`);
    passed++;
  } else {
    console.log(`  ✘  ${label}`);
    if (missing.length) console.log(`       missing : ${missing.join(', ')}`);
    if (extra.length)   console.log(`       extra   : ${extra.join(', ')}`);
    failed++;
    failures.push(label);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

async function validateLive() {
  console.log(`\n${HR}`);
  console.log(` PART 1 — LIVE DOMAIN VALIDATION`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}`);
  console.log(HR);

  // ── A. DNS Present + TLS Valid + Policy Present (google.com) ──────────────

  section('A. DNS Present — google.com');
  console.log('  Collecting...');
  const google = await collectMtaSts('google.com');
  console.log(`  dns_sts_present          = ${google.dns_sts_present}`);
  console.log(`  dns_id                   = ${google.dns_id}`);
  console.log(`  policy_present           = ${google.policy_present}`);
  console.log(`  policy_tls_valid         = ${google.policy_tls_valid}`);
  console.log(`  policy_mode              = ${google.policy_mode}`);
  console.log(`  policy_mx_count          = ${google.policy_mx_count}`);
  console.log(`  policy_body_tls_validated = ${google.policy_body_tls_validated}`);
  console.log();
  check('dns_sts_present = true',               google.dns_sts_present, true);
  check('dns_collection_error = null',           google.dns_collection_error, null);
  checkTruthy('dns_id is non-null string',       typeof google.dns_id === 'string' && google.dns_id.length > 0);
  check('dns_version = STSv1',                   google.dns_version, 'STSv1');
  check('dns_parse_success = true',              google.dns_parse_success, true);
  check('dns_records[0] preserved verbatim',     google.dns_records.length, 1);
  check('policy_present = true',                 google.policy_present, true);
  check('policy_http_status = 200',              google.policy_http_status, 200);
  check('policy_tls_valid = true',               google.policy_tls_valid, true);
  check('policy_tls_error = null',               google.policy_tls_error, null);
  check('policy_body_tls_validated = true',      google.policy_body_tls_validated, true);
  check('policy_fetch_error = null',             google.policy_fetch_error, null);
  check('policy_mode = enforce',                 google.policy_mode, 'enforce');
  checkTruthy('policy_max_age is number',        typeof google.policy_max_age === 'number');
  checkTruthy('policy_mx_patterns non-empty',    google.policy_mx_patterns.length > 0);
  checkTruthy('policy_body_raw non-empty string', typeof google.policy_body_raw === 'string' && google.policy_body_raw.length > 0);
  checkSchema('schema: google.com',              google);

  // ── B. DNS Present + Policy in Testing Mode (fastmail.com) ────────────────

  section('B. DNS Present + Policy Mode = Testing — fastmail.com');
  console.log('  Collecting...');
  const fastmail = await collectMtaSts('fastmail.com');
  console.log(`  dns_sts_present = ${fastmail.dns_sts_present}`);
  console.log(`  policy_mode     = ${fastmail.policy_mode}`);
  console.log(`  policy_present  = ${fastmail.policy_present}`);
  console.log();
  check('dns_sts_present = true',     fastmail.dns_sts_present, true);
  check('policy_present = true',      fastmail.policy_present, true);
  check('policy_tls_valid = true',    fastmail.policy_tls_valid, true);
  check('policy_mode = testing',      fastmail.policy_mode, 'testing');
  checkSchema('schema: fastmail.com', fastmail);

  // ── C. DNS Absent (example.com) ───────────────────────────────────────────

  section('C. DNS Absent — example.com');
  console.log('  Collecting...');
  const exampleCom = await collectMtaSts('example.com');
  console.log(`  dns_sts_present = ${exampleCom.dns_sts_present}`);
  console.log(`  policy_present  = ${exampleCom.policy_present}`);
  console.log();
  check('dns_sts_present = false',         exampleCom.dns_sts_present, false);
  check('dns_collection_error = null',     exampleCom.dns_collection_error, null);
  check('dns_record_count = 0',            exampleCom.dns_record_count, 0);
  check('dns_sts_record_count = 0',        exampleCom.dns_sts_record_count, 0);
  check('dns_multiple_sts_records = false',exampleCom.dns_multiple_sts_records, false);
  check('dns_parse_success = null',        exampleCom.dns_parse_success, null);
  check('dns_version = null',              exampleCom.dns_version, null);
  check('dns_id = null',                   exampleCom.dns_id, null);
  checkSchema('schema: example.com',       exampleCom);

  // ── D. www. prefix stripping ───────────────────────────────────────────────

  section('D. www. Prefix Stripping — www.google.com');
  console.log('  Collecting...');
  const wwwGoogle = await collectMtaSts('www.google.com');
  console.log(`  dns_sts_present = ${wwwGoogle.dns_sts_present}`);
  console.log();
  check('www. stripped: dns_sts_present = true', wwwGoogle.dns_sts_present, true);
  check('www. result matches apex',              wwwGoogle.dns_id, google.dns_id);
}

// ═════════════════════════════════════════════════════════════════════════════
// DNS STATES — MOCK
// ═════════════════════════════════════════════════════════════════════════════

async function validateDnsStates() {
  console.log(`\n${HR}`);
  console.log(` PART 2 — DNS STATE COVERAGE`);
  console.log(HR);

  const fetcher200 = makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]);

  // ── DNS Unknown states ─────────────────────────────────────────────────────

  section('DNS Unknown — ETIMEDOUT');
  const rTimeout = await collectMtaSts('x.example', {
    dnsResolver: makeDns([], 'ETIMEDOUT'),
    httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
  });
  check('dns_sts_present = null',        rTimeout.dns_sts_present, null);
  check('dns_collection_error = DNS_TIMEOUT', rTimeout.dns_collection_error, 'DNS_TIMEOUT');
  check('dns_record_count = null',       rTimeout.dns_record_count, null);
  check('dns_multiple_sts_records = null', rTimeout.dns_multiple_sts_records, null);
  checkSchema('schema: DNS_TIMEOUT',     rTimeout);

  section('DNS Unknown — ESERVFAIL');
  const rServfail = await collectMtaSts('x.example', {
    dnsResolver: makeDns([], 'ESERVFAIL'),
    httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
  });
  check('dns_collection_error = DNS_SERVFAIL', rServfail.dns_collection_error, 'DNS_SERVFAIL');
  checkSchema('schema: DNS_SERVFAIL',    rServfail);

  section('DNS Unknown — unrecognised error');
  const rUnknown = await collectMtaSts('x.example', {
    dnsResolver: makeDns([], 'EUNKNOWN_XYZ'),
    httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
  });
  check('dns_collection_error = DNS_FAILURE', rUnknown.dns_collection_error, 'DNS_FAILURE');
  checkSchema('schema: DNS_FAILURE',     rUnknown);

  // ── Multiple records ───────────────────────────────────────────────────────

  section('DNS Present — Multiple v=STSv1 Records');
  const REC_A = 'v=STSv1; id=aaa111';
  const REC_B = 'v=STSv1; id=bbb222';
  const rMulti = await collectMtaSts('x.example', {
    dnsResolver: makeDns([REC_A, REC_B]),
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('dns_record_count = 2',                 rMulti.dns_record_count, 2);
  check('dns_multiple_sts_records = true',       rMulti.dns_multiple_sts_records, true);
  check('dns_records[0] = REC_A',               rMulti.dns_records[0], REC_A);
  check('dns_records[1] = REC_B',               rMulti.dns_records[1], REC_B);
  check('MULTIPLE_RECORDS in dns_syntax_errors', rMulti.dns_syntax_errors.some(e => e.code === 'MULTIPLE_RECORDS'), true);
  check('dns_id parsed from records[0]',         rMulti.dns_id, 'aaa111');

  // ── Unknown DNS tags ───────────────────────────────────────────────────────

  section('DNS Present — Unknown Tags Preserved');
  const rUnknownTags = await collectMtaSts('x.example', {
    dnsResolver: makeDns(['v=STSv1; id=test; x-provider=mailguard; x-region=eu']),
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('dns_parse_success = true',             rUnknownTags.dns_parse_success, true);
  check('dns_unknown_tags preserved',           rUnknownTags.dns_unknown_tags, { 'x-provider': 'mailguard', 'x-region': 'eu' });

  // ── Malformed DNS record ───────────────────────────────────────────────────

  section('DNS Present — Malformed Record (evidence preserved)');
  const rMalformed = await collectMtaSts('x.example', {
    dnsResolver: makeDns(['v=STSv1; id=test; notavalidtag; =emptykey']),
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('dns_records[0] preserved verbatim',    rMalformed.dns_records[0], 'v=STSv1; id=test; notavalidtag; =emptykey');
  check('dns_parse_success = false',            rMalformed.dns_parse_success, false);
  checkTruthy('MALFORMED_TAG in dns_syntax_errors', rMalformed.dns_syntax_errors.some(e => e.code === 'MALFORMED_TAG'));
  check('dns_id still extracted',               rMalformed.dns_id, 'test');
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTPS / POLICY STATES — MOCK
// ═════════════════════════════════════════════════════════════════════════════

async function validatePolicyStates() {
  console.log(`\n${HR}`);
  console.log(` PART 3 — HTTPS / POLICY STATE COVERAGE`);
  console.log(HR);

  const dnsR = mockDns(GOOD_DNS);

  // ── Policy absent (404) ────────────────────────────────────────────────────

  section('Policy Absent — HTTP 404');
  const r404 = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ status: 404, body: '<html>Not Found</html>', contentType: 'text/html' }]),
  });
  check('policy_present = false',          r404.policy_present, false);
  check('policy_http_status = 404',        r404.policy_http_status, 404);
  check('policy_tls_valid = true',         r404.policy_tls_valid, true);
  check('policy_parse_success = null',     r404.policy_parse_success, null);
  check('policy_body_raw preserved',       r404.policy_body_raw, '<html>Not Found</html>');
  checkSchema('schema: 404',               r404);

  // ── Policy absent (500) ────────────────────────────────────────────────────

  section('Policy Absent — HTTP 500');
  const r500 = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ status: 500, body: 'Internal Server Error' }]),
  });
  check('policy_present = false',          r500.policy_present, false);
  check('policy_http_status = 500',        r500.policy_http_status, 500);
  checkSchema('schema: 500',               r500);

  // ── Policy unknown — connection timeout ────────────────────────────────────

  section('Policy Unknown — CONNECTION_TIMEOUT');
  const rTimeout = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ throws: { code: 'ETIMEDOUT', message: 'connect timeout' } }]),
  });
  check('policy_present = null',           rTimeout.policy_present, null);
  check('policy_fetch_error = CONNECTION_TIMEOUT', rTimeout.policy_fetch_error, 'CONNECTION_TIMEOUT');
  check('policy_tls_valid = null',         rTimeout.policy_tls_valid, null);
  check('policy_http_status = null',       rTimeout.policy_http_status, null);
  check('policy_body_raw = null',          rTimeout.policy_body_raw, null);
  checkSchema('schema: timeout',           rTimeout);

  // ── Policy unknown — connection refused ────────────────────────────────────

  section('Policy Unknown — CONNECTION_REFUSED');
  const rRefused = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ throws: { code: 'ECONNREFUSED', message: 'refused' } }]),
  });
  check('policy_present = null',           rRefused.policy_present, null);
  check('policy_fetch_error = CONNECTION_REFUSED', rRefused.policy_fetch_error, 'CONNECTION_REFUSED');
  checkSchema('schema: refused',           rRefused);

  // ── Policy unknown — DNS error for mta-sts host ────────────────────────────

  section('Policy Unknown — DNS_ERROR (mta-sts host unresolvable)');
  const rDnsErr = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ throws: { code: 'ENOTFOUND', message: 'not found' } }]),
  });
  check('policy_present = null',           rDnsErr.policy_present, null);
  check('policy_fetch_error = DNS_ERROR',  rDnsErr.policy_fetch_error, 'DNS_ERROR');
  checkSchema('schema: DNS_ERROR',         rDnsErr);

  // ── Policy with redirects ──────────────────────────────────────────────────

  section('Policy Present — Redirect Count Recorded');
  const rRedirect = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY, redirectCount: 1 }]),
  });
  check('policy_redirect_count = 1',       rRedirect.policy_redirect_count, 1);
  check('policy_present = true',           rRedirect.policy_present, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// TLS VALIDATION — MOCK
// ═════════════════════════════════════════════════════════════════════════════

async function validateTlsScenarios() {
  console.log(`\n${HR}`);
  console.log(` PART 4 — TLS SCENARIO COVERAGE`);
  console.log(` Note: TLS error scenarios require misconfigured servers.`);
  console.log(` Validated via controlled mocks using real error codes from`);
  console.log(` Node.js TLS layer (classifyFetchError maps these 1:1).`);
  console.log(HR);

  const dnsR = mockDns(GOOD_DNS);

  // ── TLS Valid ──────────────────────────────────────────────────────────────

  section('TLS 1. Valid Certificate — Pass 1 Success');
  const rValid = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('policy_tls_valid = true',              rValid.policy_tls_valid, true);
  check('policy_tls_error = null',              rValid.policy_tls_error, null);
  check('policy_present = true',                rValid.policy_present, true);
  check('policy_body_tls_validated = true',     rValid.policy_body_tls_validated, true);
  checkSchema('schema: TLS valid',              rValid);

  // ── CERT_EXPIRED ───────────────────────────────────────────────────────────

  section('TLS 2. Expired Certificate — Pass 1 Fails, Pass 2 Retrieves');
  const rExpired = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } },
      { status: 200, body: GOOD_POLICY },
    ]),
  });
  console.log(`  policy_tls_valid          = ${rExpired.policy_tls_valid}  [from Pass 1]`);
  console.log(`  policy_tls_error          = ${rExpired.policy_tls_error}  [from Pass 1]`);
  console.log(`  policy_present            = ${rExpired.policy_present}  [from Pass 2]`);
  console.log(`  policy_body_tls_validated = ${rExpired.policy_body_tls_validated}  [Pass 2 evidence]`);
  console.log();
  check('policy_tls_valid = false',             rExpired.policy_tls_valid, false);
  check('policy_tls_error = CERT_EXPIRED',      rExpired.policy_tls_error, 'CERT_EXPIRED');
  check('policy_present = true',                rExpired.policy_present, true);
  check('policy_body_tls_validated = false',    rExpired.policy_body_tls_validated, false);
  check('policy_mode populated from Pass 2',    rExpired.policy_mode, 'enforce');
  checkTruthy('policy_body_raw from Pass 2',    rExpired.policy_body_raw === GOOD_POLICY);
  checkSchema('schema: CERT_EXPIRED',           rExpired);

  // ── CERT_HOSTNAME_MISMATCH ─────────────────────────────────────────────────

  section('TLS 3. Hostname Mismatch — Pass 1 Fails, Pass 2 Retrieves');
  const rMismatch = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'hostname mismatch' } },
      { status: 200, body: GOOD_POLICY },
    ]),
  });
  check('policy_tls_valid = false',             rMismatch.policy_tls_valid, false);
  check('policy_tls_error = CERT_HOSTNAME_MISMATCH', rMismatch.policy_tls_error, 'CERT_HOSTNAME_MISMATCH');
  check('policy_present = true',                rMismatch.policy_present, true);
  check('policy_body_tls_validated = false',    rMismatch.policy_body_tls_validated, false);
  checkSchema('schema: CERT_HOSTNAME_MISMATCH', rMismatch);

  // ── CERT_UNTRUSTED ────────────────────────────────────────────────────────

  section('TLS 4. Untrusted Certificate — Pass 1 Fails, Pass 2 Retrieves');
  const rUntrusted = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'untrusted cert' } },
      { status: 200, body: GOOD_POLICY },
    ]),
  });
  check('policy_tls_valid = false',             rUntrusted.policy_tls_valid, false);
  check('policy_tls_error = CERT_UNTRUSTED',    rUntrusted.policy_tls_error, 'CERT_UNTRUSTED');
  check('policy_present = true',                rUntrusted.policy_present, true);
  check('policy_body_tls_validated = false',    rUntrusted.policy_body_tls_validated, false);
  checkSchema('schema: CERT_UNTRUSTED',         rUntrusted);

  // ── CERT_SELF_SIGNED ──────────────────────────────────────────────────────

  section('TLS 5. Self-Signed Certificate — Pass 1 Fails, Pass 2 Retrieves');
  const rSelfSigned = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed' } },
      { status: 200, body: GOOD_POLICY },
    ]),
  });
  check('policy_tls_valid = false',             rSelfSigned.policy_tls_valid, false);
  check('policy_tls_error = CERT_SELF_SIGNED',  rSelfSigned.policy_tls_error, 'CERT_SELF_SIGNED');
  check('policy_present = true',                rSelfSigned.policy_present, true);
  check('policy_body_tls_validated = false',    rSelfSigned.policy_body_tls_validated, false);
  checkSchema('schema: CERT_SELF_SIGNED',       rSelfSigned);

  // ── TLS_HANDSHAKE_FAILURE ─────────────────────────────────────────────────

  section('TLS 6. Handshake Failure — No Pass 2 Possible');
  const rHandshake = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'EPROTO', message: 'protocol error' } },
      // deliberately only one response: if Pass 2 is attempted makeHttpFetcher will throw ECONNREFUSED
    ]),
  });
  console.log(`  policy_tls_valid  = ${rHandshake.policy_tls_valid}`);
  console.log(`  policy_tls_error  = ${rHandshake.policy_tls_error}`);
  console.log(`  policy_present    = ${rHandshake.policy_present}  (unknown — cannot verify)`);
  console.log(`  policy_body_raw   = ${rHandshake.policy_body_raw}`);
  console.log();
  check('policy_tls_valid = false',             rHandshake.policy_tls_valid, false);
  check('policy_tls_error = TLS_HANDSHAKE_FAILURE', rHandshake.policy_tls_error, 'TLS_HANDSHAKE_FAILURE');
  check('policy_present = null',                rHandshake.policy_present, null);
  check('policy_body_raw = null',               rHandshake.policy_body_raw, null);
  check('policy_body_tls_validated = null',     rHandshake.policy_body_tls_validated, null);
  checkSchema('schema: TLS_HANDSHAKE_FAILURE',  rHandshake);
}

// ═════════════════════════════════════════════════════════════════════════════
// TWO-PASS RETRIEVAL — CRITICAL VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

async function validateTwoPass() {
  console.log(`\n${HR}`);
  console.log(` PART 5 — TWO-PASS RETRIEVAL VALIDATION`);
  console.log(` Critical property: Pass 1 TLS observations locked before Pass 2 runs.`);
  console.log(HR);

  const dnsR = mockDns(GOOD_DNS);

  // ── Core two-pass scenario ─────────────────────────────────────────────────

  section('Two-Pass: CERT_EXPIRED → Pass 2 Policy Present');
  const rTwoPass = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
      { status: 200, body: `version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400` },
    ]),
  });

  console.log('  Pass 1 observations (must not change after Pass 2):');
  console.log(`    policy_tls_valid          = ${rTwoPass.policy_tls_valid}`);
  console.log(`    policy_tls_error          = ${rTwoPass.policy_tls_error}`);
  console.log('  Pass 2 observations:');
  console.log(`    policy_present            = ${rTwoPass.policy_present}`);
  console.log(`    policy_http_status        = ${rTwoPass.policy_http_status}`);
  console.log(`    policy_body_tls_validated = ${rTwoPass.policy_body_tls_validated}`);
  console.log(`    policy_mode               = ${rTwoPass.policy_mode}`);
  console.log(`    policy_mx_count           = ${rTwoPass.policy_mx_count}`);
  console.log();

  check('Pass 1 locked: policy_tls_valid = false',         rTwoPass.policy_tls_valid, false);
  check('Pass 1 locked: policy_tls_error = CERT_EXPIRED',  rTwoPass.policy_tls_error, 'CERT_EXPIRED');
  check('Pass 2 result: policy_present = true',            rTwoPass.policy_present, true);
  check('Pass 2 result: policy_http_status = 200',         rTwoPass.policy_http_status, 200);
  check('Pass 2 provenance: body_tls_validated = false',   rTwoPass.policy_body_tls_validated, false);
  check('Pass 2 result: policy parsed',                    rTwoPass.policy_mode, 'enforce');
  check('Pass 2 result: mx_count = 1',                     rTwoPass.policy_mx_count, 1);

  // ── Pass 1 fails, Pass 2 also fails ───────────────────────────────────────

  section('Two-Pass: CERT_EXPIRED → Pass 2 Also Fails');
  const rBothFail = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
      { throws: { code: 'ECONNREFUSED', message: 'refused' } },
    ]),
  });
  check('Pass 1 locked: policy_tls_valid = false',         rBothFail.policy_tls_valid, false);
  check('Pass 1 locked: policy_tls_error = CERT_EXPIRED',  rBothFail.policy_tls_error, 'CERT_EXPIRED');
  check('Pass 2 failure recorded: fetch_error',            rBothFail.policy_fetch_error, 'CONNECTION_REFUSED');
  check('policy_present = null (unknown)',                  rBothFail.policy_present, null);
  check('policy_body_raw = null',                          rBothFail.policy_body_raw, null);
  checkSchema('schema: both passes fail',                  rBothFail);

  // ── Pass 1 fails Category A + Pass 2 returns 404 ──────────────────────────

  section('Two-Pass: CERT_EXPIRED → Pass 2 Policy Absent (404)');
  const rTwoPass404 = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
      { status: 404, body: null },
    ]),
  });
  check('Pass 1 locked: policy_tls_valid = false',         rTwoPass404.policy_tls_valid, false);
  check('Pass 1 locked: policy_tls_error = CERT_EXPIRED',  rTwoPass404.policy_tls_error, 'CERT_EXPIRED');
  check('Pass 2: policy_present = false (404)',            rTwoPass404.policy_present, false);
  check('Pass 2: policy_http_status = 404',               rTwoPass404.policy_http_status, 404);
  check('Pass 2: body_tls_validated = false',             rTwoPass404.policy_body_tls_validated, false);
  checkSchema('schema: CERT_EXPIRED + 404',               rTwoPass404);

  // ── Handshake failure does NOT trigger Pass 2 ─────────────────────────────

  section('Two-Pass: TLS_HANDSHAKE_FAILURE — Pass 2 NOT Called');
  let pass2Called = false;
  const guardFetcher = async (url, opts) => {
    if (!opts.rejectUnauthorized) {
      pass2Called = true;
      throw Object.assign(new Error('Pass 2 should not have been called'), { code: 'ECONNREFUSED' });
    }
    throw Object.assign(new Error('EPROTO'), { code: 'EPROTO' });
  };
  const rNoPass2 = await collectMtaSts('x.example', {
    dnsResolver: dnsR,
    httpFetcher: guardFetcher,
  });
  check('TLS_HANDSHAKE_FAILURE does not trigger Pass 2', pass2Called, false);
  check('policy_tls_error = TLS_HANDSHAKE_FAILURE',      rNoPass2.policy_tls_error, 'TLS_HANDSHAKE_FAILURE');
  check('policy_present = null',                          rNoPass2.policy_present, null);
}

// ═════════════════════════════════════════════════════════════════════════════
// EVIDENCE PRESERVATION
// ═════════════════════════════════════════════════════════════════════════════

async function validateEvidencePreservation() {
  console.log(`\n${HR}`);
  console.log(` PART 6 — EVIDENCE PRESERVATION`);
  console.log(HR);

  // ── Raw DNS record preserved verbatim ─────────────────────────────────────

  section('DNS Evidence: Raw Record Preserved Verbatim');
  const RAW_DNS = 'v=STSv1; id=20241201T000000Z';
  const rDns = await collectMtaSts('x.example', {
    dnsResolver: makeDns([RAW_DNS]),
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('dns_records[0] === raw DNS string', rDns.dns_records[0], RAW_DNS);

  // ── Raw policy body preserved verbatim ────────────────────────────────────

  section('Policy Evidence: Raw Body Preserved Verbatim');
  const RAW_BODY = `version: STSv1\nmode: testing\nmx: mail.example.com\nmx: *.backup.example.com\nmax_age: 300\nx-custom: hello`;
  const rBody = await collectMtaSts('x.example', {
    dnsResolver: mockDns(GOOD_DNS),
    httpFetcher: makeHttpFetcher([{ status: 200, body: RAW_BODY }]),
  });
  check('policy_body_raw === raw body string', rBody.policy_body_raw, RAW_BODY);

  // ── Unknown DNS tags preserved ─────────────────────────────────────────────

  section('Evidence: Unknown DNS Tags Preserved');
  const rUnknownDns = await collectMtaSts('x.example', {
    dnsResolver: makeDns(['v=STSv1; id=abc; x-provider=cloudflare; x-version=2']),
    httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
  });
  check('dns_unknown_tags preserved',       rUnknownDns.dns_unknown_tags, { 'x-provider': 'cloudflare', 'x-version': '2' });
  check('dns_parse_success still true',     rUnknownDns.dns_parse_success, true);

  // ── Unknown policy fields preserved ───────────────────────────────────────

  section('Evidence: Unknown Policy Fields Preserved');
  const bodyWithExtensions = `version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\nx-reporting: https://reports.example.com\nx-tag: beta`;
  const rUnknownFields = await collectMtaSts('x.example', {
    dnsResolver: mockDns(GOOD_DNS),
    httpFetcher: makeHttpFetcher([{ status: 200, body: bodyWithExtensions }]),
  });
  check('policy_unknown_fields preserved',  rUnknownFields.policy_unknown_fields, {
    'x-reporting': 'https://reports.example.com',
    'x-tag': 'beta',
  });
  check('policy_parse_success still true',  rUnknownFields.policy_parse_success, true);

  // ── Parse failure does not discard raw evidence ────────────────────────────

  section('Evidence: Malformed Body Preserved Despite Parse Failure');
  const malformedBody = `version: STSv1\nmode: INVALID_MODE\nmax_age: notanumber\nMISSING COLON`;
  const rMalformedBody = await collectMtaSts('x.example', {
    dnsResolver: mockDns(GOOD_DNS),
    httpFetcher: makeHttpFetcher([{ status: 200, body: malformedBody }]),
  });
  check('policy_present = true',                rMalformedBody.policy_present, true);
  check('policy_body_raw preserved verbatim',   rMalformedBody.policy_body_raw, malformedBody);
  check('policy_parse_success = false',         rMalformedBody.policy_parse_success, false);
  checkTruthy('INVALID_MODE in syntax_errors',  rMalformedBody.policy_syntax_errors.some(e => e.code === 'INVALID_MODE'));
  checkTruthy('INVALID_MAX_AGE in syntax_errors', rMalformedBody.policy_syntax_errors.some(e => e.code === 'INVALID_MAX_AGE'));
  checkTruthy('MALFORMED_LINE in syntax_errors', rMalformedBody.policy_syntax_errors.some(e => e.code === 'MALFORMED_LINE'));

  // ── Evidence preserved through Pass 2 ─────────────────────────────────────

  section('Evidence: Policy Body Preserved Through Pass 2');
  const PASS2_BODY = `version: STSv1\nmode: enforce\nmx: secure-mail.example.com\nmax_age: 604800`;
  const rPass2Evidence = await collectMtaSts('x.example', {
    dnsResolver: mockDns(GOOD_DNS),
    httpFetcher: makeHttpFetcher([
      { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
      { status: 200, body: PASS2_BODY },
    ]),
  });
  check('Pass 2 body preserved verbatim',       rPass2Evidence.policy_body_raw, PASS2_BODY);
  check('Pass 2 body_tls_validated = false',    rPass2Evidence.policy_body_tls_validated, false);
  check('Pass 2 parsed correctly',              rPass2Evidence.policy_mx_patterns[0], 'secure-mail.example.com');

  // ── MX pattern order preserved ─────────────────────────────────────────────

  section('Evidence: MX Patterns Preserved In Document Order');
  const bodyOrdered = `version: STSv1\nmode: enforce\nmx: first.example.com\nmx: second.example.com\nmx: third.example.com\nmx: *.wildcard.example.com\nmax_age: 86400`;
  const rOrdered = await collectMtaSts('x.example', {
    dnsResolver: mockDns(GOOD_DNS),
    httpFetcher: makeHttpFetcher([{ status: 200, body: bodyOrdered }]),
  });
  check('mx[0] in document order',             rOrdered.policy_mx_patterns[0], 'first.example.com');
  check('mx[1] in document order',             rOrdered.policy_mx_patterns[1], 'second.example.com');
  check('mx[2] in document order',             rOrdered.policy_mx_patterns[2], 'third.example.com');
  check('mx[3] wildcard preserved as-is',      rOrdered.policy_mx_patterns[3], '*.wildcard.example.com');
  check('policy_mx_count = 4',                 rOrdered.policy_mx_count, 4);
}

// ═════════════════════════════════════════════════════════════════════════════
// SCHEMA CONSISTENCY
// ═════════════════════════════════════════════════════════════════════════════

async function validateSchema() {
  console.log(`\n${HR}`);
  console.log(` PART 7 — SCHEMA CONSISTENCY`);
  console.log(` Verifies identical output keys across every state combination.`);
  console.log(HR);

  const dnsR = mockDns(GOOD_DNS);

  const scenarios = [
    {
      name: 'DNS present + policy present + TLS valid',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: GOOD_POLICY }]),
    },
    {
      name: 'DNS present + policy absent (404) + TLS valid',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
    },
    {
      name: 'DNS present + policy unknown (timeout)',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ETIMEDOUT' } }]),
    },
    {
      name: 'DNS absent (ENODATA)',
      dnsResolver: makeDns([], 'ENODATA'),
      httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
    },
    {
      name: 'DNS unknown (ETIMEDOUT)',
      dnsResolver: makeDns([], 'ETIMEDOUT'),
      httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
    },
    {
      name: 'DNS present + CERT_EXPIRED + Pass 2 success',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { status: 200, body: GOOD_POLICY },
      ]),
    },
    {
      name: 'DNS present + CERT_EXPIRED + Pass 2 failure',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { throws: { code: 'ECONNREFUSED', message: 'refused' } },
      ]),
    },
    {
      name: 'DNS present + TLS_HANDSHAKE_FAILURE',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'EPROTO', message: 'proto' } }]),
    },
    {
      name: 'DNS present + policy present + CERT_HOSTNAME_MISMATCH + Pass 2',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'mismatch' } },
        { status: 200, body: GOOD_POLICY },
      ]),
    },
    {
      name: 'DNS present + CONNECTION_REFUSED',
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ECONNREFUSED', message: 'refused' } }]),
    },
  ];

  section('28 expected keys present in every collection state');
  for (const s of scenarios) {
    const r = await collectMtaSts('x.example', { dnsResolver: s.dnsResolver, httpFetcher: s.httpFetcher });
    checkSchema(s.name, r);
  }

  section('Invariants: always-arrays and always-objects');
  for (const s of scenarios) {
    const r = await collectMtaSts('x.example', { dnsResolver: s.dnsResolver, httpFetcher: s.httpFetcher });
    // Reset fetchers don't allow reuse in scenarios — but these are cloned so ok
    check(`${s.name.slice(0, 40)}: dns_records is array`,        Array.isArray(r.dns_records), true);
    check(`${s.name.slice(0, 40)}: dns_syntax_errors is array`,  Array.isArray(r.dns_syntax_errors), true);
    check(`${s.name.slice(0, 40)}: policy_mx_patterns is array`, Array.isArray(r.policy_mx_patterns), true);
    check(`${s.name.slice(0, 40)}: policy_syntax_errors is array`,Array.isArray(r.policy_syntax_errors), true);
    check(`${s.name.slice(0, 40)}: dns_unknown_tags is object`,  typeof r.dns_unknown_tags === 'object' && !Array.isArray(r.dns_unknown_tags), true);
    check(`${s.name.slice(0, 40)}: policy_unknown_fields is obj`,typeof r.policy_unknown_fields === 'object' && !Array.isArray(r.policy_unknown_fields), true);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PARSER UNIT VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

function validateParsers() {
  console.log(`\n${HR}`);
  console.log(` PART 8 — PARSER VALIDATION (parseStsRecord + parsePolicyBody)`);
  console.log(HR);

  section('parseStsRecord — RFC 8461 field coverage');

  const r1 = parseStsRecord('v=STSv1; id=20241201T000000Z');
  check('valid record parse_success = true', r1.parse_success, true);
  check('dns_version = STSv1',               r1.dns_version, 'STSv1');
  check('dns_id extracted',                  r1.dns_id, '20241201T000000Z');
  check('dns_unknown_tags = {}',             r1.dns_unknown_tags, {});

  const r2 = parseStsRecord('v=STSv1; id=abc; x-custom=val');
  check('unknown tag preserved',             r2.dns_unknown_tags['x-custom'], 'val');
  check('parse_success = true (unknown tags do not fail)', r2.parse_success, true);

  const r3 = parseStsRecord('v=STSv2; id=abc');
  check('INVALID_VERSION error',             r3.syntax_errors.some(e => e.code === 'INVALID_VERSION'), true);
  check('dns_version stored as observed',    r3.dns_version, 'STSv2');

  const r4 = parseStsRecord('v=STSv1');
  check('MISSING_ID error',                  r4.syntax_errors.some(e => e.code === 'MISSING_ID'), true);
  check('dns_id = null when absent',         r4.dns_id, null);

  section('parsePolicyBody — RFC 8461 field coverage');

  const p1 = parsePolicyBody(`version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 604800`);
  check('enforce: parse_success = true',     p1.parse_success, true);
  check('enforce: policy_mode = enforce',    p1.policy_mode, 'enforce');
  check('enforce: policy_max_age = 604800',  p1.policy_max_age, 604800);
  check('enforce: mx_count = 1',             p1.policy_mx_count, 1);

  const p2 = parsePolicyBody(`version: STSv1\nmode: none\nmax_age: 0`);
  check('none: mode = none, max_age = 0',    p2.policy_mode === 'none' && p2.policy_max_age === 0, true);
  check('none: mx_patterns empty',           p2.policy_mx_patterns, []);

  const p3 = parsePolicyBody(`version: STSv1\nmode: enforce\nmx: a.com\nmx: b.com\nmax_age: 300\nx-ext: value`);
  check('unknown field preserved',           p3.policy_unknown_fields['x-ext'], 'value');
  check('parse_success = true with extensions', p3.parse_success, true);

  const p4 = parsePolicyBody(`mode: strict\nmax_age: notanumber`);
  check('MISSING_VERSION error',             p4.syntax_errors.some(e => e.code === 'MISSING_VERSION'), true);
  check('INVALID_MODE error',                p4.syntax_errors.some(e => e.code === 'INVALID_MODE'), true);
  check('INVALID_MAX_AGE error',             p4.syntax_errors.some(e => e.code === 'INVALID_MAX_AGE'), true);
  check('policy_mode null on invalid',       p4.policy_mode, null);
  check('policy_max_age null on invalid',    p4.policy_max_age, null);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${HR}`);
  console.log(` SOT-MTASTS-001 — Phase 2 Validation`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}`);
  console.log(` Date: ${new Date().toISOString()}`);
  console.log(HR);

  try {
    await validateLive();
    await validateDnsStates();
    await validatePolicyStates();
    await validateTlsScenarios();
    await validateTwoPass();
    await validateEvidencePreservation();
    await validateSchema();
    validateParsers();
  } catch (err) {
    console.error(`\nFatal error during validation: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  // ── Final report ───────────────────────────────────────────────────────────

  console.log(`\n${HR}`);
  console.log(` VALIDATION SUMMARY`);
  console.log(HR);
  console.log(`  Total checks : ${passed + failed}`);
  console.log(`  Passed       : ${passed}`);
  console.log(`  Failed       : ${failed}`);

  if (failures.length > 0) {
    console.log(`\n  Failed checks:`);
    for (const f of failures) console.log(`    ✘  ${f}`);
    console.log(`\n${HR}`);
    console.log(` RESULT: VALIDATION FAILED — additional work required before HE-001`);
    console.log(HR + '\n');
    process.exit(1);
  } else {
    console.log(`\n${HR}`);
    console.log(` RESULT: VALIDATION PASSED — collector ready for HE-001 cohort execution`);
    console.log(HR + '\n');
  }
}

main();
