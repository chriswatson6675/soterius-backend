'use strict';

// SOT-SECURITYHEADERS-001 — Phase 2 Validation Script
// Live-domain testing. Console only. No database writes.
// Usage: node backend/signal-lab/signals/securityheaders/validate-phase2.js

const { collectSecurityHeaders } = require('./securityheaders-collector');

const HR  = '═'.repeat(76);
const DIV = '─'.repeat(76);

// ── Validation domains ────────────────────────────────────────────────────────

const DOMAINS = [
  // --- RESPONSE_OBSERVED (HTTPS): standard targets ---
  { domain: 'gov.uk',           label: 'GOV.UK — UK government flagship (expect strong headers)' },
  { domain: 'cloudflare.com',   label: 'Cloudflare — comprehensive header deployment' },
  { domain: 'github.com',       label: 'GitHub — redirect + modern headers' },
  { domain: 'bbc.co.uk',        label: 'BBC — UK media, mixed header posture' },
  { domain: 'nginx.org',        label: 'nginx.org — Server disclosure expected' },

  // --- Technology disclosure headers ---
  { domain: 'stackoverflow.com', label: 'Stack Overflow — X-Powered-By / ASP.NET disclosure' },

  // --- TLS error states ---
  { domain: 'expired.badssl.com',       label: 'badssl: CERT_HAS_EXPIRED → TLS_ERROR' },
  { domain: 'self-signed.badssl.com',   label: 'badssl: DEPTH_ZERO_SELF_SIGNED_CERT → TLS_ERROR' },
  { domain: 'wrong.host.badssl.com',    label: 'badssl: ERR_TLS_CERT_ALTNAME_INVALID → TLS_ERROR' },
  { domain: 'untrusted-root.badssl.com',label: 'badssl: UNABLE_TO_GET_ISSUER_CERT_LOCALLY → TLS_ERROR' },

  // --- CONNECTION_ERROR ---
  { domain: 'soterius-validate-nonexistent-xyz-abc-1234567.com',
    label: 'Non-existent domain → CONNECTION_ERROR' },

  // --- HTTP probe observation: redirect to HTTPS ---
  { domain: 'example.com', label: 'example.com — HTTP 301→HTTPS redirect probe, minimal headers' },

  // --- Multi-header / reporting headers ---
  { domain: 'mozilla.org',  label: 'Mozilla — strong CSP, COOP, COEP, reporting headers' },
  { domain: 'google.com',   label: 'Google — HSTS, multi-hop redirect, technology fingerprint' },
];

// ── Header inventory fields to display ───────────────────────────────────────

const DISPLAY_FIELDS = [
  // Security policy headers
  ['strict_transport_security',                'HSTS'],
  ['content_security_policy',                  'CSP'],
  ['content_security_policy_report_only',      'CSP-RO'],
  ['x_frame_options',                          'XFO'],
  ['x_content_type_options',                   'XCTO'],
  ['referrer_policy',                          'RP'],
  ['permissions_policy',                       'PP'],
  ['feature_policy',                           'FP'],
  ['cross_origin_opener_policy',               'COOP'],
  ['cross_origin_opener_policy_report_only',   'COOP-RO'],
  ['cross_origin_embedder_policy',             'COEP'],
  ['cross_origin_embedder_policy_report_only', 'COEP-RO'],
  ['cross_origin_resource_policy',             'CORP'],
  // Reporting
  ['reporting_endpoints',                      'Reporting-Endpoints'],
  ['report_to',                                'Report-To'],
  ['nel',                                      'NEL'],
  ['origin_agent_cluster',                     'OAC'],
  // Deprecated
  ['x_xss_protection',                         'X-XSS-Protection'],
  ['expect_ct',                                'Expect-CT'],
  ['public_key_pins',                          'HPKP'],
  ['public_key_pins_report_only',              'HPKP-RO'],
  // Technology disclosure
  ['server',                                   'Server'],
  ['x_powered_by',                             'X-Powered-By'],
  ['x_aspnet_version',                         'X-AspNet-Version'],
  ['x_aspnetmvc_version',                      'X-AspNetMVC-Version'],
];

