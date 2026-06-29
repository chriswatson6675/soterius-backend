'use strict';

// IF-001 Full Cohort — Benchmark Analysis Query
// Produces all statistics required for IF001_SECTOR_BENCHMARK_REPORT.md
//
// v0 signals: deduplicated to latest row per domain (handles pilot+full overlap)
// v1 signals: filtered by run_id
// HE-001:     queried by collected_at date range (2026-06-16 only)
//
// Usage:
//   node backend/signal-lab/if001-full/query-benchmark.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const fs   = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');
const OUTPUT_PATH   = path.join(__dirname, 'benchmark-raw.json');

const IF001_SECTXT_RUN_ID = 'bed70595-6142-4a31-98be-1ca9460e3ffc';
const IF001_SECHDR_RUN_ID = 'e4ef81cf-ab69-46c5-a586-0e7868576067';
const HE001_SECHDR_RUN_ID = '28e7259c-aea0-4af4-9841-75acbd56af45';

// HE-001 ran 2026-06-16; all other cohorts ran 2026-06-17+
const HE001_DATE_FROM = '2026-06-16T00:00:00Z';
const HE001_DATE_TO   = '2026-06-17T00:00:00Z';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

async function fetchPaged(query) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchByDomains(supabase, table, domains) {
  const BATCH = 350;
  const rows = [];
  for (let i = 0; i < domains.length; i += BATCH) {
    const batch = domains.slice(i, i + BATCH);
    const batchRows = await fetchPaged(supabase.from(table).select('*').in('domain', batch));
    rows.push(...batchRows);
  }
  return rows;
}

async function fetchByDateRange(supabase, table, from, to) {
  return fetchPaged(
    supabase.from(table).select('*')
      .gte('collected_at', from)
      .lt('collected_at', to)
  );
}

