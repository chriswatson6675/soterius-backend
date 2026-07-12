'use strict';

/*
 * Trust Profile derivation — National Observatory Baseline 001
 * ============================================================
 *
 * Reads immutable Observatory observations (Supabase signal_* tables, keyed by
 * domain) and the canonical Repository Authority (ORG-AUTHORITY-001), resolves
 * every observation to exactly one immutable Organisation ID via its VERIFIED
 * domain, and derives a Trust Profile + Trust Score (TS-RUBRIC-v1.0) per
 * organisation.
 *
 * This is a pure derivation: it records no evidence, mutates nothing, and — for
 * a fixed observation window — produces deterministic output. It references NO
 * legacy cohort registry; organisation identity comes only from the authority.
 *
 * Contract guarantees (baseline validation criteria):
 *   • every scored organisation exists in ORG-AUTHORITY-001 (VERIFIED)
 *   • every in-scope observation resolves to exactly one Organisation ID
 *     (one-owner-per-domain rule in the authority guarantees this)
 *   • orphan observations (observed domain owned by no VERIFIED org) are counted
 *     and reported, never silently attached
 *   • latest-per-domain reduction eliminates duplicate observations
 *
 * Usage:
 *   node backend/observatory/baseline/derive.js [--since=<ISO>] [--out=<dir>]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (backend/.env)
 */

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { normaliseDomain } = require('../../authority/lib/normalise');
const { scoreTrust } = require('./trust-score');

const AUTHORITY_PATH = process.env.ORG_DATASET_PATH
  || path.join(__dirname, '..', '..', 'authority', 'dataset', 'organisations.ndjson');
const PAGE = 1000;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Authority: VERIFIED domain → organisation ─────────────────────────────────

function loadVerifiedOrgs() {
  const raw = fs.readFileSync(AUTHORITY_PATH, 'utf8');
  const orgs = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const verified = orgs.filter((o) => o.domainStatus === 'VERIFIED' && o.verifiedDomain);
  const byDomain = new Map();     // normalised domain → org
  for (const o of verified) {
    const d = normaliseDomain(o.verifiedDomain);
    if (d) byDomain.set(d, o);    // one-owner-per-domain: authority guarantees uniqueness
  }
  return { verified, byDomain };
}

// ── Latest-observation-per-domain fetch (compact projections) ─────────────────

const PAGE_PAUSE_MS = Number(process.env.DERIVE_PAGE_PAUSE_MS ?? 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One page fetch with retry — the shared instance is fragile, so a transient
// timeout must not abort the whole derivation.
async function fetchPageWithRetry(query, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data, error } = await query();
    if (!error) return data;
    lastErr = error;
    await sleep(1000 * attempt); // linear backoff
  }
  throw new Error(`${label}: ${lastErr ? lastErr.message : 'unknown error'} (after retries)`);
}

async function fetchLatest(supabase, table, columns, sinceIso) {
  // Returns Map<normalisedDomain, row> keeping the row with the max collected_at.
  const latest = new Map();
  const ts = new Map();
  for (let from = 0; ; from += PAGE) {
    const data = await fetchPageWithRetry(() => {
      let q = supabase.from(table).select(columns).order('collected_at', { ascending: true }).range(from, from + PAGE - 1);
      if (sinceIso) q = q.gte('collected_at', sinceIso);
      return q;
    }, table);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const d = normaliseDomain(row.domain);
      if (!d) continue;
      const t = Date.parse(row.collected_at);
      if (!latest.has(d) || t >= ts.get(d)) { latest.set(d, row); ts.set(d, t); }
    }
    if (data.length < PAGE) break;
    if (PAGE_PAUSE_MS) await sleep(PAGE_PAUSE_MS);
  }
  return latest;
}

async function fetchDkimKeysByRun(supabase, sinceIso) {
  // dkim keys carry their own domain + run id; group them by dkim_run_id.
  const byRun = new Map();
  for (let from = 0; ; from += PAGE) {
    const data = await fetchPageWithRetry(() => {
      let q = supabase.from('signal_facts_dkim_keys')
        .select('dkim_run_id,key_type,key_bits,public_key_present,collected_at')
        .order('collected_at', { ascending: true }).range(from, from + PAGE - 1);
      if (sinceIso) q = q.gte('collected_at', sinceIso);
      return q;
    }, 'signal_facts_dkim_keys');
    if (!data || data.length === 0) break;
    for (const k of data) {
      if (!byRun.has(k.dkim_run_id)) byRun.set(k.dkim_run_id, []);
      byRun.get(k.dkim_run_id).push(k);
    }
    if (data.length < PAGE) break;
    if (PAGE_PAUSE_MS) await sleep(PAGE_PAUSE_MS);
  }
  return byRun;
}