// ── Formatting helpers ────────────────────────────────────────────────────────

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function stateTag(outcome) {
  return {
    RESPONSE_OBSERVED: '  OK  ',
    TLS_ERROR:         ' TLS! ',
    CONNECTION_ERROR:  ' CONN!',
    TIMEOUT:           ' TIME!',
    REDIRECT_UNRESOLVED: ' RDR! ',
  }[outcome] ?? ` ${outcome.slice(0,4)} `;
}

function printRecord(r, label) {
  console.log(`\n${DIV}`);
  console.log(` ${r.domain}`);
  console.log(` ${label}`);
  console.log(DIV);

  // States
  console.log(`  endpoint_state   : [${stateTag(r.endpoint_state)}]  ${r.endpoint_state}`);
  console.log(`  http_probe_state : [${stateTag(r.http_probe_state)}]  ${r.http_probe_state}`);
  console.log(`  https url        : ${r.https_fetch.url}`);
  console.log(`  https status     : ${r.https_fetch.http_status ?? 'null'}`);
  console.log(`  http url         : ${r.http_probe.url}`);
  console.log(`  http status      : ${r.http_probe.http_status ?? 'null'}`);

  // Redirect chain
  if (r.https_fetch.redirect_chain.length > 0) {
    console.log(`  redirect_chain   : ${r.https_fetch.redirect_chain.length} hop(s)`);
    for (const hop of r.https_fetch.redirect_chain) {
      console.log(`    ${hop.http_status}  ${hop.url}  →  ${hop.location ?? 'null'}`);
    }
  }

  // Raw header pairs (evidence preservation)
  const pairs = r.https_fetch.header_pairs;
  if (pairs.length > 0) {
    console.log(`\n  Raw header_pairs (${pairs.length} total — wire order, original casing):`);
    for (const p of pairs) {
      console.log(`    [${String(p.position).padStart(2)}] ${p.name_raw}: ${trunc(p.value_raw, 80)}`);
    }
  } else {
    console.log(`\n  Raw header_pairs: [] (no headers — expected for error states)`);
  }

  // Security header inventory
  console.log(`\n  Security header inventory:`);
  const present = [];
  const absent  = [];
  for (const [field, shortLabel] of DISPLAY_FIELDS) {
    const obs = r.header_inventory[field];
    if (obs.present) {
      present.push({ shortLabel, obs });
    } else {
      absent.push(shortLabel);
    }
  }

  if (present.length === 0) {
    console.log(`    (all 25 headers absent)`);
  } else {
    for (const { shortLabel, obs } of present) {
      const countTag = obs.count > 1 ? ` [×${obs.count}]` : '';
      const val      = obs.values.map(v => trunc(v, 60)).join(' | ');
      console.log(`    ✓  ${shortLabel.padEnd(24)}${countTag}  pos=${obs.first_position}  ${val}`);
    }
    if (absent.length > 0) {
      console.log(`    ✗  Absent: ${absent.join(', ')}`);
    }
  }
}

// ── Evidence preservation checks ──────────────────────────────────────────────

