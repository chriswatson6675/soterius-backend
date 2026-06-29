'use strict';

// HE-001 Benchmark Query — Signal Lab
// Queries all 9 signals for cohort stats + University of Nottingham profile.
// Output: structured JSON to stdout — redirect or capture for benchmark doc.
//
// Usage:
//   node backend/signal-lab/query-he001-benchmark.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const TARGET_DOMAIN     = 'nottingham.ac.uk';
const SECHDR_RUN_ID     = '28e7259c-aea0-4af4-9841-75acbd56af45';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function pct(n, total) {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

// ── SPF ───────────────────────────────────────────────────────────────────────

async function querySPF(db) {
  const { data, error } = await db
    .from('signal_facts_spf')
    .select('domain,spf_present,spf_mechanism,spf_lookup_count,spf_include_count,spf_record_count,spf_multiple_records,spf_record,spf_collection_error');
  if (error) throw new Error('SPF: ' + error.message);

  const n = data.length;
  const present = data.filter(r => r.spf_present === true);
  const absent  = data.filter(r => r.spf_present === false);
  const unknown = data.filter(r => r.spf_present === null);

  const mechDist = {};
  for (const r of present) {
    const m = r.spf_mechanism ?? '(no -all)';
    mechDist[m] = (mechDist[m] ?? 0) + 1;
  }

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  // rank by signal strength: strict > softfail > neutral > permissive > no-all > absent
  const rankSPF = r => {
    if (r.spf_present !== true) return 0;
    if (r.spf_mechanism === '-all') return 4;
    if (r.spf_mechanism === '~all') return 3;
    if (r.spf_mechanism === '?all') return 2;
    if (r.spf_mechanism === '+all') return 1;
    return 1; // present but no all
  };
  const ranked = [...data].sort((a, b) => rankSPF(b) - rankSPF(a));

  return {
    n, present: present.length, absent: absent.length, unknown: unknown.length,
    pctPresent: pct(present.length, n),
    mechDist,
    multipleRecords: data.filter(r => r.spf_multiple_records === true).length,
    nottingham: notts,
    topDomains: ranked.slice(0, 10).map(r => ({ domain: r.domain, mechanism: r.spf_mechanism })),
    bottomDomains: ranked.slice(-10).reverse().map(r => ({ domain: r.domain, present: r.spf_present, mechanism: r.spf_mechanism })),
    allDomains: data.map(r => ({ domain: r.domain, spf_present: r.spf_present, mechanism: r.spf_mechanism })),
  };
}

// ── DKIM ──────────────────────────────────────────────────────────────────────

async function queryDKIM(db) {
  const [domainRes, keysRes] = await Promise.all([
    db.from('signal_facts_dkim').select('domain,dkim_present,dkim_collection_status,dkim_record_count,dkim_selectors_found,dkim_selectors_probed'),
    db.from('signal_facts_dkim_keys').select('domain,selector,key_type,key_bits,public_key_present,parse_success'),
  ]);
  if (domainRes.error) throw new Error('DKIM domains: ' + domainRes.error.message);
  if (keysRes.error)   throw new Error('DKIM keys: '   + keysRes.error.message);

  const data = domainRes.data;
  const keys = keysRes.data;
  const n    = data.length;

  const exposed     = data.filter(r => r.dkim_present === true);
  const notDetected = data.filter(r => r.dkim_collection_status === 'NOT_DETECTED');
  const dnsFail     = data.filter(r => r.dkim_collection_status && r.dkim_collection_status !== 'NOT_DETECTED');

  const selFreq = {};
  for (const k of keys) { selFreq[k.selector] = (selFreq[k.selector] ?? 0) + 1; }

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;
  const nottsKeys = keys.filter(r => r.domain === TARGET_DOMAIN);

  return {
    n, exposed: exposed.length, notDetected: notDetected.length, dnsFail: dnsFail.length,
    pctExposed: pct(exposed.length, n),
    totalKeys: keys.length,
    selFreq,
    nottingham: notts,
    nottinghamKeys: nottsKeys,
    allDomains: data.map(r => ({ domain: r.domain, dkim_present: r.dkim_present, status: r.dkim_collection_status, selectors: r.dkim_selectors_found })),
  };
}

// ── DMARC ─────────────────────────────────────────────────────────────────────

async function queryDMARC(db) {
  const { data, error } = await db
    .from('signal_facts_dmarc')
    .select('domain,dmarc_present,dmarc_policy,dmarc_subdomain_policy,dmarc_rua_count,dmarc_ruf_count,dmarc_pct,dmarc_record_count,dmarc_adkim,dmarc_aspf,dmarc_records,dmarc_collection_error');
  if (error) throw new Error('DMARC: ' + error.message);

  const n = data.length;
  const present = data.filter(r => r.dmarc_present === true);
  const absent  = data.filter(r => r.dmarc_present === false);
  const unknown = data.filter(r => r.dmarc_present === null);

  const policyDist = {};
  for (const r of present) {
    const p = r.dmarc_policy ?? '(none)';
    policyDist[p] = (policyDist[p] ?? 0) + 1;
  }

  const withRUA = present.filter(r => (r.dmarc_rua_count ?? 0) > 0).length;
  const withRUF = present.filter(r => (r.dmarc_ruf_count ?? 0) > 0).length;
  const pctFull = present.filter(r => r.dmarc_pct === null || r.dmarc_pct === 100).length; // pct=100 or absent (means 100)

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  // rank: reject>quarantine>none>absent
  const rankDMARC = r => {
    if (!r.dmarc_present) return 0;
    if (r.dmarc_policy === 'reject')     return 3;
    if (r.dmarc_policy === 'quarantine') return 2;
    if (r.dmarc_policy === 'none')       return 1;
    return 0;
  };
  const ranked = [...data].sort((a, b) => rankDMARC(b) - rankDMARC(a));

  return {
    n, present: present.length, absent: absent.length, unknown: unknown.length,
    pctPresent: pct(present.length, n),
    policyDist, withRUA, withRUF, pctFull,
    pctPolicy: {
      reject:     pct(policyDist['reject'] ?? 0, n),
      quarantine: pct(policyDist['quarantine'] ?? 0, n),
      none:       pct(policyDist['none'] ?? 0, n),
    },
    nottingham: notts,
    topDomains: ranked.slice(0, 10).map(r => ({ domain: r.domain, policy: r.dmarc_policy, rua: r.dmarc_rua_count })),
    allDomains: data.map(r => ({ domain: r.domain, dmarc_present: r.dmarc_present, policy: r.dmarc_policy })),
  };
}

// ── MTA-STS ───────────────────────────────────────────────────────────────────

async function queryMTASTS(db) {
  const { data, error } = await db
    .from('signal_facts_mtasts')
    .select('domain,dns_sts_present,policy_present,policy_mode,policy_max_age,policy_mx_count,dns_collection_error,policy_fetch_error,policy_tls_valid');
  if (error) throw new Error('MTASTS: ' + error.message);

  const n = data.length;
  const dnsPresent  = data.filter(r => r.dns_sts_present === true);
  const policyPresent = data.filter(r => r.policy_present === true);
  const modeDist = {};
  for (const r of policyPresent) {
    const m = r.policy_mode ?? '(null)';
    modeDist[m] = (modeDist[m] ?? 0) + 1;
  }

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  return {
    n, dnsPresent: dnsPresent.length, policyPresent: policyPresent.length,
    pctDnsPresent: pct(dnsPresent.length, n),
    pctPolicyPresent: pct(policyPresent.length, n),
    modeDist,
    mxCounts: policyPresent.map(r => r.policy_mx_count),
    nottingham: notts,
    allDomains: data.map(r => ({ domain: r.domain, dns_sts_present: r.dns_sts_present, policy_present: r.policy_present, mode: r.policy_mode })),
  };
}

// ── TLS-RPT ───────────────────────────────────────────────────────────────────

async function queryTLSRPT(db) {
  const { data, error } = await db
    .from('signal_facts_tlsrpt')
    .select('domain,dns_tlsrpt_present,dns_collection_error,rua_count');
  if (error) throw new Error('TLSRPT: ' + error.message);

  const n = data.length;
  const present = data.filter(r => r.dns_tlsrpt_present === true);
  const absent  = data.filter(r => r.dns_tlsrpt_present === false);
  const unknown = data.filter(r => r.dns_tlsrpt_present === null);
  const notts   = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  return {
    n, present: present.length, absent: absent.length, unknown: unknown.length,
    pctPresent: pct(present.length, n),
    nottingham: notts,
    allDomains: data.map(r => ({ domain: r.domain, present: r.dns_tlsrpt_present })),
  };
}

// ── DNSSEC ───────────────────────────────────────────────────────────────────

async function queryDNSSEC(db) {
  const { data, error } = await db
    .from('signal_facts_dnssec')
    .select('domain,dns_ds_present,dns_dnskey_present,ds_record_count,dnskey_record_count,dnskey_ksk_count,dnskey_zsk_count,ds_algorithms,dnskey_algorithms,ds_collection_error,dnskey_collection_error');
  if (error) throw new Error('DNSSEC: ' + error.message);

  const n = data.length;
  const dsPresent     = data.filter(r => r.dns_ds_present === true);
  const dnsKeyPresent = data.filter(r => r.dns_dnskey_present === true);
  const bothPresent   = data.filter(r => r.dns_ds_present === true && r.dns_dnskey_present === true);
  const neitherPresent = data.filter(r => r.dns_ds_present === false && r.dns_dnskey_present === false);

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  return {
    n, dsPresent: dsPresent.length, dnsKeyPresent: dnsKeyPresent.length,
    bothPresent: bothPresent.length, neitherPresent: neitherPresent.length,
    pctDsPresent: pct(dsPresent.length, n),
    pctBothPresent: pct(bothPresent.length, n),
    nottingham: notts,
    allDomains: data.map(r => ({ domain: r.domain, ds: r.dns_ds_present, dnskey: r.dns_dnskey_present })),
  };
}

// ── CAA ──────────────────────────────────────────────────────────────────────

async function queryCAA(db) {
  const { data, error } = await db
    .from('signal_facts_caa')
    .select('domain,dns_caa_present,caa_record_count,caa_issue_count,caa_issuewild_count,caa_iodef_count,caa_critical_count,caa_tags_present,caa_issue_values,caa_issuewild_values,caa_collection_error');
  if (error) throw new Error('CAA: ' + error.message);

  const n = data.length;
  const present = data.filter(r => r.dns_caa_present === true);
  const absent  = data.filter(r => r.dns_caa_present === false);
  const unknown = data.filter(r => r.dns_caa_present === null);

  const withIssue     = present.filter(r => (r.caa_issue_count ?? 0) > 0).length;
  const withIssuewild = present.filter(r => (r.caa_issuewild_count ?? 0) > 0).length;
  const withIodef     = present.filter(r => (r.caa_iodef_count ?? 0) > 0).length;
  const withCritical  = present.filter(r => (r.caa_critical_count ?? 0) > 0).length;

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  // Count how many records the typical deployer has
  const recCounts = {};
  for (const r of present) {
    const k = r.caa_record_count ?? 0;
    recCounts[k] = (recCounts[k] ?? 0) + 1;
  }

  return {
    n, present: present.length, absent: absent.length, unknown: unknown.length,
    pctPresent: pct(present.length, n),
    withIssue, withIssuewild, withIodef, withCritical,
    recCounts,
    pctIssue:     pct(withIssue, present.length),
    pctIssuewild: pct(withIssuewild, present.length),
    pctIodef:     pct(withIodef, present.length),
    nottingham: notts,
    allDomains: data.map(r => ({ domain: r.domain, caa_present: r.dns_caa_present, record_count: r.caa_record_count })),
  };
}

// ── SECURITY TXT ──────────────────────────────────────────────────────────────

async function querySecurityTXT(db) {
  // Get latest run_id
  const { data: latest, error: latestErr } = await db
    .from('signal_securitytxt_v1')
    .select('run_id,collected_at')
    .order('collected_at', { ascending: false })
    .limit(1);
  if (latestErr) throw new Error('SecTxt run_id: ' + latestErr.message);
  const runId = latest[0].run_id;

  const { data, error } = await db
    .from('signal_securitytxt_v1')
    .select('domain,file_state,canonical_parse,legacy_parse')
    .eq('run_id', runId);
  if (error) throw new Error('SecTxt: ' + error.message);

  const n = data.length;
  const stateDist = {};
  for (const r of data) { stateDist[r.file_state] = (stateDist[r.file_state] ?? 0) + 1; }

  const presentRows = data.filter(r => r.file_state.startsWith('PRESENT'));

  // Adoption intelligence
  const withContact    = presentRows.filter(r => ((r.canonical_parse ?? r.legacy_parse)?.contact?.length ?? 0) > 0).length;
  const withExpires    = presentRows.filter(r => ((r.canonical_parse ?? r.legacy_parse)?.expires?.length ?? 0) > 0).length;
  const withPolicy     = presentRows.filter(r => ((r.canonical_parse ?? r.legacy_parse)?.policy?.length ?? 0) > 0).length;
  const withEncryption = presentRows.filter(r => ((r.canonical_parse ?? r.legacy_parse)?.encryption?.length ?? 0) > 0).length;

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  return {
    n, runId, stateDist,
    present: (stateDist['PRESENT_CANONICAL'] ?? 0) + (stateDist['PRESENT_LEGACY_ONLY'] ?? 0) + (stateDist['PRESENT_BOTH'] ?? 0),
    absent: stateDist['ABSENT'] ?? 0,
    indeterminate: stateDist['INDETERMINATE'] ?? 0,
    pctPresent: pct((stateDist['PRESENT_CANONICAL'] ?? 0) + (stateDist['PRESENT_LEGACY_ONLY'] ?? 0) + (stateDist['PRESENT_BOTH'] ?? 0), n),
    withContact, withExpires, withPolicy, withEncryption,
    nottingham: notts,
    adopters: presentRows.map(r => ({ domain: r.domain, state: r.file_state })),
    allDomains: data.map(r => ({ domain: r.domain, file_state: r.file_state })),
  };
}

// ── SECURITY HEADERS ─────────────────────────────────────────────────────────

const HEADER_KEYS = [
  'strict_transport_security', 'content_security_policy', 'x_frame_options',
  'x_content_type_options', 'referrer_policy', 'permissions_policy',
  'cross_origin_opener_policy', 'cross_origin_embedder_policy', 'cross_origin_resource_policy',
  'x_xss_protection', 'cache_control', 'pragma', 'clear_site_data',
  'content_type', 'access_control_allow_origin', 'access_control_allow_credentials',
  'access_control_allow_methods', 'access_control_allow_headers', 'access_control_expose_headers',
  'access_control_max_age', 'timing_allow_origin', 'nel', 'report_to',
  'reporting_endpoints', 'content_encoding',
];

async function querySecurityHeaders(db) {
  const { data, error } = await db
    .from('signal_securityheaders_v1')
    .select('domain,endpoint_state,header_inventory,https_fetch')
    .eq('run_id', SECHDR_RUN_ID);
  if (error) throw new Error('SecHdr: ' + error.message);

  const n = data.length;
  const observed = data.filter(r => r.endpoint_state === 'RESPONSE_OBSERVED');
  const stateDist = {};
  for (const r of data) { stateDist[r.endpoint_state] = (stateDist[r.endpoint_state] ?? 0) + 1; }

  // Header presence counts across cohort
  const headerCounts = {};
  for (const key of HEADER_KEYS) {
    headerCounts[key] = observed.filter(r => r.header_inventory?.[key]?.present === true).length;
  }

  const notts = data.find(r => r.domain === TARGET_DOMAIN) ?? null;

  // Per-domain header count (how many of 25 headers present)
  const domainHeaderCounts = data.map(r => {
    const inv = r.header_inventory ?? {};
    const count = HEADER_KEYS.filter(k => inv[k]?.present === true).length;
    return { domain: r.domain, endpoint_state: r.endpoint_state, headerCount: count, inventory: inv };
  }).sort((a, b) => b.headerCount - a.headerCount);

  const nottsHdr = domainHeaderCounts.find(r => r.domain === TARGET_DOMAIN) ?? null;

  return {
    n, runId: SECHDR_RUN_ID,
    observed: observed.length,
    stateDist,
    pctObserved: pct(observed.length, n),
    headerCounts,
    headerPct: Object.fromEntries(HEADER_KEYS.map(k => [k, pct(headerCounts[k], observed.length)])),
    nottingham: notts,
    nottinghamHeaders: nottsHdr,
    topDomains: domainHeaderCounts.slice(0, 15).map(r => ({ domain: r.domain, count: r.headerCount })),
    allDomains: domainHeaderCounts.map(r => ({ domain: r.domain, count: r.headerCount, state: r.endpoint_state })),
  };
}

// ── PEER COMPARISON ───────────────────────────────────────────────────────────

function buildPeerProfiles(spf, dkim, dmarc, mtasts, tlsrpt, dnssec, caa, sectxt, sechdr) {
  const domains = new Set([
    ...spf.allDomains.map(r => r.domain),
  ]);

  const profiles = {};
  for (const d of domains) {
    profiles[d] = {
      spf:     spf.allDomains.find(r => r.domain === d),
      dkim:    dkim.allDomains.find(r => r.domain === d),
      dmarc:   dmarc.allDomains.find(r => r.domain === d),
      mtasts:  mtasts.allDomains.find(r => r.domain === d),
      tlsrpt:  tlsrpt.allDomains.find(r => r.domain === d),
      dnssec:  dnssec.allDomains.find(r => r.domain === d),
      caa:     caa.allDomains.find(r => r.domain === d),
      sectxt:  sectxt.allDomains.find(r => r.domain === d),
      sechdr:  sechdr.allDomains.find(r => r.domain === d),
    };
  }

  // Score each domain on a 9-signal basis (for comparison only — not for output as scores)
  // Using a simple active-signal count for peer grouping
  function signalActive(profile) {
    let count = 0;
    if (profile.spf?.spf_present === true) count++;
    if (profile.dkim?.dkim_present === true) count++;
    if (profile.dmarc?.dmarc_present === true) count++;
    if (profile.mtasts?.policy_present === true) count++;
    if (profile.tlsrpt?.present === true) count++;
    if (profile.dnssec?.ds === true) count++;
    if (profile.caa?.caa_present === true) count++;
    if (profile.sectxt?.file_state?.startsWith('PRESENT')) count++;
    if (profile.sechdr?.state === 'RESPONSE_OBSERVED') count++;
    return count;
  }

  // DMARC policy tier for comparison
  function dmarcTier(profile) {
    const p = profile.dmarc?.policy;
    if (p === 'reject') return 3;
    if (p === 'quarantine') return 2;
    if (p === 'none') return 1;
    return 0;
  }

  // Header count for comparison
  function headerCount(profile) {
    return profile.sechdr?.count ?? 0;
  }

  const ranked = Object.entries(profiles).map(([domain, p]) => ({
    domain,
    activeSignals: signalActive(p),
    dmarcTier: dmarcTier(p),
    headerCount: headerCount(p),
    profile: p,
  })).sort((a, b) => b.activeSignals - a.activeSignals || b.dmarcTier - a.dmarcTier || b.headerCount - a.headerCount);

  const nottsIdx = ranked.findIndex(r => r.domain === TARGET_DOMAIN);
  const notts    = ranked[nottsIdx];

  // Similar: same activeSignals ± 0, same DMARC tier
  const similar = ranked.filter(r =>
    r.domain !== TARGET_DOMAIN &&
    r.activeSignals === notts?.activeSignals &&
    r.dmarcTier === notts?.dmarcTier,
  ).slice(0, 10);

  // Stronger: more activeSignals or same count + higher DMARC or more headers
  const stronger = ranked.filter(r =>
    r.domain !== TARGET_DOMAIN &&
    (r.activeSignals > notts?.activeSignals ||
     (r.activeSignals === notts?.activeSignals && r.dmarcTier > notts?.dmarcTier) ||
     (r.activeSignals === notts?.activeSignals && r.dmarcTier === notts?.dmarcTier && r.headerCount > notts?.headerCount))
  ).slice(0, 15);

  // Weaker: fewer active signals
  const weaker = ranked.filter(r =>
    r.domain !== TARGET_DOMAIN &&
    r.activeSignals < notts?.activeSignals,
  ).slice(-15);

  return {
    allRanked: ranked,
    nottinghamRank: nottsIdx + 1,
    nottinghamTotal: ranked.length,
    nottinghamActiveSignals: notts?.activeSignals,
    nottinghamDmarcTier: notts?.dmarcTier,
    nottinghamHeaderCount: notts?.headerCount,
    similar: similar.map(r => ({ domain: r.domain, activeSignals: r.activeSignals, dmarcTier: r.dmarcTier, headerCount: r.headerCount })),
    stronger: stronger.map(r => ({ domain: r.domain, activeSignals: r.activeSignals, dmarcTier: r.dmarcTier, headerCount: r.headerCount })),
    weaker: weaker.map(r => ({ domain: r.domain, activeSignals: r.activeSignals, dmarcTier: r.dmarcTier, headerCount: r.headerCount })),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = getClient();

  process.stderr.write('Querying all 9 signals...\n');

  const [spf, dkim, dmarc, mtasts, tlsrpt, dnssec, caa, sectxt, sechdr] = await Promise.all([
    querySPF(db),
    queryDKIM(db),
    queryDMARC(db),
    queryMTASTS(db),
    queryTLSRPT(db),
    queryDNSSEC(db),
    queryCAA(db),
    querySecurityTXT(db),
    querySecurityHeaders(db),
  ]);

  process.stderr.write('Building peer profiles...\n');
  const peers = buildPeerProfiles(spf, dkim, dmarc, mtasts, tlsrpt, dnssec, caa, sectxt, sechdr);

  const output = { spf, dkim, dmarc, mtasts, tlsrpt, dnssec, caa, sectxt, sechdr, peers };

  // Remove allDomains arrays from output to keep JSON manageable; keep key fields
  // Actually keep them — we need them for the document
  process.stdout.write(JSON.stringify(output, null, 2));
  process.stderr.write('\nDone.\n');
}

main().catch(e => {
  process.stderr.write('\nFatal: ' + e.message + '\n');
  process.exit(1);
});