// Count rows matching a filter — avoids transferring JSONB blobs
async function countRows(supabase, table, filterFn) {
  const { count, error } = await filterFn(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

// ── SecurityTXT v1 analysis (minimal column fetch to avoid JSONB timeout) ────

async function analyseSecurityTxtV1(supabase, runIdOrFilter) {
  const isRunId = typeof runIdOrFilter === 'string';

  const buildQ = q => isRunId
    ? q.eq('run_id', runIdOrFilter)
    : runIdOrFilter(q);

  // Pass 1: file_state distribution (tiny, fast)
  const stateRows = await fetchPaged(buildQ(supabase.from('signal_securitytxt_v1').select('domain,file_state')));
  const n = stateRows.length;
  const fileStateDist = {};
  for (const r of stateRows) fileStateDist[r.file_state] = (fileStateDist[r.file_state] ?? 0) + 1;
  const presentCount = (fileStateDist['PRESENT_CANONICAL'] ?? 0) + (fileStateDist['PRESENT_LEGACY_ONLY'] ?? 0) + (fileStateDist['PRESENT_BOTH'] ?? 0);
  const absentCount  = fileStateDist['ABSENT'] ?? 0;
  const indeterminate = fileStateDist['INDETERMINATE'] ?? 0;

  // Pass 2: field presence counts (server-side count queries, no JSONB transfer)
  const FIELDS = ['contact','expires','encryption','acknowledgments','policy','preferred_languages','hiring','canonical'];
  const fieldCounts = {};
  for (const field of FIELDS) {
    const c = await countRows(supabase, 'signal_securitytxt_v1',
      q => buildQ(q)
        .in('file_state', ['PRESENT_CANONICAL','PRESENT_LEGACY_ONLY','PRESENT_BOTH'])
        .not(`canonical_parse->${field}`, 'is', null)
        .not(`canonical_parse->${field}`, 'eq', '[]')
    );
    fieldCounts[field] = c;
  }

  // Pass 3: known_field_count distribution — fetch just that scalar
  const kfcRows = await fetchPaged(
    buildQ(supabase.from('signal_securitytxt_v1')
      .select('canonical_parse->known_field_count')
      .in('file_state', ['PRESENT_CANONICAL','PRESENT_LEGACY_ONLY','PRESENT_BOTH']))
  );
  const kfcValues = kfcRows.map(r => Number(r['known_field_count'] ?? r['canonical_parse->known_field_count'] ?? 0));

  return {
    total: n,
    present: presentCount,
    absent: absentCount,
    indeterminate,
    adoptionPct: n > 0 ? Math.round(presentCount / n * 1000) / 10 : 0,
    fileStateDist,
    fieldCounts,
    fieldCountStats: numericStats(kfcValues),
    fieldCountDist: freq(kfcValues.map(String)),
    spartan: kfcValues.filter(v => v <= 1).length,
    full: kfcValues.filter(v => v >= 4).length,
    noExpires: (fieldCounts['contact'] ?? 0) > 0 ? presentCount - (fieldCounts['expires'] ?? 0) : null,
    // Internal: per-domain state for cross-signal analysis
    _stateRows: stateRows,
  };
}

// ── SecurityHeaders v1 analysis (minimal column fetch to avoid JSONB timeout) ─

const HEADER_FIELDS = [
  'strict_transport_security', 'content_security_policy', 'content_security_policy_report_only',
  'x_frame_options', 'x_content_type_options', 'referrer_policy', 'permissions_policy',
  'feature_policy', 'cross_origin_opener_policy', 'cross_origin_opener_policy_report_only',
  'cross_origin_embedder_policy', 'cross_origin_embedder_policy_report_only',
  'cross_origin_resource_policy', 'reporting_endpoints', 'report_to', 'nel',
  'origin_agent_cluster', 'x_xss_protection', 'expect_ct', 'public_key_pins',
  'public_key_pins_report_only', 'server', 'x_powered_by', 'x_aspnet_version', 'x_aspnetmvc_version',
];
const SEC_FIELDS      = HEADER_FIELDS.filter(f => !['server','x_powered_by','x_aspnet_version','x_aspnetmvc_version'].includes(f));
const DISCLOSURE_FIELDS = ['server','x_powered_by','x_aspnet_version','x_aspnetmvc_version'];

async function analyseSecurityHeadersV1(supabase, runIdOrFilter) {
  const isRunId = typeof runIdOrFilter === 'string';
  const buildQ = q => isRunId
    ? q.eq('run_id', runIdOrFilter)
    : runIdOrFilter(q);

  // Pass 1: endpoint_state distribution (tiny)
  const stateRows = await fetchPaged(buildQ(supabase.from('signal_securityheaders_v1').select('domain,endpoint_state')));
  const n = stateRows.length;
  const endpointDist = {};
  for (const r of stateRows) endpointDist[r.endpoint_state] = (endpointDist[r.endpoint_state] ?? 0) + 1;
  const observedCount = endpointDist['RESPONSE_OBSERVED'] ?? 0;

  // Pass 2: per-header presence counts (server-side, no JSONB transfer)
  const headerPresence = {};
  for (const f of HEADER_FIELDS) {
    const c = await countRows(supabase, 'signal_securityheaders_v1',
      q => buildQ(q)
        .eq('endpoint_state', 'RESPONSE_OBSERVED')
        .eq(`header_inventory->${f}->>present`, 'true')
    );
    headerPresence[f] = c;
  }

  // Pass 3: security header count distribution
  // Use a batch of domain+count by fetching header_inventory->sec_header_count if it exists,
  // or approximate by counting per-domain how many SEC_FIELDS are present.
  // Approach: fetch a small column projection with per-domain sec header totals.
  // We sum per-header counts from the server-side counts we already have,
  // but we need PER-DOMAIN distribution. Use a targeted fetch of minimal fields.
  // Fetch just the presence booleans for the 6 most common sec headers as a proxy:
  const KEY_HEADERS = ['strict_transport_security','x_frame_options','x_content_type_options','content_security_policy','referrer_policy','permissions_policy'];
  const secCountData = await fetchPaged(
    buildQ(supabase.from('signal_securityheaders_v1')
      .select(['domain', ...KEY_HEADERS.map(f => `header_inventory->${f}->>present`)].join(','))
      .eq('endpoint_state', 'RESPONSE_OBSERVED'))
  );

  // Count how many key headers each domain has (proxy for overall security header count)
  const domainKeyCounts = secCountData.map(r => {
    let count = 0;
    for (const f of KEY_HEADERS) {
      const val = r[`header_inventory->${f}->>present`] ?? r[f];
      if (val === 'true' || val === true) count++;
    }
    return { domain: r.domain, keyCount: count };
  });

  const keyCountDist = {};
  for (const d of domainKeyCounts) {
    keyCountDist[String(d.keyCount)] = (keyCountDist[String(d.keyCount)] ?? 0) + 1;
  }
  const keyCountValues = domainKeyCounts.map(d => d.keyCount);
  const zeroCount = domainKeyCounts.filter(d => d.keyCount === 0).length;

  return {
    total: n,
    responseObserved: observedCount,
    notResponding: n - observedCount,
    respondingPct: n > 0 ? Math.round(observedCount / n * 1000) / 10 : 0,
    endpointDist,
    headerPresence,
    keyHeaderCountStats: numericStats(keyCountValues),
    keyHeaderCountDist: keyCountDist,
    zeroKeyHeaders: zeroCount,
    zeroKeyPct: observedCount > 0 ? Math.round(zeroCount / observedCount * 1000) / 10 : 0,
    hstsCount: headerPresence['strict_transport_security'] ?? 0,
    hstsPct: observedCount > 0 ? Math.round((headerPresence['strict_transport_security'] ?? 0) / observedCount * 1000) / 10 : 0,
    cspCount: headerPresence['content_security_policy'] ?? 0,
    cspPct: observedCount > 0 ? Math.round((headerPresence['content_security_policy'] ?? 0) / observedCount * 1000) / 10 : 0,
    xfoCount: headerPresence['x_frame_options'] ?? 0,
    xctoCount: headerPresence['x_content_type_options'] ?? 0,
    serverDisclosure: headerPresence['server'] ?? 0,
    serverDisclosurePct: observedCount > 0 ? Math.round((headerPresence['server'] ?? 0) / observedCount * 1000) / 10 : 0,
    xpbDisclosure: headerPresence['x_powered_by'] ?? 0,
    // Internal per-domain counts for cross-signal analysis
    _domainKeyCounts: domainKeyCounts,
    _stateRows: stateRows,
  };
}

// Keep only the latest row per domain (handles pilot/full overlap in v0 tables)
function latestPerDomain(rows) {
  const byDomain = new Map();
  for (const row of rows) {
    const existing = byDomain.get(row.domain);
    if (!existing || row.collected_at > existing.collected_at) {
      byDomain.set(row.domain, row);
    }
  }
  return [...byDomain.values()];
}

// ── Statistics helpers ─────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function numericStats(values) {
  if (values.length === 0) {
    return { n: 0, min: null, q1: null, median: null, q3: null, max: null, mean: null, deciles: {} };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const deciles = {};
  for (let i = 1; i <= 9; i++) {
    deciles[`p${i * 10}`] = Math.round(quantile(sorted, i / 10) * 10) / 10;
  }
  return {
    n,
    min: sorted[0],
    q1: Math.round(quantile(sorted, 0.25) * 10) / 10,
    median: Math.round(quantile(sorted, 0.5) * 10) / 10,
    q3: Math.round(quantile(sorted, 0.75) * 10) / 10,
    max: sorted[n - 1],
    mean: Math.round(mean * 100) / 100,
    deciles,
  };
}

function freq(values) {
  const d = {};
  for (const v of values) {
    const k = v === null || v === undefined ? 'null' : String(v);
    d[k] = (d[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(d).sort((a, b) => b[1] - a[1]));
}

// ── Signal-specific analysis ───────────────────────────────────────────────────

function analyseSpf(rows) {
  const n = rows.length;
  const present = rows.filter(r => r.spf_present === true);
  const absent  = rows.filter(r => r.spf_present === false);
  const unknown = rows.filter(r => r.spf_present === null);

  const lookupValues   = present.map(r => r.spf_lookup_count  ?? 0);
  const includeValues  = present.map(r => r.spf_include_count ?? 0);

  return {
    total: n,
    present: present.length,
    absent:  absent.length,
    unknown: unknown.length,
    adoptionPct: pct(present.length, n),
    mechDist: freq(present.map(r => r.spf_mechanism)),
    lookupStats: numericStats(lookupValues),
    lookupDist:  freq(lookupValues.map(String)),
    includeStats: numericStats(includeValues),
    includeDist:  freq(includeValues.map(String)),
    multiRecord:  rows.filter(r => r.spf_multiple_records === true).length,
    parseFail:    rows.filter(r => r.spf_parse_success === false).length,
    highLookup:   present.filter(r => (r.spf_lookup_count ?? 0) > 10)
                         .sort((a, b) => b.spf_lookup_count - a.spf_lookup_count)
                         .slice(0, 10)
                         .map(r => ({ domain: r.domain, lookup_count: r.spf_lookup_count, mechanism: r.spf_mechanism })),
    topLookup:    [...present].sort((a, b) => (b.spf_lookup_count ?? 0) - (a.spf_lookup_count ?? 0))
                              .slice(0, 10)
                              .map(r => ({ domain: r.domain, lookup_count: r.spf_lookup_count, mechanism: r.spf_mechanism })),
    noSpf:        absent.slice(0, 30).map(r => r.domain),
    noSpfCount:   absent.length,
    hardenedCount: present.filter(r => r.spf_mechanism === '-all').length,
    softfailCount: present.filter(r => r.spf_mechanism === '~all').length,
  };
}

function analyseDkim(rows, keys) {
  const n = rows.length;
  const present     = rows.filter(r => r.dkim_present === true);
  const notDetected = rows.filter(r => r.dkim_collection_status === 'NOT_DETECTED');
  const dnsError    = rows.filter(r => r.dkim_present !== true && r.dkim_collection_status !== 'NOT_DETECTED');

  const selectorCounts = present.map(r => r.dkim_selectors_found?.length ?? 0);

  // Key bits distribution (from keys table, only from latest domain rows)
  const keyBitsValues = keys.filter(k => k.key_bits !== null).map(k => k.key_bits);

  // Selector name frequency
  const selFreq = freq(keys.map(k => k.selector ?? 'unknown'));

  // Domains with multiple selectors
  const multiSelector = present.filter(r => (r.dkim_selectors_found?.length ?? 0) > 1);

  return {
    total: n,
    present: present.length,
    notDetected: notDetected.length,
    dnsError: dnsError.length,
    adoptionPct: pct(present.length, n),
    totalKeys: keys.length,
    selectorCountStats: numericStats(selectorCounts),
    selectorCountDist: freq(selectorCounts.map(String)),
    keyBitsStats: numericStats(keyBitsValues),
    keyBitsDist: freq(keyBitsValues.map(String)),
    keyTypeDist: freq(keys.map(k => k.key_type ?? 'unknown')),
    topSelectorCounts: [...present]
      .sort((a, b) => (b.dkim_selectors_found?.length ?? 0) - (a.dkim_selectors_found?.length ?? 0))
      .slice(0, 10)
      .map(r => ({ domain: r.domain, count: r.dkim_selectors_found?.length ?? 0, selectors: r.dkim_selectors_found })),
    selectorFreqTop20: Object.fromEntries(Object.entries(selFreq).slice(0, 20)),
    bits1024Count: keyBitsValues.filter(b => b === 1024).length,
    bits2048Count: keyBitsValues.filter(b => b === 2048).length,
    bits4096Count: keyBitsValues.filter(b => b >= 4096).length,
    multiSelectorCount: multiSelector.length,
    noDkimDomains: rows.filter(r => r.dkim_present !== true).slice(0, 20).map(r => r.domain),
    noDkimCount: n - present.length,
  };
}

function analyseDmarc(rows) {
  const n = rows.length;
  const present = rows.filter(r => r.dmarc_present === true);
  const absent  = rows.filter(r => r.dmarc_present === false);
  const unknown = rows.filter(r => r.dmarc_present === null);

  const pctValues = present.filter(r => r.dmarc_pct !== null).map(r => r.dmarc_pct);

  return {
    total: n,
    present: present.length,
    absent:  absent.length,
    unknown: unknown.length,
    adoptionPct: pct(present.length, n),
    policyDist: freq(present.map(r => r.dmarc_policy ?? 'null')),
    subdomainPolicyDist: freq(present.map(r => r.dmarc_subdomain_policy ?? 'absent')),
    pctStats: numericStats(pctValues),
    pctDist:  freq(present.map(r => r.dmarc_pct === null ? 'absent' : String(r.dmarc_pct))),
    ruaCount:  present.filter(r => (r.dmarc_rua_count ?? 0) > 0).length,
    rufCount:  present.filter(r => (r.dmarc_ruf_count ?? 0) > 0).length,
    adkimDist: freq(present.map(r => r.dmarc_adkim ?? 'absent')),
    aspfDist:  freq(present.map(r => r.dmarc_aspf  ?? 'absent')),
    rejectCount: present.filter(r => r.dmarc_policy === 'reject').length,
    quarCount:   present.filter(r => r.dmarc_policy === 'quarantine').length,
    noneCount:   present.filter(r => r.dmarc_policy === 'none').length,
    noDmarc:     absent.slice(0, 30).map(r => r.domain),
    noDmarcCount: absent.length,
    parseFail:   present.filter(r => r.dmarc_parse_success === false).length,
    multiRecord:  rows.filter(r => r.dmarc_multiple_records === true).length,
  };
}

function analyseMtasts(rows) {
  const n = rows.length;
  const dnsPresent = rows.filter(r => r.dns_sts_present === true);
  const dnsAbsent  = rows.filter(r => r.dns_sts_present === false);
  const dnsUnknown = rows.filter(r => r.dns_sts_present === null);
  const policyPresent = dnsPresent.filter(r => r.policy_present === true);

  const modeDist = freq(policyPresent.map(r => r.policy_mode ?? 'null'));

  return {
    total: n,
    dnsPresent: dnsPresent.length,
    dnsAbsent:  dnsAbsent.length,
    dnsUnknown: dnsUnknown.length,
    adoptionPct: pct(dnsPresent.length, n),
    policyPresent: policyPresent.length,
    policyAbsent:  dnsPresent.filter(r => r.policy_present === false).length,
    modeDist,
    tlsInvalid: dnsPresent.filter(r => r.policy_tls_valid === false).length,
    adopters: policyPresent.map(r => ({ domain: r.domain, mode: r.policy_mode })),
  };
}

function analyseTlsrpt(rows) {
  const n = rows.length;
  const present = rows.filter(r => r.dns_tlsrpt_present === true);
  const absent  = rows.filter(r => r.dns_tlsrpt_present === false);
  const unknown = rows.filter(r => r.dns_tlsrpt_present === null);

  let mailtoCount = 0, httpsCount = 0;
  for (const r of present) {
    mailtoCount += r.rua_mailto_count ?? 0;
    httpsCount  += r.rua_https_count  ?? 0;
  }

  return {
    total: n,
    present: present.length,
    absent:  absent.length,
    unknown: unknown.length,
    adoptionPct: pct(present.length, n),
    mailtoRua: mailtoCount,
    httpsRua:  httpsCount,
    adopters:  present.slice(0, 30).map(r => r.domain),
    adoptersCount: present.length,
  };
}

function analyseDnssec(rows) {
  const n = rows.length;
  const dsPresent   = rows.filter(r => r.dns_ds_present === true);
  const dsAbsent    = rows.filter(r => r.dns_ds_present === false);
  const dsUnknown   = rows.filter(r => r.dns_ds_present === null);
  const dkPresent   = rows.filter(r => r.dns_dnskey_present === true);
  const bothPresent = rows.filter(r => r.dns_ds_present === true && r.dns_dnskey_present === true);

  const algValues = [];
  for (const r of dsPresent) {
    for (const a of r.ds_algorithms ?? []) algValues.push(a);
  }

  return {
    total: n,
    dsPresent:  dsPresent.length,
    dsAbsent:   dsAbsent.length,
    dsUnknown:  dsUnknown.length,
    dkPresent:  dkPresent.length,
    bothPresent: bothPresent.length,
    adoptionPct: pct(dsPresent.length, n),
    algDist: freq(algValues.map(String)),
    adopters: dsPresent.slice(0, 30).map(r => ({ domain: r.domain, algorithms: r.ds_algorithms })),
    adoptersCount: dsPresent.length,
  };
}

function analyseCaa(rows) {
  const n = rows.length;
  const present = rows.filter(r => r.dns_caa_present === true);
  const absent  = rows.filter(r => r.dns_caa_present === false);
  const unknown = rows.filter(r => r.dns_caa_present === null);

  let caaWithIssue = 0, caaWithWild = 0, caaWithIodef = 0;
  const issueValues = {};
  const recordCountValues = present.map(r => r.caa_record_count ?? 0);

  for (const r of present) {
    if ((r.caa_issue_count ?? 0) > 0) {
      caaWithIssue++;
      for (const v of r.caa_issue_values ?? []) {
        const norm = (v ?? '').toLowerCase().trim();
        issueValues[norm] = (issueValues[norm] ?? 0) + 1;
      }
    }
    if ((r.caa_issuewild_count ?? 0) > 0) caaWithWild++;
    if ((r.caa_iodef_count     ?? 0) > 0) caaWithIodef++;
  }

  return {
    total: n,
    present: present.length,
    absent:  absent.length,
    unknown: unknown.length,
    adoptionPct: pct(present.length, n),
    caaWithIssue,
    caaWithWild,
    caaWithIodef,
    recordCountStats: numericStats(recordCountValues),
    recordCountDist: freq(recordCountValues.map(String)),
    issueValues: Object.fromEntries(Object.entries(issueValues).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    adopters: present.slice(0, 30).map(r => r.domain),
    adoptersCount: present.length,
  };
}

function analyseSecurityTxt(rows) {
  const n = rows.length;
  const FIELDS = ['contact', 'expires', 'encryption', 'acknowledgments', 'policy', 'preferred_languages', 'hiring', 'canonical'];

  const present = rows.filter(r =>
    r.file_state === 'PRESENT_CANONICAL' ||
    r.file_state === 'PRESENT_LEGACY_ONLY' ||
    r.file_state === 'PRESENT_BOTH'
  );
  const absent        = rows.filter(r => r.file_state === 'ABSENT');
  const indeterminate = rows.filter(r => r.file_state === 'INDETERMINATE');

  const parseOf = r => r.canonical_parse ?? r.legacy_parse ?? null;
  const arrPresent = (p, field) => {
    if (!p) return false;
    const v = p[field];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  };

  const fieldCounts = Object.fromEntries(FIELDS.map(f => [f, 0]));
  const fieldCountPerDomain = [];

  for (const r of present) {
    const p = parseOf(r);
    let count = 0;
    for (const f of FIELDS) {
      if (arrPresent(p, f)) { fieldCounts[f]++; count++; }
    }
    fieldCountPerDomain.push({ domain: r.domain, fieldCount: count, fileState: r.file_state });
  }

  const fieldCountValues = fieldCountPerDomain.map(d => d.fieldCount);

  return {
    total: n,
    present: present.length,
    absent:  absent.length,
    indeterminate: indeterminate.length,
    adoptionPct: pct(present.length, n),
    fileStateDist: freq(rows.map(r => r.file_state)),
    fieldCounts,
    fieldCountStats: numericStats(fieldCountValues),
    fieldCountDist:  freq(fieldCountValues.map(String)),
    richest: [...fieldCountPerDomain].sort((a, b) => b.fieldCount - a.fieldCount).slice(0, 10),
    spartan: fieldCountPerDomain.filter(d => d.fieldCount <= 1).length,
    contactOnly: fieldCountPerDomain.filter(d => d.fieldCount === 1).length,
    full: fieldCountPerDomain.filter(d => d.fieldCount >= 4).length,
    noExpires: present.filter(r => !arrPresent(parseOf(r), 'expires')).length,
    adopters: present.slice(0, 30).map(r => r.domain),
  };
}

function analyseSecurityHeaders(rows) {
  const HEADER_FIELDS = [
    'strict_transport_security', 'content_security_policy', 'content_security_policy_report_only',
    'x_frame_options', 'x_content_type_options', 'referrer_policy', 'permissions_policy',
    'feature_policy', 'cross_origin_opener_policy', 'cross_origin_opener_policy_report_only',
    'cross_origin_embedder_policy', 'cross_origin_embedder_policy_report_only',
    'cross_origin_resource_policy', 'reporting_endpoints', 'report_to', 'nel',
    'origin_agent_cluster', 'x_xss_protection', 'expect_ct', 'public_key_pins',
    'public_key_pins_report_only', 'server', 'x_powered_by', 'x_aspnet_version', 'x_aspnetmvc_version',
  ];
  const SEC_HEADERS = HEADER_FIELDS.filter(f => !['server','x_powered_by','x_aspnet_version','x_aspnetmvc_version'].includes(f));
  const DISCLOSURE  = ['server','x_powered_by','x_aspnet_version','x_aspnetmvc_version'];

  const n = rows.length;
  const observed = rows.filter(r => r.endpoint_state === 'RESPONSE_OBSERVED');

  const endpointDist = freq(rows.map(r => r.endpoint_state));

  const headerPresence = {};
  for (const f of HEADER_FIELDS) {
    headerPresence[f] = observed.filter(r => r.header_inventory?.[f]?.present).length;
  }

  const secCountPerDomain = observed.map(r => {
    const inv = r.header_inventory ?? {};
    const secCount = SEC_HEADERS.filter(f => inv[f]?.present).length;
    const discCount = DISCLOSURE.filter(f => inv[f]?.present).length;
    return { domain: r.domain, secCount, discCount, allCount: secCount + discCount };
  });

  const secCountValues = secCountPerDomain.map(d => d.secCount);

  const hstsPresent = observed.filter(r => r.header_inventory?.strict_transport_security?.present);
  const maxAges = [];
  for (const r of hstsPresent) {
    const val = r.header_inventory.strict_transport_security.values?.[0] ?? '';
    const m = val.match(/max-age\s*=\s*(\d+)/i);
    if (m) maxAges.push(Number(m[1]));
  }
  maxAges.sort((a, b) => a - b);

  return {
    total: n,
    responseObserved: observed.length,
    notResponding: n - observed.length,
    endpointDist,
    respondingPct: pct(observed.length, n),
    headerPresence: Object.fromEntries(
      Object.entries(headerPresence).sort((a, b) => b[1] - a[1])
    ),
    secCountStats: numericStats(secCountValues),
    secCountDist:  freq(secCountValues.map(String)),
    zeroSecHeaders: secCountPerDomain.filter(d => d.secCount === 0).length,
    zeroSecPct: pct(secCountPerDomain.filter(d => d.secCount === 0).length, observed.length),
    serverDisclosure: headerPresence['server'] ?? 0,
    serverDisclosurePct: pct(headerPresence['server'] ?? 0, observed.length),
    xpbDisclosure: headerPresence['x_powered_by'] ?? 0,
    hstsCount: hstsPresent.length,
    hstsPct: pct(hstsPresent.length, observed.length),
    hstsMaxAgeStats: numericStats(maxAges),
    cspCount: headerPresence['content_security_policy'] ?? 0,
    cspPct: pct(headerPresence['content_security_policy'] ?? 0, observed.length),
    xfoCount: headerPresence['x_frame_options'] ?? 0,
    xctoCount: headerPresence['x_content_type_options'] ?? 0,
    topDomains: [...secCountPerDomain].sort((a, b) => b.secCount - a.secCount).slice(0, 10),
    bottomDomains: [...secCountPerDomain].sort((a, b) => a.secCount - b.secCount).slice(0, 10)
      .filter(d => d.domain),
    perDomainCounts: secCountPerDomain,
  };
}

// ── Cross-signal analysis ─────────────────────────────────────────────────────

// sectxtStateRows: [{domain, file_state}]
// sechdrKeyCounts: [{domain, keyCount}] from analyseSecurityHeadersV1 _domainKeyCounts
function crossSignalAnalysis(domains, spf, dkim, dmarc, mtasts, tlsrpt, dnssec, caa, sectxtStateRows, sechdrKeyCounts) {
  const spfMap    = new Map(spf.map(r => [r.domain, r]));
  const dkimMap   = new Map(dkim.map(r => [r.domain, r]));
  const dmarcMap  = new Map(dmarc.map(r => [r.domain, r]));
  const mtastsMap = new Map(mtasts.map(r => [r.domain, r]));
  const tlsrptMap = new Map(tlsrpt.map(r => [r.domain, r]));
  const dnssecMap = new Map(dnssec.map(r => [r.domain, r]));
  const caaMap    = new Map(caa.map(r => [r.domain, r]));
  const sectxtMap = new Map((sectxtStateRows ?? []).map(r => [r.domain, r]));
  const sechdrMap = new Map((sechdrKeyCounts ?? []).map(r => [r.domain, r]));

  const perDomain = domains.map(domain => {
    const s   = spfMap.get(domain);
    const dk  = dkimMap.get(domain);
    const dm  = dmarcMap.get(domain);
    const mts = mtastsMap.get(domain);
    const tls = tlsrptMap.get(domain);
    const dns = dnssecMap.get(domain);
    const c   = caaMap.get(domain);
    const st  = sectxtMap.get(domain);
    const sh  = sechdrMap.get(domain);

    const spfPresent    = s?.spf_present === true;
    const spfHardened   = s?.spf_mechanism === '-all';
    const dkimPresent   = dk?.dkim_present === true;
    const dmarcPresent  = dm?.dmarc_present === true;
    const dmarcReject   = dm?.dmarc_policy === 'reject';
    const dmarcQuarantine = dm?.dmarc_policy === 'quarantine';
    const mtastsPresent = mts?.dns_sts_present === true;
    const mtastsEnforce = mts?.policy_mode === 'enforce';
    const tlsrptPresent = tls?.dns_tlsrpt_present === true;
    const dnssecPresent = dns?.dns_ds_present === true;
    const caaPresent    = c?.dns_caa_present === true;
    const sectxtPresent = st?.file_state?.startsWith('PRESENT') ?? false;
    const secHdrCount   = sh?.keyCount ?? 0;
    const secHdrPresent = secHdrCount > 0;

    return {
      domain,
      spfPresent, spfHardened,
      dkimPresent,
      dmarcPresent, dmarcReject, dmarcQuarantine,
      mtastsPresent, mtastsEnforce,
      tlsrptPresent,
      dnssecPresent,
      caaPresent,
      sectxtPresent,
      secHdrCount, secHdrPresent,
      signalCount: [spfPresent, dkimPresent, dmarcPresent, mtastsPresent, tlsrptPresent, dnssecPresent, caaPresent, sectxtPresent, secHdrPresent].filter(Boolean).length,
    };
  });

  // Profile classification
  const profiles = {
    broadAdopters: perDomain.filter(d => d.signalCount >= 7).length,
    strongEmail: perDomain.filter(d => d.spfPresent && d.dkimPresent && d.dmarcPresent && d.dmarcReject).length,
    emailCoverage: perDomain.filter(d => d.spfPresent && d.dkimPresent && d.dmarcPresent).length,
    noEmail: perDomain.filter(d => !d.spfPresent && !d.dkimPresent && !d.dmarcPresent).length,
    strongWeb: perDomain.filter(d => d.secHdrCount >= 4).length,
    dnsLayered: perDomain.filter(d => d.dnssecPresent && d.caaPresent).length,
    transparent: perDomain.filter(d => d.sectxtPresent).length,
    minimalSignals: perDomain.filter(d => d.signalCount <= 2).length,
    signalCountDist: freq(perDomain.map(d => String(d.signalCount))),
  };

  // Key co-occurrence relationships
  const dmarcAndDkim = perDomain.filter(d => d.dmarcPresent && d.dkimPresent).length;
  const spfAndDmarc  = perDomain.filter(d => d.spfPresent && d.dmarcPresent).length;
  const tripleEmail  = perDomain.filter(d => d.spfPresent && d.dkimPresent && d.dmarcPresent).length;
  const sectxtAndSh  = perDomain.filter(d => d.sectxtPresent && d.secHdrPresent).length;
  const dnssecAndCaa = perDomain.filter(d => d.dnssecPresent && d.caaPresent).length;
  const mtastsAndTlsrpt = perDomain.filter(d => d.mtastsPresent && d.tlsrptPresent).length;
  const dmarcRejectAndDkim = perDomain.filter(d => d.dmarcReject && d.dkimPresent).length;
  const dmarcNoneWithNoEnforcement = perDomain.filter(d => d.dmarcPresent && !d.dmarcReject && !d.dmarcQuarantine).length;

  return {
    perDomain: perDomain.slice(0, 50), // limit output size
    profiles,
    relationships: {
      dmarcAndDkim, spfAndDmarc, tripleEmail,
      sectxtAndSh, dnssecAndCaa, mtastsAndTlsrpt,
      dmarcRejectAndDkim, dmarcNoneWithNoEnforcement,
    },
    signalCountStats: numericStats(perDomain.map(d => d.signalCount)),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifest  = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const if001Domains = manifest.firms.map(f => f.domain);
  const supabase  = getClient();

  console.error(`IF-001 domains: ${if001Domains.length}`);
  console.error('Fetching IF-001 v0 signals...');

  // IF-001 v0 signals (batch by domain, deduplicate to latest)
  const [rawSpf, rawDkim, rawDkimKeys, rawDmarc, rawMtasts, rawTlsrpt, rawDnssec, rawCaa] =
    await Promise.all([
      fetchByDomains(supabase, 'signal_facts_spf',      if001Domains),
      fetchByDomains(supabase, 'signal_facts_dkim',     if001Domains),
      fetchByDomains(supabase, 'signal_facts_dkim_keys', if001Domains),
      fetchByDomains(supabase, 'signal_facts_dmarc',    if001Domains),
      fetchByDomains(supabase, 'signal_facts_mtasts',   if001Domains),
      fetchByDomains(supabase, 'signal_facts_tlsrpt',   if001Domains),
      fetchByDomains(supabase, 'signal_facts_dnssec',   if001Domains),
      fetchByDomains(supabase, 'signal_facts_caa',      if001Domains),
    ]);

  console.error('Deduplicating v0 signals...');
  const if001Spf    = latestPerDomain(rawSpf);
  const if001Dkim   = latestPerDomain(rawDkim);
  const if001Dmarc  = latestPerDomain(rawDmarc);
  const if001Mtasts = latestPerDomain(rawMtasts);
  const if001Tlsrpt = latestPerDomain(rawTlsrpt);
  const if001Dnssec = latestPerDomain(rawDnssec);
  const if001Caa    = latestPerDomain(rawCaa);

  // Filter DKIM keys to only those from latest DKIM domain rows
  const dkimRowIds  = new Set(if001Dkim.map(r => r.id));
  const if001DkimKeys = rawDkimKeys.filter(k => dkimRowIds.has(k.dkim_run_id));

  console.error(`  SPF: ${if001Spf.length}, DKIM: ${if001Dkim.length}, Keys: ${if001DkimKeys.length}`);
  console.error(`  DMARC: ${if001Dmarc.length}, MTASTS: ${if001Mtasts.length}, TLSRPT: ${if001Tlsrpt.length}`);
  console.error(`  DNSSEC: ${if001Dnssec.length}, CAA: ${if001Caa.length}`);

  console.error('Fetching IF-001 v1 signals (targeted queries to avoid JSONB timeout)...');

  // ── IF-001 v0 analysis ─────────────────────────────────────────────────────
  console.error('Computing IF-001 v0 statistics...');
  const if001 = {
    spf:    analyseSpf(if001Spf),
    dkim:   analyseDkim(if001Dkim, if001DkimKeys),
    dmarc:  analyseDmarc(if001Dmarc),
    mtasts: analyseMtasts(if001Mtasts),
    tlsrpt: analyseTlsrpt(if001Tlsrpt),
    dnssec: analyseDnssec(if001Dnssec),
    caa:    analyseCaa(if001Caa),
  };

  // ── IF-001 v1 analysis (server-side query approach) ────────────────────────
  console.error('Fetching IF-001 SecurityTXT...');
  if001.sectxt = await analyseSecurityTxtV1(supabase, IF001_SECTXT_RUN_ID);
  console.error(`  SecurityTXT: ${if001.sectxt.total} rows, ${if001.sectxt.present} present`);

  console.error('Fetching IF-001 SecurityHeaders...');
  if001.sechdr = await analyseSecurityHeadersV1(supabase, IF001_SECHDR_RUN_ID);
  console.error(`  SecurityHeaders: ${if001.sechdr.total} rows, ${if001.sechdr.responseObserved} responding`);

  // ── HE-001 v0 data ─────────────────────────────────────────────────────────
  console.error('Fetching HE-001 v0 data...');
  const [he001Spf, he001Dkim, he001DkimKeys, he001Dmarc, he001Mtasts, he001Tlsrpt, he001Dnssec, he001Caa] =
    await Promise.all([
      fetchByDateRange(supabase, 'signal_facts_spf',       HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_dkim',      HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_dkim_keys', HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_dmarc',     HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_mtasts',    HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_tlsrpt',    HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_dnssec',    HE001_DATE_FROM, HE001_DATE_TO),
      fetchByDateRange(supabase, 'signal_facts_caa',       HE001_DATE_FROM, HE001_DATE_TO),
    ]);

  console.error(`  HE-001 SPF: ${he001Spf.length}, DKIM: ${he001Dkim.length}, Keys: ${he001DkimKeys.length}`);
  const he001DkimIds = new Set(he001Dkim.map(r => r.id));
  const he001DkimKeysFiltered = he001DkimKeys.filter(k => he001DkimIds.has(k.dkim_run_id));

  console.error('Computing HE-001 v0 statistics...');
  const he001 = {
    spf:    analyseSpf(he001Spf),
    dkim:   analyseDkim(he001Dkim, he001DkimKeysFiltered),
    dmarc:  analyseDmarc(he001Dmarc),
    mtasts: analyseMtasts(he001Mtasts),
    tlsrpt: analyseTlsrpt(he001Tlsrpt),
    dnssec: analyseDnssec(he001Dnssec),
    caa:    analyseCaa(he001Caa),
  };

  console.error('Fetching HE-001 SecurityTXT...');
  he001.sectxt = await analyseSecurityTxtV1(supabase, q =>
    q.gte('collected_at', HE001_DATE_FROM).lt('collected_at', HE001_DATE_TO)
  );
  console.error(`  HE-001 SecurityTXT: ${he001.sectxt.total} rows, ${he001.sectxt.present} present`);

  console.error('Fetching HE-001 SecurityHeaders...');
  he001.sechdr = await analyseSecurityHeadersV1(supabase, HE001_SECHDR_RUN_ID);
  console.error(`  HE-001 SecurityHeaders: ${he001.sechdr.total} rows`);

  // ── Cross-signal analysis ──────────────────────────────────────────────────
  console.error('Computing cross-signal analysis...');
  // Use per-domain data already fetched in analysis passes (no extra queries)
  const crossSignal = crossSignalAnalysis(
    if001Domains, if001Spf, if001Dkim, if001Dmarc,
    if001Mtasts, if001Tlsrpt, if001Dnssec, if001Caa,
    if001.sectxt._stateRows ?? [],
    if001.sechdr._domainKeyCounts ?? []
  );

  const output = {
    meta: {
      cohort_id:    'IF-001',
      selection_id: manifest.selection_id,
      n:            if001Domains.length,
      generated_at: new Date().toISOString(),
    },
    if001,
    he001,
    crossSignal,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.error(`\nOutput written to ${OUTPUT_PATH}`);
  console.error('Done.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
