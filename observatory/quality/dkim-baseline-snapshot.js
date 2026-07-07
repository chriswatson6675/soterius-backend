'use strict';
// DKIM National Baseline snapshot exporter
//
// Materialises a DKIM national baseline (latest observation per domain within a
// collection-time window) from the append-only signal_facts_dkim / _keys tables
// into an immutable repository dataset — the DKIM analogue of the SPF NOB-001R
// dataset directory. Read-only against the database; writes only local NDJSON +
// manifest. Deterministic for a fixed window (append-only source → stable output).
//
// It is used twice, with the SAME code (no drift), to preserve full audit lineage:
//   • the ORIGINAL contention-affected baseline (NOB-DKIM-001), window < remediation
//   • the VALIDATED replacement baseline    (NOB-DKIM-001R), window = isolated re-run
//
// Usage:
//   node backend/observatory/quality/dkim-baseline-snapshot.js \
//        --label NOB-DKIM-001 --outdir nob-dkim-001 \
//        --before 2026-07-07T14:00:00Z
//   node backend/observatory/quality/dkim-baseline-snapshot.js \
//        --label NOB-DKIM-001R --outdir nob-dkim-001r \
//        --after 2026-07-07T14:00:00Z

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const LABEL   = arg('label');
const OUTDIR  = arg('outdir');
const BEFORE  = arg('before'); // upper bound (exclusive) on collected_at
const AFTER   = arg('after');  // lower bound (inclusive) on collected_at
if (!LABEL || !OUTDIR) { console.error('need --label and --outdir'); process.exit(1); }

const DIR  = path.join(__dirname, OUTDIR);
const PAGE = 1000;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

// Fetch every row of a table within the collected_at window, paginated by a
// STABLE unique key (id). Ordering by collected_at is unsafe here: a single run
// writes thousands of rows sharing one identical collected_at, and range-based
// pagination over a non-unique sort key skips/duplicates rows across pages.
async function fetchAll(sb, table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (BEFORE) q = q.lt('collected_at', BEFORE);
    if (AFTER)  q = q.gte('collected_at', AFTER);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    process.stdout.write(`\r  ${table}: ${out.length} rows`);
    if (data.length < PAGE) break;
  }
  process.stdout.write('\n');
  return out;
}

function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

