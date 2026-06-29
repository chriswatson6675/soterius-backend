'use strict';

// HE-001 Signal Benchmark Atlas Query
// Pulls distribution data needed for quartile/decile/percentile analysis.
// Output: JSON to stdout.

require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const TARGET = 'nottingham.ac.uk';
const SECHDR_RUN_ID = '28e7259c-aea0-4af4-9841-75acbd56af45';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function pctile(sorted, value) {
  // Rank of value in sorted ascending array (0-indexed), returns percentile (0-100)
  const rank = sorted.filter(v => v < value).length;
  return Math.round((rank / sorted.length) * 100);
}

function quartile(sorted, value) {
  const p = pctile(sorted, value);
  if (p < 25) return 'Q1';
  if (p < 50) return 'Q2';
  if (p < 75) return 'Q3';
  return 'Q4';
}

function decile(sorted, value) {
  const p = pctile(sorted, value);
  return Math.ceil((p + 1) / 10) || 1;
}

function quantiles(sorted) {
  const n = sorted.length;
  const at = (p) => {
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    min: sorted[0], p10: at(10), p25: at(25), p50: at(50),
    p75: at(75), p90: at(90), max: sorted[n - 1], n,
  };
}

async function main() {
  const db = getClient();

  // ── SPF ─────────────────────────────────────────────────────────────────────
  const { data: spfData, error: spfErr } = await db
    .from('signal_facts_spf')
    .select('domain,spf_present,spf_mechanism,spf_lookup_count,spf_include_count');
  if (spfErr) throw new Error('SPF: ' + spfErr.message);

  const spfPresent = spfData.filter(r => r.spf_present === true);
  const spfLookups = spfPresent.map(r => r.spf_lookup_count ?? 0).sort((a, b) => a - b);
  const spfIncludes = spfPresent.map(r => r.spf_include_count ?? 0).sort((a, b) => a - b);
  const nottsSpf = spfData.find(r => r.domain === TARGET);

  const spfRank = [...spfData].sort((a, b) => {
    const tier = r => {
      if (!r.spf_present) return 0;
      if (r.spf_mechanism === '-all') return 4;
      if (r.spf_mechanism === '~all') return 3;
      if (r.spf_mechanism === '?all') return 2;
      return 1;
    };
    return tier(b) - tier(a);
  });

  const spf = {
    lookupQuantiles: quantiles(spfLookups),
    includeQuantiles: quantiles(spfIncludes),
    nottingham: {
      lookup_count: nottsSpf?.spf_lookup_count,
      include_count: nottsSpf?.spf_include_count,
      mechanism: nottsSpf?.spf_mechanism,
      lookup_pctile: pctile(spfLookups, nottsSpf?.spf_lookup_count ?? 0),
      lookup_quartile: quartile(spfLookups, nottsSpf?.spf_lookup_count ?? 0),
      include_pctile: pctile(spfIncludes, nottsSpf?.spf_include_count ?? 0),
      include_quartile: quartile(spfIncludes, nottsSpf?.spf_include_count ?? 0),
    },
    allPresent: spfPresent.map(r => ({
      domain: r.domain,
      mechanism: r.spf_mechanism,
      lookups: r.spf_lookup_count,
      includes: r.spf_include_count,
    })).sort((a, b) => (b.lookups ?? 0) - (a.lookups ?? 0)),
    mechDomains: {},
  };
  for (const r of spfPresent) {
    const m = r.spf_mechanism ?? '(none)';
    if (!spf.mechDomains[m]) spf.mechDomains[m] = [];
    spf.mechDomains[m].push(r.domain);
  }

  // ── DKIM ────────────────────────────────────────────────────────────────────
  const [{ data: dkimData, error: dkimErr }, { data: dkimKeys, error: dkimKeysErr }] = await Promise.all([
    db.from('signal_facts_dkim').select('domain,dkim_present,dkim_collection_status,dkim_selectors_found'),
    db.from('signal_facts_dkim_keys').select('domain,selector,key_type,key_bits,public_key_present'),
  ]);
  if (dkimErr) throw new Error('DKIM: ' + dkimErr.message);
  if (dkimKeysErr) throw new Error('DKIM keys: ' + dkimKeysErr.message);

  // selector count per domain
  const dkimSelCount = {};
  for (const k of dkimKeys) {
    dkimSelCount[k.domain] = (dkimSelCount[k.domain] ?? 0) + 1;
  }

  // key_bits distribution
  const bitsDist = {};
  for (const k of dkimKeys) {
    const b = String(k.key_bits ?? 'unknown');
    bitsDist[b] = (bitsDist[b] ?? 0) + 1;
  }

  // selector count for all institutions (including 0 for those with no keys)
  const allSelCounts = dkimData.map(r => dkimSelCount[r.domain] ?? 0).sort((a, b) => a - b);
  const exposedSelCounts = dkimData
    .filter(r => r.dkim_present === true)
    .map(r => dkimSelCount[r.domain] ?? 1)
    .sort((a, b) => a - b);

  const nottsSelCount = dkimSelCount[TARGET] ?? 0;
  const nottsKeyBits = dkimKeys.filter(k => k.domain === TARGET).map(k => k.key_bits);

  const selByDomain = dkimData.map(r => ({
    domain: r.domain,
    selCount: dkimSelCount[r.domain] ?? 0,
    dkim_present: r.dkim_present,
  })).sort((a, b) => b.selCount - a.selCount);

  const dkim = {
    allSelCountsQuantiles: quantiles(allSelCounts),
    exposedSelCountsQuantiles: quantiles(exposedSelCounts),
    bitsDist,
    nottingham: {
      sel_count: nottsSelCount,
      key_bits: nottsKeyBits,
      sel_pctile_all: pctile(allSelCounts, nottsSelCount),
      sel_quartile_all: quartile(allSelCounts, nottsSelCount),
      sel_pctile_exposed: pctile(exposedSelCounts, nottsSelCount),
      sel_quartile_exposed: quartile(exposedSelCounts, nottsSelCount),
    },
    top10: selByDomain.slice(0, 10),
    bottom10: selByDomain.slice(-10).reverse(),
    allDomains: selByDomain,
  };

  // ── DMARC ───────────────────────────────────────────────────────────────────
  const { data: dmarcData, error: dmarcErr } = await db
    .from('signal_facts_dmarc')
    .select('domain,dmarc_present,dmarc_policy,dmarc_subdomain_policy,dmarc_rua_count,dmarc_pct,dmarc_aspf,dmarc_adkim');
  if (dmarcErr) throw new Error('DMARC: ' + dmarcErr.message);

  const tierOf = r => {
    if (!r.dmarc_present) return 0;
    if (r.dmarc_policy === 'reject') return 3;
    if (r.dmarc_policy === 'quarantine') return 2;
    if (r.dmarc_policy === 'none') return 1;
    return 0;
  };
  const dmarcTiers = dmarcData.map(tierOf).sort((a, b) => a - b);
  const dmarcRuaCounts = dmarcData
    .filter(r => r.dmarc_present)
    .map(r => r.dmarc_rua_count ?? 0)
    .sort((a, b) => a - b);
  const dmarcPcts = dmarcData
    .filter(r => r.dmarc_present)
    .map(r => r.dmarc_pct ?? 0)
    .sort((a, b) => a - b);

  const nottsDmarc = dmarcData.find(r => r.domain === TARGET);
  const nottsDmarcTier = tierOf(nottsDmarc ?? {});

  const dmarcByTier = dmarcData.map(r => ({
    domain: r.domain, policy: r.dmarc_policy, tier: tierOf(r),
    rua_count: r.dmarc_rua_count, pct: r.dmarc_pct, sp: r.dmarc_subdomain_policy,
  })).sort((a, b) => b.tier - a.tier || (b.rua_count ?? 0) - (a.rua_count ?? 0));

  // tier label counts
  const tierCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const r of dmarcData) tierCounts[tierOf(r)]++;

  const dmarc = {
    tierQuantiles: quantiles(dmarcTiers),
    ruaQuantiles: quantiles(dmarcRuaCounts),
    pctQuantiles: quantiles(dmarcPcts),
    tierCounts,
    nottingham: {
      policy: nottsDmarc?.dmarc_policy,
      tier: nottsDmarcTier,
      rua_count: nottsDmarc?.dmarc_rua_count,
      pct: nottsDmarc?.dmarc_pct,
      sp: nottsDmarc?.dmarc_subdomain_policy,
      tier_pctile: pctile(dmarcTiers, nottsDmarcTier),
      tier_quartile: quartile(dmarcTiers, nottsDmarcTier),
      rua_pctile: pctile(dmarcRuaCounts, nottsDmarc?.dmarc_rua_count ?? 0),
    },
    top10: dmarcByTier.slice(0, 10),
    bottom10: dmarcByTier.filter(r => r.tier === 0).slice(0, 10),
    allDomains: dmarcByTier,
  };

  // ── MTA-STS ─────────────────────────────────────────────────────────────────
  const { data: mtastsData, error: mtastsErr } = await db
    .from('signal_facts_mtasts')
    .select('domain,dns_sts_present,policy_present,policy_fetch_error,policy_mode,policy_mx_count,policy_max_age');
  if (mtastsErr) throw new Error('MTASTS: ' + mtastsErr.message);

  const mtastsNotts = mtastsData.find(r => r.domain === TARGET);
  const mtastsEnforce = mtastsData.filter(r => r.policy_mode === 'enforce');
  const mtastsTesting = mtastsData.filter(r => r.policy_mode === 'testing');
  const mtastsNone = mtastsData.filter(r => r.policy_mode === 'none');
  const mtastsAbsent = mtastsData.filter(r => !r.dns_sts_present);
  const mtastsMaxAge = mtastsData
    .filter(r => r.policy_max_age != null)
    .map(r => r.policy_max_age)
    .sort((a, b) => a - b);

  const mtasts = {
    modes: { enforce: mtastsEnforce.length, testing: mtastsTesting.length, none: mtastsNone.length, absent: mtastsAbsent.length },
    maxAgeQuantiles: mtastsMaxAge.length ? quantiles(mtastsMaxAge) : null,
    enforceDomains: mtastsEnforce.map(r => ({ domain: r.domain, max_age: r.policy_max_age, mx_count: r.policy_mx_count })),
    testingDomains: mtastsTesting.map(r => ({ domain: r.domain, max_age: r.policy_max_age })),
    nottingham: {
      dns_present: mtastsNotts?.dns_sts_present,
      mode: mtastsNotts?.policy_mode,
      fetch_error: mtastsNotts?.policy_fetch_error,
    },
  };

  // ── DNSSEC ──────────────────────────────────────────────────────────────────
  const { data: dnssecData, error: dnssecErr } = await db
    .from('signal_facts_dnssec')
    .select('domain,dns_ds_present,dns_dnskey_present,ds_algorithms');
  if (dnssecErr) throw new Error('DNSSEC: ' + dnssecErr.message);

  const dnssecDeployed = dnssecData.filter(r => r.dns_ds_present === true);
  const algDist = {};
  for (const r of dnssecData) {
    for (const alg of (r.ds_algorithms ?? [])) {
      algDist[String(alg)] = (algDist[String(alg)] ?? 0) + 1;
    }
  }
  const nottsDnssec = dnssecData.find(r => r.domain === TARGET);

  const dnssec = {
    deployed: dnssecDeployed.length,
    total: dnssecData.length,
    algDist,
    deployedDomains: dnssecDeployed.map(r => ({
      domain: r.domain, ds_algs: r.ds_algorithms,
    })),
    nottingham: {
      ds: nottsDnssec?.dns_ds_present,
      dnskey: nottsDnssec?.dns_dnskey_present,
    },
  };

  // ── CAA ─────────────────────────────────────────────────────────────────────
  // De-duplicate by taking latest per domain (table has 3 runs)
  const { data: caaRaw, error: caaErr } = await db
    .from('signal_facts_caa')
    .select('domain,dns_caa_present,caa_record_count,caa_issue_count,caa_issuewild_count,caa_iodef_count,collected_at')
    .order('collected_at', { ascending: false });
  if (caaErr) throw new Error('CAA: ' + caaErr.message);

  // De-duplicate: keep first (most recent) per domain
  const caaByDomain = {};
  for (const r of caaRaw) {
    if (!caaByDomain[r.domain]) caaByDomain[r.domain] = r;
  }
  const caaData = Object.values(caaByDomain);
  const caaPresent = caaData.filter(r => r.dns_caa_present === true);
  const caaRecordCounts = caaPresent.map(r => r.caa_record_count ?? 0).sort((a, b) => a - b);
  const nottsCaa = caaByDomain[TARGET];

  const caa = {
    total: caaData.length,
    present: caaPresent.length,
    pctPresent: Math.round(caaPresent.length / caaData.length * 1000) / 10,
    recordCountQuantiles: caaRecordCounts.length ? quantiles(caaRecordCounts) : null,
    withIssue: caaPresent.filter(r => (r.caa_issue_count ?? 0) > 0).length,
    withIssuewild: caaPresent.filter(r => (r.caa_issuewild_count ?? 0) > 0).length,
    withIodef: caaPresent.filter(r => (r.caa_iodef_count ?? 0) > 0).length,
    topDomains: caaPresent
      .sort((a, b) => (b.caa_record_count ?? 0) - (a.caa_record_count ?? 0))
      .slice(0, 10)
      .map(r => ({ domain: r.domain, records: r.caa_record_count, issue: r.caa_issue_count, issuewild: r.caa_issuewild_count, iodef: r.caa_iodef_count })),
    nottingham: { present: nottsCaa?.dns_caa_present, records: nottsCaa?.caa_record_count },
  };

  // ── SECURITY.TXT ────────────────────────────────────────────────────────────
  // Get latest run_id for security.txt
  const { data: sectxtRuns } = await db
    .from('signal_securitytxt_v1')
    .select('run_id,collected_at')
    .order('collected_at', { ascending: false })
    .limit(1);
  const sectxtRunId = sectxtRuns?.[0]?.run_id;

  const { data: sectxtData, error: sectxtErr } = await db
    .from('signal_securitytxt_v1')
    .select('domain,file_state,canonical_parse,legacy_parse')
    .eq('run_id', sectxtRunId);
  if (sectxtErr) throw new Error('SECTXT: ' + sectxtErr.message);

  // extract field presence from JSONB parse blocks
  const parseOf = r => r.canonical_parse ?? r.legacy_parse ?? null;
  const arrPresent = (parse, field) => {
    if (!parse) return false;
    const arr = parse[field];
    return Array.isArray(arr) ? arr.length > 0 : Boolean(arr);
  };
  const fieldCount = r => {
    const p = parseOf(r);
    return ['contact','expires','encryption','acknowledgments','policy','preferred_languages','canonical','hiring']
      .filter(f => arrPresent(p, f)).length;
  };

  const sectxtPresent = sectxtData.filter(r => r.file_state?.startsWith('PRESENT'));

  const sectxtFieldCounts = sectxtPresent.map(fieldCount).sort((a, b) => a - b);
  const nottsSectxt = sectxtData.find(r => r.domain === TARGET);

  const sectxt = {
    total: sectxtData.length,
    present: sectxtPresent.length,
    stateDist: {},
    fieldCountQuantiles: sectxtFieldCounts.length ? quantiles(sectxtFieldCounts) : null,
    fieldAdoption: {
      contact: sectxtPresent.filter(r => arrPresent(parseOf(r), 'contact')).length,
      expires: sectxtPresent.filter(r => arrPresent(parseOf(r), 'expires')).length,
      policy: sectxtPresent.filter(r => arrPresent(parseOf(r), 'policy')).length,
      encryption: sectxtPresent.filter(r => arrPresent(parseOf(r), 'encryption')).length,
      acknowledgments: sectxtPresent.filter(r => arrPresent(parseOf(r), 'acknowledgments')).length,
      preferred_languages: sectxtPresent.filter(r => arrPresent(parseOf(r), 'preferred_languages')).length,
      canonical: sectxtPresent.filter(r => arrPresent(parseOf(r), 'canonical')).length,
      hiring: sectxtPresent.filter(r => arrPresent(parseOf(r), 'hiring')).length,
    },
    topDomains: sectxtPresent
      .map(r => ({
        domain: r.domain, state: r.file_state, fields: fieldCount(r),
        contact: arrPresent(parseOf(r), 'contact'),
        expires: arrPresent(parseOf(r), 'expires'),
        policy: arrPresent(parseOf(r), 'policy'),
        encryption: arrPresent(parseOf(r), 'encryption'),
        acknowledgments: arrPresent(parseOf(r), 'acknowledgments'),
        preferred_languages: arrPresent(parseOf(r), 'preferred_languages'),
        canonical: arrPresent(parseOf(r), 'canonical'),
        hiring: arrPresent(parseOf(r), 'hiring'),
      }))
      .sort((a, b) => b.fields - a.fields),
    nottingham: {
      state: nottsSectxt?.file_state,
      fields: nottsSectxt ? fieldCount(nottsSectxt) : 0,
    },
  };
  for (const r of sectxtData) {
    const s = r.file_state ?? 'null';
    sectxt.stateDist[s] = (sectxt.stateDist[s] ?? 0) + 1;
  }

  // ── SECURITY HEADERS ────────────────────────────────────────────────────────
  const { data: sechdrData, error: sechdrErr } = await db
    .from('signal_securityheaders_v1')
    .select('domain,endpoint_state,header_inventory')
    .eq('run_id', SECHDR_RUN_ID);
  if (sechdrErr) throw new Error('SECHDR: ' + sechdrErr.message);

  const SECURITY_HEADERS = [
    'strict_transport_security', 'content_security_policy', 'x_frame_options',
    'x_content_type_options', 'referrer_policy', 'permissions_policy',
    'cross_origin_opener_policy', 'cross_origin_embedder_policy', 'cross_origin_resource_policy',
    'x_xss_protection', 'nel', 'report_to', 'reporting_endpoints',
    'public_key_pins', 'expect_ct', 'feature_policy', 'origin_agent_cluster',
    'public_key_pins_report_only', 'content_security_policy_report_only',
    'cross_origin_opener_policy_report_only', 'cross_origin_embedder_policy_report_only',
  ];

  const INFORMATIONAL_HEADERS = ['server', 'x_powered_by', 'x_aspnet_version', 'x_aspnetmvc_version'];

  const sechdrObserved = sechdrData.filter(r => r.endpoint_state === 'RESPONSE_OBSERVED');
  const countHeaders = r => {
    if (!r.header_inventory) return 0;
    return SECURITY_HEADERS.filter(h => r.header_inventory[h]?.present === true).length;
  };
  const countInfo = r => {
    if (!r.header_inventory) return 0;
    return INFORMATIONAL_HEADERS.filter(h => r.header_inventory[h]?.present === true).length;
  };

  const hdrCounts = sechdrObserved.map(countHeaders).sort((a, b) => a - b);
  const nottsHdr = sechdrData.find(r => r.domain === TARGET);
  const nottsHdrCount = nottsHdr ? countHeaders(nottsHdr) : 0;

  // per-header adoption
  const headerAdoption = {};
  for (const h of [...SECURITY_HEADERS, ...INFORMATIONAL_HEADERS]) {
    headerAdoption[h] = sechdrObserved.filter(r => r.header_inventory?.[h]?.present === true).length;
  }

  // per-domain counts sorted
  const hdrByDomain = sechdrObserved.map(r => ({
    domain: r.domain,
    count: countHeaders(r),
    info_count: countInfo(r),
    headers: SECURITY_HEADERS.filter(h => r.header_inventory?.[h]?.present === true),
  })).sort((a, b) => b.count - a.count);

  // peer groups: 5 above, 5 below Nottingham by header count
  const nottsRankInObserved = hdrByDomain.findIndex(r => r.domain === TARGET);

  const sechdr = {
    total: sechdrData.length,
    observed: sechdrObserved.length,
    hdrCountQuantiles: quantiles(hdrCounts),
    headerAdoption,
    nottingham: {
      state: nottsHdr?.endpoint_state,
      count: nottsHdrCount,
      headers: nottsHdr ? SECURITY_HEADERS.filter(h => nottsHdr.header_inventory?.[h]?.present === true) : [],
      info_headers: nottsHdr ? INFORMATIONAL_HEADERS.filter(h => nottsHdr.header_inventory?.[h]?.present === true) : [],
      pctile: pctile(hdrCounts, nottsHdrCount),
      quartile: quartile(hdrCounts, nottsHdrCount),
      decile: decile(hdrCounts, nottsHdrCount),
      rank_in_observed: nottsRankInObserved,
    },
    top10: hdrByDomain.slice(0, 10).map(r => ({ domain: r.domain, count: r.count, headers: r.headers })),
    bottom10: hdrByDomain.slice(-10).reverse().map(r => ({ domain: r.domain, count: r.count })),
    peersAbove: hdrByDomain.slice(Math.max(0, nottsRankInObserved - 5), nottsRankInObserved),
    peersBelow: hdrByDomain.slice(nottsRankInObserved + 1, nottsRankInObserved + 6),
    allDomains: hdrByDomain,
  };

  process.stdout.write(JSON.stringify({ spf, dkim, dmarc, mtasts, dnssec, caa, sectxt, sechdr }, null, 0));
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
