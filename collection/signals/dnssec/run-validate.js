'use strict';

// SOT-DNSSEC-001 — Validation Runner
//
// Phase 1: Synthetic validation (all mocked) — covers all state combinations,
//          derived observations, evidence preservation, and schema consistency.
//
// Phase 2: Live DNS validation — uses real DNS to verify the DoH integration works.
//          Only negative cases (DS absent, DNSKEY absent) are assumed reliable;
//          positive live tests use cloudflare.com which deploys DNSSEC.
//
// Usage:  node backend/signal-lab/signals/dnssec/run-validate.js
//
// No Supabase writes. Validation only.

const { collectDnssec, computeKeyTag } = require('./dnssec-collector');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, details) {
  if (condition) {
    process.stdout.write(`  ✔ ${label}\n`);
    passed++;
  } else {
    process.stdout.write(`  ✘ ${label}${details ? `\n      ${details}` : ''}\n`);
    failed++;
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

// ── Mock builders ─────────────────────────────────────────────────────────────

const DNS_TYPE_DS     = 43;
const DNS_TYPE_DNSKEY = 48;

function doaResponse(answers = []) {
  return { Status: 0, Answer: answers };
}

function dsAnswer(keyTag, algorithm, digestType, digest) {
  return { type: DNS_TYPE_DS, data: `${keyTag} ${algorithm} ${digestType} ${digest}` };
}

function dnskeyAnswer(flags, protocol, algorithm, publicKey) {
  return { type: DNS_TYPE_DNSKEY, data: `${flags} ${protocol} ${algorithm} ${publicKey}` };
}

function makeError(code) {
  const e = new Error(code); e.code = code; return e;
}

function makeMock(dsResponse, dnskeyResponse) {
  return {
    async queryDS()     { return dsResponse; },
    async queryDNSKEY() { return dnskeyResponse; },
  };
}

function makeThrowMock(dsError, dnskeyError) {
  return {
    async queryDS()     { if (dsError)     throw makeError(dsError);     return doaResponse(); },
    async queryDNSKEY() { if (dnskeyError) throw makeError(dnskeyError); return doaResponse(); },
  };
}

// Test key material
const TEST_KEY    = 'YWJj';            // base64([0x61,0x62,0x63])
const TEST_KEYTAG = 51312;             // computed per RFC 4034 Appendix B for flags=257, protocol=3, algorithm=13, key=TEST_KEY

const DS_A  = dsAnswer(12345, 13, 2, 'AABBCCDD');
const DS_B  = dsAnswer(54321,  8, 2, 'EEFF0011');
const KSK   = dnskeyAnswer(257, 3, 13, TEST_KEY);
const ZSK   = dnskeyAnswer(256, 3, 13, TEST_KEY);

// Schema
const EXPECTED_KEYS = new Set([
  'dns_ds_present', 'ds_collection_error', 'ds_records', 'ds_record_count',
  'ds_algorithms', 'ds_digest_types', 'ds_key_tags',
  'dns_dnskey_present', 'dnskey_collection_error', 'dnskey_records', 'dnskey_record_count',
  'dnskey_ksk_count', 'dnskey_zsk_count', 'dnskey_other_flags_count',
  'dnskey_algorithms', 'dnskey_key_tags',
]);

function checkSchema(label, r) {
  const keys = Object.keys(r);
  const missing = [...EXPECTED_KEYS].filter(k => !keys.includes(k));
  const extra   = keys.filter(k => !EXPECTED_KEYS.has(k));
  check(`${label} — 16 expected keys present`, missing.length === 0 && extra.length === 0,
    missing.length ? `Missing: ${missing.join(', ')}` : extra.length ? `Extra: ${extra.join(', ')}` : '');
}

// ── Phase 1: Synthetic validation ─────────────────────────────────────────────

async function phase1() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  PHASE 1 — SYNTHETIC VALIDATION (mocked DNS)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // ── 1. DS states ──────────────────────────────────────────────────────────

  section('1. DS STATES');

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse([DS_A]), doaResponse()) });
    check('DS present → dns_ds_present = true',   r.dns_ds_present === true);
    check('DS present → ds_collection_error null', r.ds_collection_error === null);
    check('DS present → ds_record_count = 1',     r.ds_record_count === 1);
    check('DS present → ds_records[0].key_tag',   r.ds_records[0]?.key_tag === 12345);
    check('DS present → ds_records[0].algorithm', r.ds_records[0]?.algorithm === 13);
    check('DS present → ds_records[0].digest',    r.ds_records[0]?.digest === 'AABBCCDD');
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse([]), doaResponse()) });
    check('DS absent (NODATA) → dns_ds_present = false',     r.dns_ds_present === false);
    check('DS absent (NODATA) → ds_record_count = 0',        r.ds_record_count === 0);
    check('DS absent (NODATA) → ds_collection_error = null', r.ds_collection_error === null);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock({ Status: 3, Answer: [] }, doaResponse()) });
    check('DS absent (NXDOMAIN) → dns_ds_present = false', r.dns_ds_present === false);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeThrowMock('ECONNABORTED', null) });
    check('DS timeout → dns_ds_present = null',        r.dns_ds_present === null);
    check('DS timeout → ds_collection_error TIMEOUT',  r.ds_collection_error === 'DNS_TIMEOUT');
    check('DS timeout → ds_record_count null',         r.ds_record_count === null);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock({ Status: 2, Answer: [] }, doaResponse()) });
    check('DS SERVFAIL → dns_ds_present = null',          r.dns_ds_present === null);
    check('DS SERVFAIL → ds_collection_error SERVFAIL',   r.ds_collection_error === 'DNS_SERVFAIL');
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeThrowMock('ECONNREFUSED', null) });
    check('DS generic failure → dns_ds_present = null',       r.dns_ds_present === null);
    check('DS generic failure → ds_collection_error FAILURE', r.ds_collection_error === 'DNS_FAILURE');
  }

  // ── 2. DNSKEY states ──────────────────────────────────────────────────────

  section('2. DNSKEY STATES');

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse(), doaResponse([KSK])) });
    check('DNSKEY present → dns_dnskey_present = true',    r.dns_dnskey_present === true);
    check('DNSKEY present → dnskey_collection_error null', r.dnskey_collection_error === null);
    check('DNSKEY present → dnskey_record_count = 1',      r.dnskey_record_count === 1);
    check('DNSKEY present → flags preserved',              r.dnskey_records[0]?.flags === 257);
    check('DNSKEY present → algorithm preserved',          r.dnskey_records[0]?.algorithm === 13);
    check('DNSKEY present → public_key preserved verbatim', r.dnskey_records[0]?.public_key === TEST_KEY);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse(), doaResponse([])) });
    check('DNSKEY absent (NODATA) → dns_dnskey_present = false', r.dns_dnskey_present === false);
    check('DNSKEY absent (NODATA) → dnskey_record_count = 0',    r.dnskey_record_count === 0);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse(), { Status: 3, Answer: [] }) });
    check('DNSKEY absent (NXDOMAIN) → dns_dnskey_present = false', r.dns_dnskey_present === false);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeThrowMock(null, 'ECONNABORTED') });
    check('DNSKEY timeout → dns_dnskey_present = null',           r.dns_dnskey_present === null);
    check('DNSKEY timeout → dnskey_collection_error TIMEOUT',     r.dnskey_collection_error === 'DNS_TIMEOUT');
    check('DNSKEY timeout → dnskey_record_count null',            r.dnskey_record_count === null);
    check('DNSKEY timeout → dnskey_ksk_count null',               r.dnskey_ksk_count === null);
    check('DNSKEY timeout → dnskey_zsk_count null',               r.dnskey_zsk_count === null);
    check('DNSKEY timeout → dnskey_other_flags_count null',       r.dnskey_other_flags_count === null);
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(doaResponse(), { Status: 2, Answer: [] }) });
    check('DNSKEY SERVFAIL → dns_dnskey_present = null',        r.dns_dnskey_present === null);
    check('DNSKEY SERVFAIL → dnskey_collection_error SERVFAIL', r.dnskey_collection_error === 'DNS_SERVFAIL');
  }

  {
    const r = await collectDnssec('example.com', { dnsResolver: makeThrowMock(null, 'ECONNREFUSED') });
    check('DNSKEY generic failure → dns_dnskey_present = null',       r.dns_dnskey_present === null);
    check('DNSKEY generic failure → dnskey_collection_error FAILURE', r.dnskey_collection_error === 'DNS_FAILURE');
  }

  // ── 3. Combined states (3×3 matrix) ──────────────────────────────────────

  section('3. COMBINED STATES (3×3 matrix)');

  const STATES = [
    { label: 'DS=true,  DNSKEY=true',  dsR: doaResponse([DS_A]), dkR: doaResponse([KSK]),  expectDs: true,  expectDk: true  },
    { label: 'DS=true,  DNSKEY=false', dsR: doaResponse([DS_A]), dkR: doaResponse([]),    expectDs: true,  expectDk: false },
    { label: 'DS=false, DNSKEY=true',  dsR: doaResponse([]),     dkR: doaResponse([KSK]), expectDs: false, expectDk: true  },
    { label: 'DS=false, DNSKEY=false', dsR: doaResponse([]),     dkR: doaResponse([]),    expectDs: false, expectDk: false },
    { label: 'DS=null,  DNSKEY=null',  dsR: { Status: 2, Answer: [] }, dkR: { Status: 2, Answer: [] }, expectDs: null, expectDk: null },
  ];

  for (const { label, dsR, dkR, expectDs, expectDk } of STATES) {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(dsR, dkR) });
    check(`${label} — dns_ds_present`,     r.dns_ds_present     === expectDs);
    check(`${label} — dns_dnskey_present`, r.dns_dnskey_present === expectDk);
  }

  {
    // DS=true, DNSKEY=null
    const r = await collectDnssec('example.com', {
      dnsResolver: { async queryDS() { return doaResponse([DS_A]); }, async queryDNSKEY() { throw makeError('ECONNABORTED'); } },
    });
    check('DS=true, DNSKEY=null — dns_ds_present = true',     r.dns_ds_present === true);
    check('DS=true, DNSKEY=null — dns_dnskey_present = null', r.dns_dnskey_present === null);
    check('DS=true, DNSKEY=null — DS result unaffected',      r.ds_record_count === 1);
  }

  {
    // DS=null, DNSKEY=true
    const r = await collectDnssec('example.com', {
      dnsResolver: { async queryDS() { throw makeError('ECONNABORTED'); }, async queryDNSKEY() { return doaResponse([KSK]); } },
    });
    check('DS=null, DNSKEY=true — dns_ds_present = null',     r.dns_ds_present === null);
    check('DS=null, DNSKEY=true — dns_dnskey_present = true', r.dns_dnskey_present === true);
    check('DS=null, DNSKEY=true — DNSKEY result unaffected',  r.dnskey_record_count === 1);
  }

  // ── 4. Multiple and duplicate records ─────────────────────────────────────

  section('4. MULTIPLE AND DUPLICATE RECORDS');

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse([DS_A, DS_B]), doaResponse()),
    });
    check('Multiple DS records — all preserved',            r.ds_record_count === 2);
    check('Multiple DS records — order preserved (first)',  r.ds_records[0]?.key_tag === 12345);
    check('Multiple DS records — order preserved (second)', r.ds_records[1]?.key_tag === 54321);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse([DS_A, DS_A]), doaResponse()),
    });
    check('Duplicate DS records — both preserved (no deduplication)', r.ds_record_count === 2);
    check('Duplicate DS records — key_tags has two entries',          r.ds_key_tags.length === 2);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse(), doaResponse([KSK, ZSK])),
    });
    check('Multiple DNSKEY records — all preserved',       r.dnskey_record_count === 2);
    check('Multiple DNSKEY records — KSK counted',         r.dnskey_ksk_count === 1);
    check('Multiple DNSKEY records — ZSK counted',         r.dnskey_zsk_count === 1);
    check('Multiple DNSKEY records — order preserved (KSK first)', r.dnskey_records[0]?.flags === 257);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse(), doaResponse([KSK, KSK])),
    });
    check('Duplicate DNSKEY records — both preserved (no deduplication)', r.dnskey_record_count === 2);
  }

  // ── 5. Algorithm and digest type variation ────────────────────────────────

  section('5. ALGORITHM AND DIGEST TYPE VARIATION');

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(
        doaResponse([dsAnswer(1, 13, 2, 'AA'), dsAnswer(2, 8, 1, 'BB'), dsAnswer(3, 13, 2, 'CC')]),
        doaResponse(),
      ),
    });
    check('DS algorithms — distinct sorted: [8,13]',          JSON.stringify(r.ds_algorithms) === JSON.stringify([8, 13]));
    check('DS digest_types — distinct sorted: [1,2]',         JSON.stringify(r.ds_digest_types) === JSON.stringify([1, 2]));
    check('DS key_tags — all preserved in order: [1,2,3]',    JSON.stringify(r.ds_key_tags) === JSON.stringify([1, 2, 3]));
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(
        doaResponse(),
        doaResponse([
          dnskeyAnswer(257, 3, 13, TEST_KEY),
          dnskeyAnswer(256, 3,  8, TEST_KEY),
          dnskeyAnswer(257, 3, 13, TEST_KEY),
        ]),
      ),
    });
    check('DNSKEY algorithms — distinct sorted: [8,13]', JSON.stringify(r.dnskey_algorithms) === JSON.stringify([8, 13]));
    check('DNSKEY KSK count = 2',                        r.dnskey_ksk_count === 2);
    check('DNSKEY ZSK count = 1',                        r.dnskey_zsk_count === 1);
  }

  // ── 6. Key tag derivation ─────────────────────────────────────────────────

  section('6. KEY TAG DERIVATION (RFC 4034 Appendix B)');

  {
    const tag = computeKeyTag(257, 3, 13, TEST_KEY);
    check(`computeKeyTag(257, 3, 13, "${TEST_KEY}") = ${TEST_KEYTAG}`, tag === TEST_KEYTAG);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse(), doaResponse([KSK])),
    });
    check(`KSK key tag matches known vector (${TEST_KEYTAG})`, r.dnskey_key_tags[0] === TEST_KEYTAG);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(doaResponse(), doaResponse([KSK, ZSK])),
    });
    check('Key tags array length matches dnskey_record_count',   r.dnskey_key_tags.length === r.dnskey_record_count);
    check('KSK and ZSK key tags differ (different flags byte)',  r.dnskey_key_tags[0] !== r.dnskey_key_tags[1]);
  }

  // ── 7. RRSIG filtering ────────────────────────────────────────────────────

  section('7. RRSIG AND NON-TARGET TYPE FILTERING');

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: makeMock(
        doaResponse([DS_A, { type: 46, data: 'rrsig data' }]),
        doaResponse([KSK,  { type: 46, data: 'rrsig data' }]),
      ),
    });
    check('RRSIG (type 46) excluded from DS count',     r.ds_record_count === 1);
    check('RRSIG (type 46) excluded from DNSKEY count', r.dnskey_record_count === 1);
  }

  // ── 8. www. stripping ─────────────────────────────────────────────────────

  section('8. WWW STRIPPING AND DOMAIN NORMALISATION');

  {
    let queried = '';
    const r = await collectDnssec('www.example.com', {
      dnsResolver: { async queryDS(n) { queried = n; return doaResponse(); }, async queryDNSKEY() { return doaResponse(); } },
    });
    check('www.example.com stripped to example.com', queried === 'example.com');
  }

  {
    let queried = '';
    await collectDnssec('  EXAMPLE.COM  ', {
      dnsResolver: { async queryDS(n) { queried = n; return doaResponse(); }, async queryDNSKEY() { return doaResponse(); } },
    });
    check('domain uppercased and padded → lowercased and trimmed', queried === 'example.com');
  }

  // ── 9. Schema consistency ─────────────────────────────────────────────────

  section('9. SCHEMA CONSISTENCY (all 9 states)');

  const schemaStates = [
    ['DS=true,  DNSKEY=true',  doaResponse([DS_A]),    doaResponse([KSK])],
    ['DS=true,  DNSKEY=false', doaResponse([DS_A]),    doaResponse([])   ],
    ['DS=false, DNSKEY=true',  doaResponse([]),         doaResponse([KSK])],
    ['DS=false, DNSKEY=false', doaResponse([]),         doaResponse([])   ],
    ['DS=null,  DNSKEY=false', { Status: 2, Answer: [] }, doaResponse([]) ],
    ['DS=false, DNSKEY=null',  doaResponse([]),           { Status: 2, Answer: [] }],
    ['DS=null,  DNSKEY=null',  { Status: 2, Answer: [] }, { Status: 2, Answer: [] }],
  ];

  for (const [label, dsR, dkR] of schemaStates) {
    const r = await collectDnssec('example.com', { dnsResolver: makeMock(dsR, dkR) });
    checkSchema(label, r);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: { async queryDS() { return doaResponse([DS_A]); }, async queryDNSKEY() { throw makeError('ECONNABORTED'); } },
    });
    checkSchema('DS=true, DNSKEY=null (throw)', r);
  }

  {
    const r = await collectDnssec('example.com', {
      dnsResolver: { async queryDS() { throw makeError('ECONNABORTED'); }, async queryDNSKEY() { return doaResponse([KSK]); } },
    });
    checkSchema('DS=null (throw), DNSKEY=true', r);
  }
}