(async () => {
  console.log(`\nDKIM baseline snapshot — ${LABEL}  (window: ${AFTER ? `>= ${AFTER}` : ''}${BEFORE ? `< ${BEFORE}` : ''})`);
  const sb = getClient();

  // ── Domain-level: reduce to latest observation per domain within the window ──
  const domainRows = await fetchAll(sb, 'signal_facts_dkim',
    'id,domain,signal_version,collected_at,dkim_present,dkim_collection_status,dkim_record_count,dkim_selectors_probed,dkim_selectors_found,dkim_probe_set_version');
  const latestByDomain = new Map();
  for (const r of domainRows) {
    const cur = latestByDomain.get(r.domain);
    if (!cur || r.collected_at > cur.collected_at) latestByDomain.set(r.domain, r);
  }
  const latest = [...latestByDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  const selectedIds = new Set(latest.map(r => r.id));
  console.log(`  latest-per-domain: ${latest.length}`);

  // ── Key-level: keep keys whose parent domain-row is in the selected latest set ─
  const keyRows = await fetchAll(sb, 'signal_facts_dkim_keys',
    'id,dkim_run_id,domain,collected_at,selector,raw_record,parse_success,version,key_type,key_bits,public_key_present,hash_algorithms,service_type,flags,syntax_errors');
  const keys = keyRows.filter(k => selectedIds.has(k.dkim_run_id))
                      .sort((a, b) => a.domain.localeCompare(b.domain) || a.selector.localeCompare(b.selector));
  console.log(`  keys for selected domains: ${keys.length}`);

  // ── Serialise NDJSON (stable order → stable SHA) ────────────────────────────
  const obsNd  = latest.map(r => JSON.stringify(r)).join('\n') + '\n';
  const keysNd = keys.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);
  fs.writeFileSync(path.join(DIR, 'keys.ndjson'), keysNd);

  // ── Stage-2 statistics over this baseline ───────────────────────────────────
  const status = s => latest.filter(r => r.dkim_collection_status === s).length;
  const present = latest.filter(r => r.dkim_present === true).length;
  const nonobs  = status('DNS_FAILURE') + status('DNS_SERVFAIL') + status('DNS_TIMEOUT');
  const genuine = latest.filter(r => r.dkim_present === true && r.dkim_record_count <= 7);
  const anomalous = latest.filter(r => r.dkim_present === true && r.dkim_record_count >= 8);

  const genuineIds = new Set(genuine.map(r => r.id));
  const gk = keys.filter(k => genuineIds.has(k.dkim_run_id));
  const rsaParsed = gk.filter(k => k.key_type === 'rsa' && k.parse_success);
  const bits = {};
  for (const k of rsaParsed) bits[k.key_bits] = (bits[k.key_bits] || 0) + 1;
  const recCount = {};
  for (const r of latest.filter(r => r.dkim_present === true)) recCount[r.dkim_record_count] = (recCount[r.dkim_record_count] || 0) + 1;

  const dist = {
    population: latest.length,
    outcomes: {
      present, not_detected: status('NOT_DETECTED'),
      dns_failure: status('DNS_FAILURE'), dns_servfail: status('DNS_SERVFAIL'), dns_timeout: status('DNS_TIMEOUT'),
    },
    nonobservation_pct: +(100 * nonobs / latest.length).toFixed(2),
    adoption: {
      crude_pct: +(100 * present / latest.length).toFixed(2),
      of_observed_pct: +(100 * present / (latest.length - nonobs)).toFixed(2),
      observed_population: latest.length - nonobs,
    },
    present_composition: { genuine_le7: genuine.length, anomalous_ge8: anomalous.length },
    record_count_hist: recCount,
    genuine_keys: gk.length,
    genuine_parse_ok: gk.filter(k => k.parse_success).length,
    genuine_parse_fail: gk.filter(k => !k.parse_success).length,
    key_type: { rsa: gk.filter(k => k.key_type === 'rsa').length, ed25519: gk.filter(k => k.key_type === 'ed25519').length, other: gk.filter(k => !['rsa','ed25519'].includes(k.key_type)).length },
    rsa_key_bits: bits,
    revoked_keys: gk.filter(k => k.public_key_present === false).length,
    version_omitted: gk.filter(k => k.version === null).length,
    flag_testing_y: gk.filter(k => (k.flags || []).includes('y')).length,
    flag_no_subdomain_s: gk.filter(k => (k.flags || []).includes('s')).length,
    has_h_tag: gk.filter(k => k.hash_algorithms !== null).length,
  };
  fs.writeFileSync(path.join(DIR, 'distribution.json'), JSON.stringify(dist, null, 2));

  // ── Manifest with lineage ───────────────────────────────────────────────────
  const manifest = {
    run_label: LABEL,
    signal: 'SOT-DKIM-001',
    category: 'A — Email Trust (Signal 2)',
    population: latest.length,
    cohort_id: 'ORG-AUTHORITY-001',
    window: { after: AFTER || null, before: BEFORE || null },
    collected_span: { earliest: latest.reduce((m, r) => r.collected_at < m ? r.collected_at : m, latest[0].collected_at),
                      latest:   latest.reduce((m, r) => r.collected_at > m ? r.collected_at : m, latest[0].collected_at) },
    counts: { observations: latest.length, keys: keys.length },
    sha256: { observations: sha256(obsNd), keys: sha256(keysNd) },
    signal_version: 1,
    probe_set_version: 1,
    nonobservation_pct: dist.nonobservation_pct,
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n  wrote ${DIR}`);
  console.log(`  observations ${latest.length} (sha ${manifest.sha256.observations.slice(0,12)}…)  keys ${keys.length}`);
  console.log(`  non-observation rate: ${dist.nonobservation_pct}%   present: ${present}   NOT_DETECTED: ${status('NOT_DETECTED')}\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