// Sequential (not parallel) to stay gentle on the fragile shared instance —
// one table's read stream at a time, each page retried, lightly paced.
async function loadObservations(supabase, sinceIso) {
  const log = (m) => console.error(`  [derive] ${m}`);
  log('spf …');         const spf = await fetchLatest(supabase, 'signal_facts_spf', 'domain,collected_at,spf_present,spf_collection_error,spf_mechanism,spf_parse_success,spf_lookup_count,spf_multiple_records', sinceIso);
  log('dmarc …');       const dmarc = await fetchLatest(supabase, 'signal_facts_dmarc', 'domain,collected_at,dmarc_present,dmarc_collection_error,dmarc_policy,dmarc_subdomain_policy,dmarc_pct,dmarc_rua_count', sinceIso);
  log('dkim …');        const dkim = await fetchLatest(supabase, 'signal_facts_dkim', 'id,domain,collected_at,dkim_present,dkim_collection_status,dkim_record_count', sinceIso);
  log('dnssec …');      const dnssec = await fetchLatest(supabase, 'signal_facts_dnssec', 'domain,collected_at,dns_ds_present,ds_collection_error,ds_algorithms,dns_dnskey_present,dnskey_algorithms', sinceIso);
  log('caa …');         const caa = await fetchLatest(supabase, 'signal_facts_caa', 'domain,collected_at,dns_caa_present,caa_collection_error,caa_issue_count,caa_issuewild_count,caa_iodef_count,caa_critical_count', sinceIso);
  log('mtasts …');      const mtasts = await fetchLatest(supabase, 'signal_facts_mtasts', 'domain,collected_at,dns_sts_present,dns_collection_error,policy_present,policy_mode,policy_tls_valid,policy_max_age', sinceIso);
  log('headers …');     const headers = await fetchLatest(supabase, 'signal_securityheaders_v1', 'domain,collected_at,endpoint_state,header_inventory', sinceIso);
  log('securitytxt …'); const stxt = await fetchLatest(supabase, 'signal_securitytxt_v1', 'domain,collected_at,file_state,canonical_parse', sinceIso);
  log('dkim keys …');   const keysByRun = await fetchDkimKeysByRun(supabase, sinceIso);
  log(`loaded — spf ${spf.size} dmarc ${dmarc.size} dkim ${dkim.size} dnssec ${dnssec.size} caa ${caa.size} mtasts ${mtasts.size} headers ${headers.size} stxt ${stxt.size}`);
  return { spf, dmarc, dkim, dnssec, caa, mtasts, headers, stxt, keysByRun };
}

// Reduce a security-headers row to just the presence booleans the scorer needs
// (discard the multi-KB header_inventory blob to keep profiles compact).
function slimHeaderInventory(inv) {
  if (!inv) return {};
  const out = {};
  for (const k of ['content_security_policy', 'strict_transport_security', 'x_frame_options',
    'x_content_type_options', 'referrer_policy', 'permissions_policy',
    'cross_origin_opener_policy', 'cross_origin_embedder_policy', 'cross_origin_resource_policy',
    'server', 'x_powered_by']) {
    out[k] = { present: !!(inv[k] && inv[k].present) };
  }
  return out;
}

// Compact per-org posture facts, for national/cohort signal benchmarks.
function postureOf(facts) {
  const h = facts.securityheaders;
  const hInv = h && h.endpoint_state === 'RESPONSE_OBSERVED' ? (h.header_inventory || {}) : null;
  const dkimRow = facts.dkim && facts.dkim.row;
  const dnssec = facts.dnssec || {};
  let dnssecState = 'unobserved';
  if (dnssec.dns_ds_present !== undefined) {
    if (dnssec.dns_ds_present && dnssec.dns_dnskey_present) dnssecState = 'anchored';
    else if (dnssec.dns_dnskey_present) dnssecState = 'island';
    else dnssecState = 'unsigned';
  }
  return {
    spf_present: !!(facts.spf && facts.spf.spf_present),
    spf_mechanism: facts.spf ? (facts.spf.spf_mechanism || null) : null,
    dmarc_present: !!(facts.dmarc && facts.dmarc.dmarc_present),
    dmarc_policy: facts.dmarc ? (facts.dmarc.dmarc_policy || null) : null,
    dkim_detected: !!(dkimRow && dkimRow.dkim_present && dkimRow.dkim_collection_status == null),
    dnssec: dnssecState,
    caa_present: !!(facts.caa && facts.caa.dns_caa_present),
    mtasts_present: !!(facts.mtasts && facts.mtasts.dns_sts_present),
    mtasts_mode: facts.mtasts ? (facts.mtasts.policy_mode || null) : null,
    web_reachable: !!(h && h.endpoint_state === 'RESPONSE_OBSERVED'),
    securitytxt_state: facts.securitytxt ? (facts.securitytxt.file_state || null) : null,
    header_count: hInv ? Object.values(hInv).filter((v) => v && v.present).length : null,
  };
}