function checkEvidencePreservation(results) {
  console.log(`\n${HR}`);
  console.log(` EVIDENCE PRESERVATION REVIEW`);
  console.log(HR);

  let casesChecked = 0;

  for (const { r } of results) {
    if (r.endpoint_state !== 'RESPONSE_OBSERVED') continue;
    const pairs = r.https_fetch.header_pairs;
    if (pairs.length === 0) continue;

    casesChecked++;

    // Check 1: casing preserved (at least one header should have a capital letter)
    const hasMixedCase = pairs.some(p => p.name_raw !== p.name_raw.toLowerCase());
    // Check 2: positions are sequential from 1
    const positionsOk = pairs.every((p, i) => p.position === i + 1);
    // Check 3: no two different headers merged (count raw pairs vs inventory present count)
    const inventoryPresentCount = Object.values(r.header_inventory).filter(o => o.present).length;
    // Check 4: duplicate values preserved separately in values array
    const duplicates = Object.entries(r.header_inventory)
      .filter(([, o]) => o.count > 1)
      .map(([k, o]) => ({ k, count: o.count, values: o.values }));

    console.log(`\n  ${r.domain}`);
    console.log(`    header_pairs count     : ${pairs.length}`);
    console.log(`    positions sequential   : ${positionsOk ? 'YES' : 'FAIL'}`);
    console.log(`    mixed-case names seen  : ${hasMixedCase ? 'YES (casing preserved)' : 'all-lowercase (lowercase server)'}`);
    console.log(`    inventory present count: ${inventoryPresentCount} of 25`);

    if (duplicates.length > 0) {
      for (const { k, count, values } of duplicates) {
        console.log(`    DUPLICATE: ${k} ×${count} → [${values.map(v => trunc(v,40)).join('] [')}]`);
      }
    }

    // First 3 pairs to verify wire order
    console.log(`    First 3 wire positions :`);
    for (const p of pairs.slice(0, 3)) {
      console.log(`      [${p.position}] "${p.name_raw}"`);
    }
  }

  if (casesChecked === 0) {
    console.log(`  No RESPONSE_OBSERVED results with headers to check.`);
  }
}

// ── Schema consistency check ──────────────────────────────────────────────────

function checkSchemaConsistency(results) {
  console.log(`\n${HR}`);
  console.log(` SCHEMA CONSISTENCY REVIEW`);
  console.log(HR);

  const REQUIRED_TOP = ['domain','collected_at','signal_version','collector_version',
                        'endpoint_state','http_probe_state','https_fetch','http_probe','header_inventory'];
  const REQUIRED_FETCH = ['url','fetch_outcome','http_status','redirect_chain','header_pairs'];
  const REQUIRED_OBS   = ['present','count','values','first_position'];

  let allOk = true;

  for (const { r } of results) {
    const issues = [];

    // Top-level keys
    for (const k of REQUIRED_TOP) {
      if (!(k in r)) issues.push(`missing top-level: ${k}`);
    }

    // https_fetch keys
    for (const k of REQUIRED_FETCH) {
      if (!(k in r.https_fetch)) issues.push(`missing https_fetch.${k}`);
    }

    // http_probe keys
    for (const k of REQUIRED_FETCH) {
      if (!(k in r.http_probe)) issues.push(`missing http_probe.${k}`);
    }

    // http_probe invariants
    if (r.http_probe.redirect_chain.length !== 0) {
      issues.push(`http_probe.redirect_chain not empty (length=${r.http_probe.redirect_chain.length})`);
    }

    // header_inventory: all 25 fields, each with correct shape
    if (Object.keys(r.header_inventory).length !== 25) {
      issues.push(`header_inventory has ${Object.keys(r.header_inventory).length} keys (expected 25)`);
    }
    for (const [k, obs] of Object.entries(r.header_inventory)) {
      for (const f of REQUIRED_OBS) {
        if (!(f in obs)) issues.push(`header_inventory.${k} missing field: ${f}`);
      }
      // absent invariants
      if (!obs.present) {
        if (obs.count !== 0)          issues.push(`${k}: absent but count=${obs.count}`);
        if (obs.values.length !== 0)  issues.push(`${k}: absent but values not empty`);
        if (obs.first_position !== null) issues.push(`${k}: absent but first_position=${obs.first_position}`);
      }
      // present invariants
      if (obs.present) {
        if (obs.count === 0)           issues.push(`${k}: present but count=0`);
        if (obs.values.length === 0)   issues.push(`${k}: present but values empty`);
        if (obs.first_position === null) issues.push(`${k}: present but first_position=null`);
        if (obs.values.length !== obs.count) issues.push(`${k}: values.length != count`);
      }
    }

    // endpoint_state / http_probe_state must match fetch_outcome
    if (r.endpoint_state !== r.https_fetch.fetch_outcome) {
      issues.push(`endpoint_state mismatch: ${r.endpoint_state} vs ${r.https_fetch.fetch_outcome}`);
    }
    if (r.http_probe_state !== r.http_probe.fetch_outcome) {
      issues.push(`http_probe_state mismatch: ${r.http_probe_state} vs ${r.http_probe.fetch_outcome}`);
    }

    // signal_version
    if (r.signal_version !== 'SOT-SECURITYHEADERS-001-v1') {
      issues.push(`signal_version unexpected: ${r.signal_version}`);
    }

    const status = issues.length === 0 ? 'PASS' : `FAIL (${issues.length} issue(s))`;
    console.log(`  ${r.domain.padEnd(48)}  ${status}`);
    if (issues.length > 0) {
      allOk = false;
      for (const iss of issues) console.log(`    ⚠  ${iss}`);
    }
  }

  console.log(`\n  Schema consistency: ${allOk ? 'ALL PASS' : 'FAILURES DETECTED'}`);
  return allOk;
}

