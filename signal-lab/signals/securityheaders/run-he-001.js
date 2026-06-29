'use strict';

// SOT-SECURITYHEADERS-001 — HE-001 University Cohort Collection Run
//
// Reads the 166-institution HE-001 cohort from the data.ac.uk CSV,
// runs the security headers collector against every domain in parallel,
// writes all evidence to signal_securityheaders_v1, and prints a cohort summary.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/securityheaders/run-he-001.js
//
// Prerequisites:
//   Migration 014_signal_lab_securityheaders.sql applied in Supabase Dashboard.
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   CONCURRENCY               — optional, default 10
//   RUN_ID                    — optional UUID; set to resume a failed run

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const fs             = require('node:fs');
const path           = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { collectSecurityHeaders } = require('./securityheaders-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE       = 'HE-001';
const COLLECTOR_VERSION = '1.0.0';
const CSV_PATH          = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY       = Number(process.env.CONCURRENCY ?? 10);
const RUN_ID            = process.env.RUN_ID ?? randomUUID();

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
  return createClient(url, key);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function loadCohort() {
  const raw     = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitCsvLine(lines[0]);

  const ukprnIdx    = headers.indexOf('UKPRN');
  const viewNameIdx = headers.indexOf('VIEW_NAME');
  const provNameIdx = headers.indexOf('PROVIDER_NAME');
  const urlIdx      = headers.indexOf('WEBSITE_URL');

  const institutions = [];
  const skipped      = [];

  for (const line of lines.slice(1)) {
    const f      = splitCsvLine(line);
    const rawUrl = f[urlIdx]?.trim();
    const name   = f[viewNameIdx]?.trim() || f[provNameIdx]?.trim() || '(unknown)';
    const ukprn  = f[ukprnIdx]?.trim() ?? '';

    if (!rawUrl) {
      skipped.push({ ukprn, name, reason: 'missing WEBSITE_URL' });
      continue;
    }

    let domain;
    try {
      domain = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      skipped.push({ ukprn, name, reason: `unparseable URL: ${rawUrl}` });
      continue;
    }

    if (!domain) {
      skipped.push({ ukprn, name, reason: `no hostname in: ${rawUrl}` });
      continue;
    }

    institutions.push({ ukprn, name, domain });
  }

  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let   next    = 0;

  async function worker() {
    while (next < items.length) {
      const i    = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Supabase repository ───────────────────────────────────────────────────────

async function insertRecord(supabase, record) {
  const { error } = await supabase.from('signal_securityheaders_v1').insert({
    run_id:            RUN_ID,
    domain:            record.domain,
    collected_at:      record.collected_at,
    signal_version:    record.signal_version,
    collector_version: record.collector_version,
    endpoint_state:    record.endpoint_state,
    http_probe_state:  record.http_probe_state,
    https_fetch:       record.https_fetch,
    http_probe:        record.http_probe,
    header_inventory:  record.header_inventory,
  });
  return error ?? null;
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(record, domain, i, total) {
  const pct   = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const es    = record.endpoint_state;
  const ps    = record.http_probe_state;

  const esTag = {
    RESPONSE_OBSERVED:   'RESP  ',
    TLS_ERROR:           'TLS!  ',
    CONNECTION_ERROR:    'CONN! ',
    TIMEOUT:             'TIME! ',
    REDIRECT_UNRESOLVED: 'RDR!  ',
  }[es] ?? es.slice(0, 6).padEnd(6);

  const inv     = record.header_inventory;
  const present = Object.values(inv).filter(o => o.present).length;

  // Highlight key policy headers
  const hsts = inv.strict_transport_security?.present ? 'HSTS' : '----';
  const csp  = inv.content_security_policy?.present   ? 'CSP'  : '---';
  const xfo  = inv.x_frame_options?.present           ? 'XFO'  : '---';
  const xcto = inv.x_content_type_options?.present    ? 'XCTO' : '----';
  const svr  = inv.server?.present                    ? `Svr:${inv.server.values[0].slice(0,10)}` : '';

  const probeTag = ps === 'RESPONSE_OBSERVED'
    ? `http:${record.http_probe.http_status ?? '?'}`
    : ps.slice(0, 5);

  return `  [${pct}%]  ${domain.padEnd(36)} [${esTag}] ${String(present).padStart(2)}/25  ${hsts} ${csp} ${xfo} ${xcto}  ${probeTag}  ${svr}`;
}

// ── Analysis helpers ──────────────────────────────────────────────────────────

const HEADER_FIELDS = [
  // Security policy
  'strict_transport_security',
  'content_security_policy',
  'content_security_policy_report_only',
  'x_frame_options',
  'x_content_type_options',
  'referrer_policy',
  'permissions_policy',
  'feature_policy',
  'cross_origin_opener_policy',
  'cross_origin_opener_policy_report_only',
  'cross_origin_embedder_policy',
  'cross_origin_embedder_policy_report_only',
  'cross_origin_resource_policy',
  // Reporting
  'reporting_endpoints',
  'report_to',
  'nel',
  'origin_agent_cluster',
  // Deprecated
  'x_xss_protection',
  'expect_ct',
  'public_key_pins',
  'public_key_pins_report_only',
  // Technology disclosure
  'server',
  'x_powered_by',
  'x_aspnet_version',
  'x_aspnetmvc_version',
];

const HEADER_LABELS = {
  strict_transport_security:               'Strict-Transport-Security (HSTS)',
  content_security_policy:                 'Content-Security-Policy (CSP)',
  content_security_policy_report_only:     'Content-Security-Policy-Report-Only',
  x_frame_options:                         'X-Frame-Options',
  x_content_type_options:                  'X-Content-Type-Options',
  referrer_policy:                         'Referrer-Policy',
  permissions_policy:                      'Permissions-Policy',
  feature_policy:                          'Feature-Policy',
  cross_origin_opener_policy:              'Cross-Origin-Opener-Policy',
  cross_origin_opener_policy_report_only:  'Cross-Origin-Opener-Policy-Report-Only',
  cross_origin_embedder_policy:            'Cross-Origin-Embedder-Policy',
  cross_origin_embedder_policy_report_only:'Cross-Origin-Embedder-Policy-Report-Only',
  cross_origin_resource_policy:            'Cross-Origin-Resource-Policy',
  reporting_endpoints:                     'Reporting-Endpoints',
  report_to:                               'Report-To',
  nel:                                     'NEL',
  origin_agent_cluster:                    'Origin-Agent-Cluster',
  x_xss_protection:                        'X-XSS-Protection (deprecated)',
  expect_ct:                               'Expect-CT (deprecated)',
  public_key_pins:                         'Public-Key-Pins (deprecated)',
  public_key_pins_report_only:             'Public-Key-Pins-Report-Only (deprecated)',
  server:                                  'Server',
  x_powered_by:                            'X-Powered-By',
  x_aspnet_version:                        'X-AspNet-Version',
  x_aspnetmvc_version:                     'X-AspNetMVC-Version',
};

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(rows) {
  const total = rows.length;

  // Separate RESPONSE_OBSERVED rows (have usable header_inventory)
  const observed = rows.filter(r => r.record?.endpoint_state === 'RESPONSE_OBSERVED');
  const no       = observed.length;

  // endpoint_state distribution
  const byEndpointState   = {};
  const byHttpProbeState  = {};
  for (const { record } of rows) {
    if (!record) continue;
    byEndpointState[record.endpoint_state]   = (byEndpointState[record.endpoint_state]   ?? 0) + 1;
    byHttpProbeState[record.http_probe_state] = (byHttpProbeState[record.http_probe_state] ?? 0) + 1;
  }
  const collectorErrors = rows.filter(r => r.collectorError).length;
  const dbWriteErrors   = rows.filter(r => r.dbError).length;

  // Per-header presence counts (across RESPONSE_OBSERVED only)
  const headerPresence = {};
  for (const field of HEADER_FIELDS) {
    headerPresence[field] = observed.filter(r => r.record.header_inventory[field]?.present).length;
  }

  // Per-domain header count distribution
  const headerCountBuckets = { '0': 0, '1-3': 0, '4-6': 0, '7-9': 0, '10-12': 0, '13+': 0 };
  const headerCountValues  = [];
  for (const { record } of observed) {
    const n = Object.values(record.header_inventory).filter(o => o.present).length;
    headerCountValues.push(n);
    if (n === 0)       headerCountBuckets['0']++;
    else if (n <= 3)   headerCountBuckets['1-3']++;
    else if (n <= 6)   headerCountBuckets['4-6']++;
    else if (n <= 9)   headerCountBuckets['7-9']++;
    else if (n <= 12)  headerCountBuckets['10-12']++;
    else               headerCountBuckets['13+']++;
  }

  // Wire header count distribution (total header_pairs)
  const wireBuckets = { '0-5': 0, '6-10': 0, '11-15': 0, '16-20': 0, '21-30': 0, '31+': 0 };
  for (const { record } of observed) {
    const n = record.https_fetch.header_pairs?.length ?? 0;
    if (n <= 5)       wireBuckets['0-5']++;
    else if (n <= 10) wireBuckets['6-10']++;
    else if (n <= 15) wireBuckets['11-15']++;
    else if (n <= 20) wireBuckets['16-20']++;
    else if (n <= 30) wireBuckets['21-30']++;
    else              wireBuckets['31+']++;
  }

  // Duplicate header prevalence
  let domainsWithDuplicates = 0;
  const duplicateFields     = {};
  for (const { record } of observed) {
    let hadDuplicate = false;
    for (const [field, obs] of Object.entries(record.header_inventory)) {
      if (obs.count > 1) {
        hadDuplicate = true;
        duplicateFields[field] = (duplicateFields[field] ?? 0) + 1;
      }
    }
    if (hadDuplicate) domainsWithDuplicates++;
  }

  // HTTP probe: how many domains redirect HTTP→HTTPS vs serve HTTP
  let probeRedirects    = 0;
  let probeHttpDirectly = 0;
  let probeErrors       = 0;
  for (const { record } of rows) {
    if (!record) continue;
    if (record.http_probe_state === 'RESPONSE_OBSERVED') {
      const status = record.http_probe.http_status;
      if (status >= 300 && status < 400) probeRedirects++;
      else probeHttpDirectly++;
    } else {
      probeErrors++;
    }
  }

  // ── Header-specific analysis ───────────────────────────────────────────────

  // HSTS value distribution
  const hstsValues  = {};
  const hstsMaxAge  = { 'missing': 0, '< 1 year': 0, '1 year': 0, '2 years': 0, '> 2 years': 0 };
  const hstsInclude = { yes: 0, no: 0 };
  const hstsPreload = { yes: 0, no: 0 };
  for (const { record } of observed) {
    const obs = record.header_inventory.strict_transport_security;
    if (!obs.present) { hstsMaxAge['missing']++; continue; }
    const val = obs.values[0] ?? '';
    // max-age
    const ma = val.match(/max-age\s*=\s*(\d+)/i);
    if (ma) {
      const secs = Number(ma[1]);
      if (secs < 31536000)       hstsMaxAge['< 1 year']++;
      else if (secs === 31536000) hstsMaxAge['1 year']++;
      else if (secs <= 63072000)  hstsMaxAge['2 years']++;
      else                        hstsMaxAge['> 2 years']++;
    }
    // includeSubDomains
    if (/includeSubDomains/i.test(val)) hstsInclude.yes++;
    else hstsInclude.no++;
    // preload
    if (/preload/i.test(val)) hstsPreload.yes++;
    else hstsPreload.no++;
    // top 10 distinct values
    const k = trunc(val, 80);
    hstsValues[k] = (hstsValues[k] ?? 0) + 1;
  }

  // XFO value distribution
  const xfoValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.x_frame_options;
    if (!obs.present) continue;
    const k = obs.values[0]?.toUpperCase() ?? '';
    xfoValues[k] = (xfoValues[k] ?? 0) + 1;
  }

  // XCTO value distribution
  const xctoValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.x_content_type_options;
    if (!obs.present) continue;
    const k = obs.values[0]?.toLowerCase() ?? '';
    xctoValues[k] = (xctoValues[k] ?? 0) + 1;
  }

  // Referrer-Policy distinct values
  const rpValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.referrer_policy;
    if (!obs.present) continue;
    const k = obs.values[0] ?? '';
    rpValues[k] = (rpValues[k] ?? 0) + 1;
  }

  // Permissions-Policy: presence + top values
  const ppValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.permissions_policy;
    if (!obs.present) continue;
    const k = trunc(obs.values[0] ?? '', 60);
    ppValues[k] = (ppValues[k] ?? 0) + 1;
  }

  // CSP presence breakdown: CSP only / CSP-RO only / both / neither
  let cspOnly = 0, cspROOnly = 0, cspBoth = 0, cspNeither = 0;
  for (const { record } of observed) {
    const hasCsp   = record.header_inventory.content_security_policy.present;
    const hasRO    = record.header_inventory.content_security_policy_report_only.present;
    if (hasCsp && hasRO)       cspBoth++;
    else if (hasCsp)           cspOnly++;
    else if (hasRO)            cspROOnly++;
    else                       cspNeither++;
  }

  // Server values
  const serverValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.server;
    if (!obs.present) continue;
    const raw = obs.values[0] ?? '';
    // normalise to software name for distribution (strip version)
    const norm = raw.replace(/\/[\d.]+.*/, '').trim();
    serverValues[norm] = (serverValues[norm] ?? 0) + 1;
  }

  // X-Powered-By values
  const xpbValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.x_powered_by;
    if (!obs.present) continue;
    const k = trunc(obs.values[0] ?? '', 60);
    xpbValues[k] = (xpbValues[k] ?? 0) + 1;
  }

  // Technology disclosure: count domains exposing any disclosure header
  const disclosureFields = ['server', 'x_powered_by', 'x_aspnet_version', 'x_aspnetmvc_version'];
  let domainsWithDisclosure = 0;
  for (const { record } of observed) {
    if (disclosureFields.some(f => record.header_inventory[f]?.present)) {
      domainsWithDisclosure++;
    }
  }

  // X-XSS-Protection distribution
  const xssValues = {};
  for (const { record } of observed) {
    const obs = record.header_inventory.x_xss_protection;
    if (!obs.present) continue;
    const k = obs.values[0] ?? '';
    xssValues[k] = (xssValues[k] ?? 0) + 1;
  }

  return {
    total, no, collectorErrors, dbWriteErrors,
    byEndpointState, byHttpProbeState,
    headerPresence, headerCountBuckets, headerCountValues,
    wireBuckets,
    domainsWithDuplicates, duplicateFields,
    probeRedirects, probeHttpDirectly, probeErrors,
    hstsValues, hstsMaxAge, hstsInclude, hstsPreload,
    xfoValues, xctoValues, rpValues, ppValues,
    cspOnly, cspROOnly, cspBoth, cspNeither,
    serverValues, xpbValues, domainsWithDisclosure, xssValues,
  };
}