// ── Derivation ────────────────────────────────────────────────────────────────

async function derive({ sinceIso = null, outDir = path.join(__dirname, 'dataset'), preloadedObs = null, write = true } = {}) {
  const { verified, byDomain } = loadVerifiedOrgs();
  // preloadedObs lets the caller re-run the (pure) scoring over the SAME observations
  // without a second DB read — used for the in-memory determinism check, keeping the
  // fragile shared instance to a single read pass.
  const obs = preloadedObs || await loadObservations(getClient(), sinceIso);

  // Universe of domains that carry any in-window observation.
  const observedDomains = new Set();
  for (const m of [obs.spf, obs.dmarc, obs.dkim, obs.dnssec, obs.caa, obs.mtasts, obs.headers, obs.stxt]) {
    for (const d of m.keys()) observedDomains.add(d);
  }

  // Orphans: observed domains owned by no VERIFIED organisation.
  const orphanDomains = [...observedDomains].filter((d) => !byDomain.has(d)).sort();

  const profiles = [];
  let scoredCount = 0, insufficientCount = 0, coreCompleteCount = 0;

  for (const org of verified) {
    const d = normaliseDomain(org.verifiedDomain);
    const dkimRow = obs.dkim.get(d) || null;
    const facts = {
      spf: obs.spf.get(d) || null,
      dmarc: obs.dmarc.get(d) || null,
      dkim: dkimRow ? { row: dkimRow, keys: obs.keysByRun.get(dkimRow.id) || [] } : { row: null, keys: [] },
      dnssec: obs.dnssec.get(d) || null,
      caa: obs.caa.get(d) || null,
      mtasts: obs.mtasts.get(d) || null,
      securityheaders: obs.headers.get(d) ? { ...obs.headers.get(d), header_inventory: slimHeaderInventory(obs.headers.get(d).header_inventory) } : null,
      securitytxt: obs.stxt.get(d) || null,
    };

    const observed = [facts.spf, facts.dmarc, facts.dkim.row, facts.dnssec, facts.caa, facts.mtasts, facts.securityheaders, facts.securitytxt]
      .some((x) => x !== null);
    if (!observed) {
      // VERIFIED but not observed in this window → recorded as unscanned (no profile row emitted;
      // counted by the caller against the eligible population).
      continue;
    }

    const ts = scoreTrust(facts);
    scoredCount++;
    if (ts.label === 'INSUFFICIENT_OBSERVATION') insufficientCount++;
    if (ts.coreComplete) coreCompleteCount++;

    profiles.push({
      organisationId: org.organisationId,
      organisationName: org.organisationName,
      verifiedDomain: org.verifiedDomain,
      regulators: org.regulators || [],
      sicCodes: org.sicCodes || [],
      companiesHouse: org.companiesHouse ? { region: org.companiesHouse.region || null } : null,
      rubric: ts.rubric,
      trustScore: ts.score,
      scoreLabel: ts.label,
      band: ts.band,
      earned: ts.earned,
      attainable: ts.attainable,
      completeness: ts.completeness,
      coreComplete: ts.coreComplete,
      observedSignalCount: ts.observedSignalCount,
      categories: ts.categories,
      signals: ts.signals,
      posture: postureOf(facts),
    });
  }

  // Deterministic ordering by immutable Organisation ID.
  profiles.sort((a, b) => (a.organisationId < b.organisationId ? -1 : a.organisationId > b.organisationId ? 1 : 0));

  const profilesPath = path.join(outDir, 'trust-profiles.ndjson');
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(profilesPath, profiles.map((p) => JSON.stringify(p)).join('\n') + (profiles.length ? '\n' : ''), 'utf8');
  }

  const summary = {
    sinceIso,
    eligibleVerified: verified.length,
    observedDomainsInWindow: observedDomains.size,
    orphanObservations: orphanDomains.length,
    organisationsScored: scoredCount,
    organisationsUnscanned: verified.length - scoredCount,
    trustScoresComputed: scoredCount - insufficientCount,
    insufficientObservation: insufficientCount,
    coreCompleteProfiles: coreCompleteCount,
    profilesPath,
  };
  return { summary, profiles, orphanDomains, observations: obs, byDomain, verified };
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));
  const outDir = args.out ? path.resolve(args.out) : undefined;
  derive({ sinceIso: args.since || null, outDir })
    .then(({ summary }) => { console.log(JSON.stringify(summary, null, 2)); })
    .catch((e) => { console.error('Derivation failed:', e.message); process.exit(1); });
}

module.exports = { derive, loadVerifiedOrgs, postureOf };