// ── State coverage summary ────────────────────────────────────────────────────

function printStateCoverage(results) {
  console.log(`\n${HR}`);
  console.log(` STATE COVERAGE REVIEW`);
  console.log(HR);

  const endpointStates   = {};
  const httpProbeStates  = {};
  for (const { r } of results) {
    endpointStates[r.endpoint_state]  = (endpointStates[r.endpoint_state]  ?? 0) + 1;
    httpProbeStates[r.http_probe_state] = (httpProbeStates[r.http_probe_state] ?? 0) + 1;
  }

  const ALL_OUTCOMES = ['RESPONSE_OBSERVED','TLS_ERROR','CONNECTION_ERROR','TIMEOUT','REDIRECT_UNRESOLVED'];

  console.log(`\n  endpoint_state (HTTPS fetch):`);
  for (const s of ALL_OUTCOMES) {
    const n   = endpointStates[s] ?? 0;
    const tag = n > 0 ? '✓' : '✗';
    console.log(`    ${tag}  ${s.padEnd(22)} : ${n}`);
  }

  console.log(`\n  http_probe_state (HTTP probe):`);
  for (const s of ALL_OUTCOMES) {
    const n   = httpProbeStates[s] ?? 0;
    const tag = n > 0 ? '✓' : '✗';
    console.log(`    ${tag}  ${s.padEnd(22)} : ${n}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date();
  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYHEADERS-001 — Phase 2 Validation`);
  console.log(` Live-domain testing. Console only. No database writes.`);
  console.log(` Started: ${startedAt.toISOString()}`);
  console.log(HR);

  const results = [];

  for (const { domain, label } of DOMAINS) {
    process.stdout.write(`  Collecting: ${domain} … `);
    const t0 = Date.now();
    try {
      const r = await collectSecurityHeaders(domain, '1.0.0-validate');
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`${r.endpoint_state} / ${r.http_probe_state}  (${elapsed}s)\n`);
      results.push({ domain, label, r });
    } catch (err) {
      process.stdout.write(`FATAL ERROR: ${err.message}\n`);
    }
  }

  // ── Detailed records ───────────────────────────────────────────────────────
  console.log(`\n${HR}`);
  console.log(` DETAILED RECORDS`);
  console.log(HR);
  for (const { r, label } of results) {
    printRecord(r, label);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────
  checkEvidencePreservation(results);
  const schemaOk = checkSchemaConsistency(results);
  printStateCoverage(results);

  // ── Final summary ─────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${HR}`);
  console.log(` VALIDATION COMPLETE`);
  console.log(`  Domains tested : ${results.length}`);
  console.log(`  Schema checks  : ${schemaOk ? 'ALL PASS' : 'FAILURES DETECTED'}`);
  console.log(`  Elapsed        : ${elapsed}s`);
  console.log(HR);
  console.log();
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