// ── Phase 2: Live DNS validation ──────────────────────────────────────────────

async function phase2() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  PHASE 2 — LIVE DNS VALIDATION (real DoH queries)                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  section('1. KNOWN ABSENT DOMAINS');

  // example.com is an IANA reserved domain with no DNSSEC deployment.
  {
    const r = await collectDnssec('example.com');
    check('example.com — ds_collection_error is null',      r.ds_collection_error === null,     JSON.stringify(r.ds_collection_error));
    check('example.com — dns_ds_present is boolean',        typeof r.dns_ds_present === 'boolean', `got ${typeof r.dns_ds_present}`);
    check('example.com — dnskey_collection_error is null',  r.dnskey_collection_error === null, JSON.stringify(r.dnskey_collection_error));
    check('example.com — dns_dnskey_present is boolean',    typeof r.dns_dnskey_present === 'boolean');
    console.log(`      (example.com DS: ${r.dns_ds_present}, DNSKEY: ${r.dns_dnskey_present})`);
  }

  section('2. KNOWN DNSSEC DOMAIN');

  // cloudflare.com is operated by Cloudflare and is expected to have DNSSEC deployed.
  // If this test fails, verify the current DNSSEC status of cloudflare.com independently.
  {
    const r = await collectDnssec('cloudflare.com');
    check('cloudflare.com — DS collection did not error',   r.ds_collection_error === null,   `error: ${r.ds_collection_error}`);
    check('cloudflare.com — dns_ds_present = true',         r.dns_ds_present === true,        `got ${r.dns_ds_present}`);
    check('cloudflare.com — ds_record_count ≥ 1',          (r.ds_record_count ?? 0) >= 1,    `got ${r.ds_record_count}`);
    check('cloudflare.com — ds_algorithms non-empty',      r.ds_algorithms.length > 0,       `got ${JSON.stringify(r.ds_algorithms)}`);
    check('cloudflare.com — DNSKEY collection did not error', r.dnskey_collection_error === null, `error: ${r.dnskey_collection_error}`);
    check('cloudflare.com — dns_dnskey_present = true',     r.dns_dnskey_present === true,    `got ${r.dns_dnskey_present}`);
    check('cloudflare.com — dnskey_record_count ≥ 1',      (r.dnskey_record_count ?? 0) >= 1, `got ${r.dnskey_record_count}`);
    check('cloudflare.com — at least one KSK present',     (r.dnskey_ksk_count ?? 0) >= 1,   `got ${r.dnskey_ksk_count}`);
    check('cloudflare.com — dnskey_key_tags non-empty',    r.dnskey_key_tags.length > 0);
    check('cloudflare.com — schema consistent',            Object.keys(r).length === 16);
    if (r.dns_ds_present && r.ds_records.length > 0) {
      console.log(`      DS record 0: key_tag=${r.ds_records[0].key_tag}  alg=${r.ds_records[0].algorithm}  digest_type=${r.ds_records[0].digest_type}`);
    }
    if (r.dns_dnskey_present && r.dnskey_records.length > 0) {
      console.log(`      DNSKEY record 0: flags=${r.dnskey_records[0].flags}  alg=${r.dnskey_records[0].algorithm}  key_tag=${r.dnskey_key_tags[0]}`);
    }
  }

  section('3. WWW STRIPPING — LIVE');

  {
    const apex = await collectDnssec('cloudflare.com');
    const www  = await collectDnssec('www.cloudflare.com');
    check('www.cloudflare.com strips to cloudflare.com (same DS result)',
      apex.dns_ds_present === www.dns_ds_present,
      `apex=${apex.dns_ds_present} www=${www.dns_ds_present}`);
    check('www.cloudflare.com strips to cloudflare.com (same DNSKEY result)',
      apex.dns_dnskey_present === www.dns_dnskey_present);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR = '═'.repeat(72);
  console.log(`\n${HR}`);
  console.log(' SOT-DNSSEC-001 — VALIDATION RUNNER');
  console.log(`${HR}`);

  await phase1();
  await phase2();

  console.log(`\n${HR}`);
  console.log(' VALIDATION SUMMARY');
  console.log(`${HR}`);
  console.log(`\n  Passed : ${passed}`);
  console.log(`  Failed : ${failed}`);

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    ✘ ${f}`);
    console.log();
    process.exit(1);
  }

  console.log(`\n  All ${passed} checks passed. SOT-DNSSEC-001 collector is validated.\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
