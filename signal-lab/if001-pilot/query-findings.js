'use strict';

// IF-001-PILOT — Findings Query
//
// Queries all 9 Signal Lab tables for the IF-001-PILOT 100-firm cohort.
// Outputs a single JSON object to stdout for use in generating the findings document.
//
// v0 signals: filtered by domain IN (pilot domains) — no overlap with HE-001 (.ac.uk domains)
// v1 signals: filtered by run_id
//
// Usage:
//   node backend/signal-lab/if001-pilot/query-findings.js > backend/signal-lab/if001-pilot/findings-raw.json

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const fs   = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');

const SECTXT_RUN_ID  = '816ff0fb-2a6f-4b8a-8c6d-9f52d4ba3bc6';
const SECHDR_RUN_ID  = '5f71f930-64bb-4a41-969f-b2ed76f8f8bf';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

async function fetchAll(supabase, table, filter) {
  // filter is a function that takes a query builder and returns it
  const { data, error } = await filter(supabase.from(table).select('*'));
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const domains   = manifest.firms.map(f => f.domain);
  const db        = getClient();

  // ── Query all 9 tables ────────────────────────────────────────────────────

  const [spf, dkim, dkimKeys, dmarc, mtasts, tlsrpt, dnssec, caa, sectxt, sechdr] =
    await Promise.all([
      fetchAll(db, 'signal_facts_spf',     q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_dkim',    q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_dkim_keys', q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_dmarc',   q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_mtasts',  q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_tlsrpt',  q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_dnssec',  q => q.in('domain', domains)),
      fetchAll(db, 'signal_facts_caa',     q => q.in('domain', domains)),
      fetchAll(db, 'signal_securitytxt_v1',    q => q.eq('run_id', SECTXT_RUN_ID)),
      fetchAll(db, 'signal_securityheaders_v1', q => q.eq('run_id', SECHDR_RUN_ID)),
    ]);

  // ── SPF analysis ──────────────────────────────────────────────────────────

  const spfPresent   = spf.filter(r => r.spf_present === true);
  const spfAbsent    = spf.filter(r => r.spf_present === false);
  const spfUnknown   = spf.filter(r => r.spf_present === null);
  const mechDist     = {};
  const lookupDist   = {};
  const includeDist  = {};
  const spfOutliers  = { highLookup: [], multiRecord: [], parseFail: [] };

  for (const r of spfPresent) {
    const m = r.spf_mechanism ?? 'null';
    mechDist[m] = (mechDist[m] ?? 0) + 1;
    const lk = r.spf_lookup_count ?? 0;
    lookupDist[lk] = (lookupDist[lk] ?? 0) + 1;
    const ic = r.spf_include_count ?? 0;
    includeDist[ic] = (includeDist[ic] ?? 0) + 1;
    if (lk > 10) spfOutliers.highLookup.push({ domain: r.domain, lookup_count: lk });
  }
  for (const r of spf) {
    if ((r.spf_record_count ?? 0) > 1) spfOutliers.multiRecord.push({ domain: r.domain, count: r.spf_record_count });
    if (r.spf_parse_success === false) spfOutliers.parseFail.push({ domain: r.domain });
  }

  const spfData = {
    total: spf.length,
    present: spfPresent.length,
    absent: spfAbsent.length,
    unknown: spfUnknown.length,
    mechDist,
    lookupDist,
    includeDist,
    outliers: spfOutliers,
    // top records for outlier section
    topLookup: [...spfPresent].sort((a, b) => (b.spf_lookup_count ?? 0) - (a.spf_lookup_count ?? 0)).slice(0, 5).map(r => ({ domain: r.domain, lookup_count: r.spf_lookup_count, mechanism: r.spf_mechanism })),
    noSpf: spfAbsent.map(r => r.domain),
  };

  // ── DKIM analysis ─────────────────────────────────────────────────────────

  const dkimPresent = dkim.filter(r => r.dkim_present === true);
  const keyTypeDist = {};
  const keyBitsDist = {};
  const selectorCountPerDomain = dkimPresent.map(r => ({
    domain: r.domain,
    selectorCount: r.dkim_selectors_found?.length ?? 0,
    selectors: r.dkim_selectors_found ?? [],
  }));
  const selectorCountDist = {};
  for (const d of selectorCountPerDomain) {
    const k = d.selectorCount;
    selectorCountDist[k] = (selectorCountDist[k] ?? 0) + 1;
  }

  for (const key of dkimKeys) {
    const t = key.key_type ?? 'unknown';
    keyTypeDist[t] = (keyTypeDist[t] ?? 0) + 1;
    if (key.key_bits !== null) {
      const b = String(key.key_bits);
      keyBitsDist[b] = (keyBitsDist[b] ?? 0) + 1;
    }
  }

  // Selector frequency across cohort
  const selectorFreq = {};
  for (const key of dkimKeys) {
    const s = key.selector ?? 'unknown';
    selectorFreq[s] = (selectorFreq[s] ?? 0) + 1;
  }

  const dkimData = {
    total: dkim.length,
    present: dkimPresent.length,
    notDetected: dkim.filter(r => r.dkim_collection_status === 'NOT_DETECTED').length,
    dnsErrors: dkim.filter(r => r.dkim_present !== true && r.dkim_collection_status !== 'NOT_DETECTED').length,
    totalKeysDiscovered: dkimKeys.length,
    keyTypeDist,
    keyBitsDist,
    selectorCountDist,
    topSelectorCounts: [...selectorCountPerDomain].sort((a, b) => b.selectorCount - a.selectorCount).slice(0, 10),
    selectorFreq: Object.fromEntries(Object.entries(selectorFreq).sort((a, b) => b[1] - a[1]).slice(0, 20)),
    noDkim: dkim.filter(r => r.dkim_present !== true).map(r => r.domain),
  };

  // ── DMARC analysis ────────────────────────────────────────────────────────

  const dmarcPresent = dmarc.filter(r => r.dmarc_present === true);
  const policyDist   = {};
  const spDist       = {};
  const ruaCountDist = {};
  const rufCountDist = {};

  for (const r of dmarcPresent) {
    const p = r.dmarc_policy ?? 'null';
    policyDist[p] = (policyDist[p] ?? 0) + 1;
    const sp = r.dmarc_subdomain_policy ?? 'absent';
    spDist[sp] = (spDist[sp] ?? 0) + 1;
    const rc = r.dmarc_rua_count ?? 0;
    ruaCountDist[rc] = (ruaCountDist[rc] ?? 0) + 1;
    const rfc = r.dmarc_ruf_count ?? 0;
    rufCountDist[rfc] = (rufCountDist[rfc] ?? 0) + 1;
  }

  const dmarcData = {
    total: dmarc.length,
    present: dmarcPresent.length,
    absent: dmarc.filter(r => r.dmarc_present === false).length,
    unknown: dmarc.filter(r => r.dmarc_present === null).length,
    policyDist,
    spDist,
    ruaCountDist,
    rufCountDist,
    nonePolicy:       dmarcPresent.filter(r => r.dmarc_policy === 'none').map(r => r.domain),
    rejectPolicy:     dmarcPresent.filter(r => r.dmarc_policy === 'reject').map(r => r.domain),
    quarPolicy:       dmarcPresent.filter(r => r.dmarc_policy === 'quarantine').map(r => r.domain),
    noDmarc:          dmarc.filter(r => r.dmarc_present !== true).map(r => r.domain),
    withRua:          dmarcPresent.filter(r => (r.dmarc_rua_count ?? 0) > 0).length,
    withRuf:          dmarcPresent.filter(r => (r.dmarc_ruf_count ?? 0) > 0).length,
    pctDistribution:  (() => {
      const d = {};
      for (const r of dmarcPresent) {
        const p = r.dmarc_pct === null ? 'absent' : String(r.dmarc_pct);
        d[p] = (d[p] ?? 0) + 1;
      }
      return d;
    })(),
  };

  // ── MTA-STS analysis ──────────────────────────────────────────────────────

  const stsPresent = mtasts.filter(r => r.dns_sts_present === true);
  const modeDist   = {};
  for (const r of stsPresent) {
    if (r.policy_present === true) {
      const m = r.policy_mode ?? 'null';
      modeDist[m] = (modeDist[m] ?? 0) + 1;
    }
  }

  const mtastsData = {
    total: mtasts.length,
    dnsPresent: stsPresent.length,
    dnsAbsent:  mtasts.filter(r => r.dns_sts_present === false).length,
    dnsUnknown: mtasts.filter(r => r.dns_sts_present === null).length,
    policyPresent: stsPresent.filter(r => r.policy_present === true).length,
    policyAbsent:  stsPresent.filter(r => r.policy_present === false).length,
    modeDist,
    tlsInvalid: stsPresent.filter(r => r.policy_tls_valid === false).length,
    adopters: stsPresent.filter(r => r.policy_present === true).map(r => ({ domain: r.domain, mode: r.policy_mode })),
  };

  // ── TLS-RPT analysis ──────────────────────────────────────────────────────

  const tlsPresent = tlsrpt.filter(r => r.dns_tlsrpt_present === true);
  const ruaSchemes = { mailto: 0, https: 0, unknown: 0 };
  for (const r of tlsPresent) {
    ruaSchemes.mailto  += r.rua_mailto_count ?? 0;
    ruaSchemes.https   += r.rua_https_count  ?? 0;
    ruaSchemes.unknown += r.rua_unknown_scheme_count ?? 0;
  }

  const tlsrptData = {
    total: tlsrpt.length,
    present: tlsPresent.length,
    absent:  tlsrpt.filter(r => r.dns_tlsrpt_present === false).length,
    unknown: tlsrpt.filter(r => r.dns_tlsrpt_present === null).length,
    ruaSchemes,
    adopters: tlsPresent.map(r => r.domain),
  };

  // ── DNSSEC analysis ───────────────────────────────────────────────────────

  const dsPresent  = dnssec.filter(r => r.dns_ds_present === true);
  const dkPresent  = dnssec.filter(r => r.dns_dnskey_present === true);
  const algDist    = {};
  for (const r of dsPresent) {
    for (const a of r.ds_algorithms ?? []) {
      algDist[a] = (algDist[a] ?? 0) + 1;
    }
  }

  const dnssecData = {
    total: dnssec.length,
    dsPresent:   dsPresent.length,
    dsAbsent:    dnssec.filter(r => r.dns_ds_present === false).length,
    dsUnknown:   dnssec.filter(r => r.dns_ds_present === null).length,
    dkPresent:   dkPresent.length,
    bothPresent: dnssec.filter(r => r.dns_ds_present === true && r.dns_dnskey_present === true).length,
    algDist,
    adopters: dsPresent.map(r => ({ domain: r.domain, algorithms: r.ds_algorithms })),
  };

  // ── CAA analysis ──────────────────────────────────────────────────────────

  const caaPresent  = caa.filter(r => r.dns_caa_present === true);
  const issueValues = {};
  let caaWithIssue    = 0;
  let caaWithWild     = 0;
  let caaWithIodef    = 0;

  for (const r of caaPresent) {
    if ((r.caa_issue_count ?? 0) > 0) {
      caaWithIssue++;
      for (const v of r.caa_issue_values ?? []) {
        const norm = v.toLowerCase().trim();
        issueValues[norm] = (issueValues[norm] ?? 0) + 1;
      }
    }
    if ((r.caa_issuewild_count ?? 0) > 0) caaWithWild++;
    if ((r.caa_iodef_count    ?? 0) > 0) caaWithIodef++;
  }

  const caaData = {
    total: caa.length,
    present: caaPresent.length,
    absent:  caa.filter(r => r.dns_caa_present === false).length,
    unknown: caa.filter(r => r.dns_caa_present === null).length,
    caaWithIssue,
    caaWithWild,
    caaWithIodef,
    issueValues: Object.fromEntries(Object.entries(issueValues).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    adopters: caaPresent.map(r => r.domain),
  };

  // ── SecurityTXT analysis ──────────────────────────────────────────────────

  const sectxtPresent = sectxt.filter(r =>
    r.file_state === 'PRESENT_CANONICAL' ||
    r.file_state === 'PRESENT_LEGACY_ONLY' ||
    r.file_state === 'PRESENT_BOTH'
  );
  const fileStateDist = {};
  for (const r of sectxt) {
    fileStateDist[r.file_state] = (fileStateDist[r.file_state] ?? 0) + 1;
  }

  const parseOf = r => r.canonical_parse ?? r.legacy_parse ?? null;
  const arrPresent = (parse, field) => {
    if (!parse) return false;
    const v = parse[field];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  };

  const fieldCounts = { contact: 0, expires: 0, encryption: 0, acknowledgments: 0, policy: 0, preferred_languages: 0, hiring: 0, canonical: 0 };
  const fieldCountPerDomain = [];

  for (const r of sectxtPresent) {
    const p = parseOf(r);
    let count = 0;
    for (const field of Object.keys(fieldCounts)) {
      if (arrPresent(p, field)) { fieldCounts[field]++; count++; }
    }
    fieldCountPerDomain.push({ domain: r.domain, fieldCount: count, fileState: r.file_state });
  }

  const sectxtData = {
    total: sectxt.length,
    present: sectxtPresent.length,
    absent:  sectxt.filter(r => r.file_state === 'ABSENT').length,
    indeterminate: sectxt.filter(r => r.file_state === 'INDETERMINATE').length,
    fileStateDist,
    fieldCounts,
    fieldCountPerDomain,
    richest: [...fieldCountPerDomain].sort((a, b) => b.fieldCount - a.fieldCount).slice(0, 5),
    adopters: sectxtPresent.map(r => r.domain),
  };

  // ── SecurityHeaders analysis ──────────────────────────────────────────────

  const HEADER_FIELDS = [
    'strict_transport_security', 'content_security_policy', 'content_security_policy_report_only',
    'x_frame_options', 'x_content_type_options', 'referrer_policy', 'permissions_policy',
    'feature_policy', 'cross_origin_opener_policy', 'cross_origin_opener_policy_report_only',
    'cross_origin_embedder_policy', 'cross_origin_embedder_policy_report_only',
    'cross_origin_resource_policy', 'reporting_endpoints', 'report_to', 'nel',
    'origin_agent_cluster', 'x_xss_protection', 'expect_ct', 'public_key_pins',
    'public_key_pins_report_only', 'server', 'x_powered_by', 'x_aspnet_version', 'x_aspnetmvc_version',
  ];

  const observed = sechdr.filter(r => r.endpoint_state === 'RESPONSE_OBSERVED');
  const endpointDist = {};
  for (const r of sechdr) {
    endpointDist[r.endpoint_state] = (endpointDist[r.endpoint_state] ?? 0) + 1;
  }

  const headerPresence = {};
  for (const f of HEADER_FIELDS) {
    headerPresence[f] = observed.filter(r => r.header_inventory?.[f]?.present).length;
  }

  const headerCountPerDomain = observed.map(r => {
    const inv = r.header_inventory ?? {};
    const secCount = Object.entries(inv).filter(([k, v]) => v.present && !['server','x_powered_by','x_aspnet_version','x_aspnetmvc_version'].includes(k)).length;
    const allCount = Object.values(inv).filter(v => v.present).length;
    return { domain: r.domain, secCount, allCount };
  });

  const headerCountDist = {};
  for (const d of headerCountPerDomain) {
    const k = d.secCount;
    headerCountDist[k] = (headerCountDist[k] ?? 0) + 1;
  }

  const sechdrData = {
    total: sechdr.length,
    responseObserved: observed.length,
    endpointDist,
    headerPresence,
    headerCountDist,
    headerCountValues: headerCountPerDomain.map(d => d.secCount),
    topHeaders: [...headerCountPerDomain].sort((a, b) => b.secCount - a.secCount).slice(0, 10),
    bottomHeaders: [...headerCountPerDomain].sort((a, b) => a.secCount - b.secCount).slice(0, 10),
    zeroHeaders: headerCountPerDomain.filter(d => d.secCount === 0).map(d => d.domain),
    serverDisclosure: observed.filter(r => r.header_inventory?.server?.present).length,
    xpbDisclosure: observed.filter(r => r.header_inventory?.x_powered_by?.present).length,
    hstsStats: (() => {
      const hstsPresent = observed.filter(r => r.header_inventory?.strict_transport_security?.present);
      const maxAges = [];
      for (const r of hstsPresent) {
        const val = r.header_inventory.strict_transport_security.values?.[0] ?? '';
        const m = val.match(/max-age\s*=\s*(\d+)/i);
        if (m) maxAges.push(Number(m[1]));
      }
      maxAges.sort((a, b) => a - b);
      return { count: hstsPresent.length, maxAgeMedian: maxAges[Math.floor(maxAges.length / 2)] ?? null };
    })(),
  };

  // ── Output ────────────────────────────────────────────────────────────────

  const output = {
    meta: {
      cohort_id:    manifest.cohort_id,
      selection_id: manifest.selection_id,
      n:            manifest.n,
      domains,
      firms:        manifest.firms,
    },
    spf:     spfData,
    dkim:    dkimData,
    dmarc:   dmarcData,
    mtasts:  mtastsData,
    tlsrpt:  tlsrptData,
    dnssec:  dnssecData,
    caa:     caaData,
    sectxt:  sectxtData,
    sechdr:  sechdrData,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write('Fatal: ' + e.message + '\n');
  process.exit(1);
});