// ── Summary output ────────────────────────────────────────────────────────────

function printSummary(s, startedAt, skipped) {
  const HR  = '═'.repeat(76);
  const DIV = '─'.repeat(76);
  const { total, no } = s;

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYHEADERS-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: SOT-SECURITYHEADERS-001 v1   Cohort: ${COHORT_CODE}   n = ${total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(` Run ID: ${RUN_ID}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain`);
  }
  console.log(HR);

  // ── Obj 2 & collection health ───────────────────────────────────────────────
  console.log(`\n 1. COLLECTION STATE DISTRIBUTION\n`);
  const stateOrder = ['RESPONSE_OBSERVED','TLS_ERROR','CONNECTION_ERROR','TIMEOUT','REDIRECT_UNRESOLVED'];
  console.log(`    endpoint_state (HTTPS):`);
  for (const state of stateOrder) {
    const n = s.byEndpointState[state] ?? 0;
    if (n > 0) console.log(`      ${state.padEnd(22)}: ${String(n).padStart(4)}   ${pct(n, total)}`);
  }
  console.log();
  console.log(`    http_probe_state (HTTP):`);
  for (const state of stateOrder) {
    const n = s.byHttpProbeState[state] ?? 0;
    if (n > 0) console.log(`      ${state.padEnd(22)}: ${String(n).padStart(4)}   ${pct(n, total)}`);
  }
  console.log(`\n    RESPONSE_OBSERVED (HTTPS) — analysis base: ${no} domains`);
  console.log(`    Collector exceptions   : ${s.collectorErrors}`);
  console.log(`    DB write failures      : ${s.dbWriteErrors}`);
  if (s.dbWriteErrors > 0) {
    console.log(`\n    WARNING: Re-run with RUN_ID=${RUN_ID} to retry failed domains.`);
  }

  // ── HTTP probe observation ───────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 2. HTTP PROBE OBSERVATIONS  (all ${total} domains)\n`);
  console.log(`    HTTP→HTTPS redirect (3xx) : ${String(s.probeRedirects).padStart(4)}   ${pct(s.probeRedirects, total)}`);
  console.log(`    HTTP response (non-3xx)   : ${String(s.probeHttpDirectly).padStart(4)}   ${pct(s.probeHttpDirectly, total)}`);
  console.log(`    HTTP unreachable / error  : ${String(s.probeErrors).padStart(4)}   ${pct(s.probeErrors, total)}`);

  // ── Obj 1: Presence distribution by header ───────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 3. HEADER PRESENCE DISTRIBUTION  (${no} RESPONSE_OBSERVED domains)\n`);
  const sorted = [...HEADER_FIELDS].sort((a, b) => (s.headerPresence[b] ?? 0) - (s.headerPresence[a] ?? 0));
  for (const field of sorted) {
    const n = s.headerPresence[field] ?? 0;
    if (n === 0) continue;
    const label = HEADER_LABELS[field] ?? field;
    console.log(`    ${label.padEnd(40)} : ${String(n).padStart(4)}   ${pct(n, no)}`);
  }
  // Zero-count headers
  const absent = sorted.filter(f => (s.headerPresence[f] ?? 0) === 0);
  if (absent.length > 0) {
    console.log(`\n    Not observed in cohort (0%):`);
    for (const field of absent) {
      console.log(`      ${HEADER_LABELS[field] ?? field}`);
    }
  }

  // ── Obj 2: Header adoption distribution ─────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 4. HEADER ADOPTION DISTRIBUTION  (security headers per domain, ${no} observed)\n`);
  const bucketOrder = ['0', '1-3', '4-6', '7-9', '10-12', '13+'];
  for (const bucket of bucketOrder) {
    const n = s.headerCountBuckets[bucket] ?? 0;
    const bar = '█'.repeat(Math.round(n / no * 30));
    console.log(`    ${bucket.padEnd(6)}: ${String(n).padStart(4)}  ${pct(n, no)}  ${bar}`);
  }
  const vals = s.headerCountValues;
  if (vals.length > 0) {
    const sorted2 = [...vals].sort((a, b) => a - b);
    const mean    = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
    const median  = sorted2[Math.floor(sorted2.length / 2)];
    const max     = sorted2[sorted2.length - 1];
    const min     = sorted2[0];
    console.log(`\n    min=${min}  median=${median}  mean=${mean}  max=${max}`);
  }

  // ── Obj 6: Wire header count distribution ────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 5. TOTAL WIRE HEADERS PER DOMAIN  (header_pairs count, ${no} observed)\n`);
  const wireBucketOrder = ['0-5', '6-10', '11-15', '16-20', '21-30', '31+'];
  for (const bucket of wireBucketOrder) {
    const n   = s.wireBuckets[bucket] ?? 0;
    const bar = '█'.repeat(Math.round(n / no * 30));
    console.log(`    ${bucket.padEnd(6)}: ${String(n).padStart(4)}  ${pct(n, no)}  ${bar}`);
  }

  // ── Obj 5: Duplicate header prevalence ──────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 6. DUPLICATE HEADER PREVALENCE  (${no} observed)\n`);
  console.log(`    Domains with ≥1 duplicate header : ${String(s.domainsWithDuplicates).padStart(4)}   ${pct(s.domainsWithDuplicates, no)}`);
  if (Object.keys(s.duplicateFields).length > 0) {
    console.log(`\n    Headers observed with multiple instances:`);
    const dupSorted = Object.entries(s.duplicateFields).sort((a, b) => b[1] - a[1]);
    for (const [field, n] of dupSorted) {
      console.log(`      ${HEADER_LABELS[field].padEnd(40)} : ${n} domain(s)`);
    }
  }

  // ── Obj 8: HSTS distribution ─────────────────────────────────────────────────
  const hstsN = s.headerPresence.strict_transport_security ?? 0;
  console.log(`\n${DIV}`);
  console.log(`\n 7. HSTS DISTRIBUTION  (${hstsN} domains with HSTS, of ${no} observed)\n`);
  console.log(`    max-age range:`);
  for (const [k, n] of Object.entries(s.hstsMaxAge)) {
    if (n > 0) console.log(`      ${k.padEnd(12)}: ${String(n).padStart(4)}   ${pct(n, no)}`);
  }
  if (hstsN > 0) {
    console.log(`\n    includeSubDomains directive:`);
    console.log(`      present   : ${String(s.hstsInclude.yes).padStart(4)}   ${pct(s.hstsInclude.yes, hstsN)}`);
    console.log(`      absent    : ${String(s.hstsInclude.no).padStart(4)}   ${pct(s.hstsInclude.no, hstsN)}`);
    console.log(`\n    preload directive:`);
    console.log(`      present   : ${String(s.hstsPreload.yes).padStart(4)}   ${pct(s.hstsPreload.yes, hstsN)}`);
    console.log(`      absent    : ${String(s.hstsPreload.no).padStart(4)}   ${pct(s.hstsPreload.no, hstsN)}`);
    const topHsts = Object.entries(s.hstsValues).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topHsts.length > 0) {
      console.log(`\n    Top distinct values:`);
      for (const [v, n] of topHsts) {
        console.log(`      ${String(n).padStart(4)}  ${v}`);
      }
    }
  }

  // ── Obj 7: CSP distribution ──────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 8. CSP DISTRIBUTION  (${no} observed)\n`);
  console.log(`    CSP (enforced) only           : ${String(s.cspOnly).padStart(4)}   ${pct(s.cspOnly, no)}`);
  console.log(`    CSP-Report-Only only          : ${String(s.cspROOnly).padStart(4)}   ${pct(s.cspROOnly, no)}`);
  console.log(`    Both CSP and CSP-Report-Only  : ${String(s.cspBoth).padStart(4)}   ${pct(s.cspBoth, no)}`);
  console.log(`    Neither (no CSP at all)       : ${String(s.cspNeither).padStart(4)}   ${pct(s.cspNeither, no)}`);

  // X-Frame-Options
  console.log(`\n${DIV}`);
  console.log(`\n 9. X-FRAME-OPTIONS DISTRIBUTION  (${s.headerPresence.x_frame_options ?? 0} domains)\n`);
  const xfoSorted = Object.entries(s.xfoValues).sort((a, b) => b[1] - a[1]);
  for (const [v, n] of xfoSorted) {
    console.log(`    ${v.padEnd(20)}: ${String(n).padStart(4)}   ${pct(n, s.headerPresence.x_frame_options ?? 1)}`);
  }

  // X-Content-Type-Options
  const xctoN = s.headerPresence.x_content_type_options ?? 0;
  if (xctoN > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n10. X-CONTENT-TYPE-OPTIONS DISTRIBUTION  (${xctoN} domains)\n`);
    for (const [v, n] of Object.entries(s.xctoValues).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${v.padEnd(20)}: ${String(n).padStart(4)}`);
    }
  }

  // ── Obj 9: Referrer-Policy distribution ─────────────────────────────────────
  const rpN = s.headerPresence.referrer_policy ?? 0;
  console.log(`\n${DIV}`);
  console.log(`\n11. REFERRER-POLICY DISTRIBUTION  (${rpN} domains)\n`);
  const rpSorted = Object.entries(s.rpValues).sort((a, b) => b[1] - a[1]);
  for (const [v, n] of rpSorted) {
    console.log(`    ${n.toString().padStart(4)}  ${v}`);
  }

  // ── Obj 10: Permissions-Policy distribution ──────────────────────────────────
  const ppN = s.headerPresence.permissions_policy ?? 0;
  console.log(`\n${DIV}`);
  console.log(`\n12. PERMISSIONS-POLICY DISTRIBUTION  (${ppN} domains)\n`);
  if (ppN === 0) {
    console.log(`    No domains in cohort have Permissions-Policy.`);
  } else {
    const ppSorted = Object.entries(s.ppValues).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [v, n] of ppSorted) {
      console.log(`    ${n.toString().padStart(4)}  ${v}`);
    }
  }

  // X-XSS-Protection
  const xssN = s.headerPresence.x_xss_protection ?? 0;
  if (xssN > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n13. X-XSS-PROTECTION DISTRIBUTION  (${xssN} domains, deprecated)\n`);
    for (const [v, n] of Object.entries(s.xssValues).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(4)}  ${v}`);
    }
  }

  // ── Obj 11: Technology disclosure ────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n14. TECHNOLOGY DISCLOSURE HEADERS  (${no} observed)\n`);
  console.log(`    Domains with ≥1 disclosure header : ${String(s.domainsWithDisclosure).padStart(4)}   ${pct(s.domainsWithDisclosure, no)}`);
  console.log(`    Domains with Server header        : ${String(s.headerPresence.server ?? 0).padStart(4)}   ${pct(s.headerPresence.server ?? 0, no)}`);
  console.log(`    Domains with X-Powered-By         : ${String(s.headerPresence.x_powered_by ?? 0).padStart(4)}   ${pct(s.headerPresence.x_powered_by ?? 0, no)}`);
  console.log(`    Domains with X-AspNet-Version     : ${String(s.headerPresence.x_aspnet_version ?? 0).padStart(4)}   ${pct(s.headerPresence.x_aspnet_version ?? 0, no)}`);
  console.log(`    Domains with X-AspNetMVC-Version  : ${String(s.headerPresence.x_aspnetmvc_version ?? 0).padStart(4)}   ${pct(s.headerPresence.x_aspnetmvc_version ?? 0, no)}`);

  if (Object.keys(s.serverValues).length > 0) {
    console.log(`\n    Server header values (normalised):`);
    const svSorted = Object.entries(s.serverValues).sort((a, b) => b[1] - a[1]);
    for (const [v, n] of svSorted) {
      console.log(`      ${n.toString().padStart(4)}  ${v}`);
    }
  }

  if (Object.keys(s.xpbValues).length > 0) {
    console.log(`\n    X-Powered-By values:`);
    const xpbSorted = Object.entries(s.xpbValues).sort((a, b) => b[1] - a[1]);
    for (const [v, n] of xpbSorted) {
      console.log(`      ${n.toString().padStart(4)}  ${v}`);
    }
  }

  // ── Obj 12: Differentiation assessment ──────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n15. DIFFERENTIATION ASSESSMENT  (${no} observed)\n`);
  console.log(`    Headers by adoption rate — signal differentiation potential:\n`);

  const fieldsByAdoption = [...HEADER_FIELDS]
    .map(f => ({ f, n: s.headerPresence[f] ?? 0 }))
    .sort((a, b) => b.n - a.n);

  // Near-universal (>80%)
  const nearUniversal = fieldsByAdoption.filter(({ n }) => n / no > 0.80);
  // Mid-range (20–80%)
  const midRange      = fieldsByAdoption.filter(({ n }) => n / no >= 0.20 && n / no <= 0.80);
  // Low adoption (5–20%)
  const lowAdoption   = fieldsByAdoption.filter(({ n }) => n / no >= 0.05 && n / no < 0.20);
  // Rare (<5%, >0)
  const rare          = fieldsByAdoption.filter(({ n }) => n > 0 && n / no < 0.05);
  // Absent
  const absentAll     = fieldsByAdoption.filter(({ n }) => n === 0);

  if (nearUniversal.length > 0) {
    console.log(`    Near-universal adoption (>80%) — low differentiation:`);
    for (const { f, n } of nearUniversal) {
      console.log(`      ${pct(n, no)}  ${HEADER_LABELS[f]}`);
    }
  }
  if (midRange.length > 0) {
    console.log(`\n    Mid-range adoption (20–80%) — highest differentiation potential:`);
    for (const { f, n } of midRange) {
      console.log(`      ${pct(n, no)}  ${HEADER_LABELS[f]}`);
    }
  }
  if (lowAdoption.length > 0) {
    console.log(`\n    Low adoption (5–20%) — identifies leading adopters:`);
    for (const { f, n } of lowAdoption) {
      console.log(`      ${pct(n, no)}  ${HEADER_LABELS[f]}`);
    }
  }
  if (rare.length > 0) {
    console.log(`\n    Rare (<5%) — marks outliers / early adopters:`);
    for (const { f, n } of rare) {
      console.log(`      ${pct(n, no)}  ${HEADER_LABELS[f]}`);
    }
  }
  if (absentAll.length > 0) {
    console.log(`\n    Absent from all observed domains (0%):`);
    for (const { f } of absentAll) {
      console.log(`      ${HEADER_LABELS[f]}`);
    }
  }

  console.log(`\n${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(76);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYHEADERS-001 — HE-001 University Cohort Collection`);
  console.log(` Signal: SOT-SECURITYHEADERS-001 v1   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${startedAt.toISOString()}`);
  console.log(` Run ID: ${RUN_ID}`);
  console.log(` Concurrency: ${CONCURRENCY}`);
  console.log(HR);

  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s) with no queryable domain:`);
    for (const sk of skipped) {
      console.log(`    • UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
    }
  }

  const supabase = getClient();
  const { error: pingErr } = await supabase
    .from('signal_securityheaders_v1')
    .select('id')
    .limit(1);

  if (pingErr) {
    const missing = pingErr.message?.includes('does not exist') || pingErr.code === '42P01';
    if (missing) {
      console.error('\n  ERROR: signal_securityheaders_v1 table not found.');
      console.error('  Apply backend/db/migrations/014_signal_lab_securityheaders.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_securityheaders_v1 ready\n');

  console.log(`${HR}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);

  const t0 = Date.now();

  const rows = await runWithConcurrency(institutions, async (inst, i) => {
    let record         = null;
    let collectorError = null;

    try {
      record = await collectSecurityHeaders(inst.domain, COLLECTOR_VERSION);
    } catch (err) {
      collectorError = err.message ?? String(err);
    }

    let dbError = null;
    if (record) {
      try {
        dbError = await insertRecord(supabase, record);
      } catch (err) {
        dbError = { message: err.message ?? String(err) };
      }
    }

    let line;
    if (record) {
      line = progressLine(record, inst.domain, i, institutions.length);
    } else {
      const p = String(Math.round(((i + 1) / institutions.length) * 100)).padStart(3);
      line = `  [${p}%]  ${inst.domain.padEnd(36)} [ERR!  ] ${collectorError}`;
    }
    if (dbError) line += `  [DB:${dbError.message?.slice(0, 30)}]`;
    console.log(line);

    return { ...inst, record, collectorError, dbError };
  }, CONCURRENCY);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const dbErrs  = rows.filter(r => r.dbError).length;
  const colErrs = rows.filter(r => r.collectorError).length;

  console.log(`\n  Completed: ${institutions.length} institutions in ${elapsed}s`);
  if (dbErrs  > 0) console.log(`  WARNING: ${dbErrs} database write(s) failed`);
  if (colErrs > 0) console.log(`  WARNING: ${colErrs} collector exception(s)`);

  const summary = computeSummary(rows);
  printSummary(summary, startedAt, skipped);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
