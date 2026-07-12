'use strict';

/*
 * Baseline 001 — transient-failure retry pass.
 *
 * The Core A/B/C collectors record a transient DNS/HTTP failure as absence-of-row
 * (the existing pipeline behaviour). This pass finds, per signal, the VERIFIED
 * domains that produced NO observation in the baseline window and re-collects
 * ONLY those, reusing the EXACT production collect+insert functions exported by
 * collection/runs/if001/run-all.js. No new collectors; no full re-run.
 *
 * A domain that still yields no row after retry is a permanent failure (domain
 * does not resolve / refuses connections) — reported, not retried again.
 *
 * Usage: node backend/observatory/baseline/retry.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { loadOrganisations } = require('../../acquisition/providers/organisation-provider');
const { normaliseDomain } = require('../../authority/lib/normalise');
const pipeline = require('../../collection/runs/if001/run-all');

const START_FILE = path.join(__dirname, 'BASELINE_START.txt');

const SIGNALS = [
  { id: 'SOT-SPF-001', table: 'signal_facts_spf', run: pipeline.runSpf },
  { id: 'SOT-DKIM-001', table: 'signal_facts_dkim', run: pipeline.runDkim },
  { id: 'SOT-DMARC-001', table: 'signal_facts_dmarc', run: pipeline.runDmarc },
  { id: 'SOT-MTASTS-001', table: 'signal_facts_mtasts', run: pipeline.runMtaSts },
  { id: 'SOT-TLSRPT-001', table: 'signal_facts_tlsrpt', run: pipeline.runTlsRpt },
  { id: 'SOT-DNSSEC-001', table: 'signal_facts_dnssec', run: pipeline.runDnssec },
  { id: 'SOT-CAA-001', table: 'signal_facts_caa', run: pipeline.runCaa },
  { id: 'SOT-SECURITYTXT-001', table: 'signal_securitytxt_v1', run: pipeline.runSecurityTxt },
  { id: 'SOT-SECURITYHEADERS-001', table: 'signal_securityheaders_v1', run: pipeline.runSecurityHeaders },
];

async function observedDomains(supabase, table, sinceIso) {
  const set = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('domain')
      .gte('collected_at', sinceIso).order('domain', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) { const d = normaliseDomain(r.domain); if (d) set.add(d); }
    if (data.length < 1000) break;
  }
  return set;
}

async function retryPass({ sinceIso, limitPerSignal = 0 } = {}) {
  const supabase = pipeline.getClient();
  const since = sinceIso || fs.readFileSync(START_FILE, 'utf8').trim();
  const firms = loadOrganisations().organisations;   // canonical VERIFIED population
  const byDomain = new Map(firms.map((f) => [normaliseDomain(f.domain), f]));

  const perSignal = {};
  let totalRetried = 0, totalRecovered = 0;

  // Re-collect each signal's missing domains. Signals run in PARALLEL (each writes
  // a distinct table — no contention). The pass is idempotent + resumable: the
  // failed set is recomputed from the DB each launch, so re-running after any
  // interruption simply continues. limitPerSignal caps each signal to a bounded
  // slice so a run can be executed as short synchronous chunks (reliable on a
  // machine where long-lived background processes get reaped).
  await Promise.all(SIGNALS.map(async (sig) => {
    const observed = await observedDomains(supabase, sig.table, since);
    let failed = [...byDomain.keys()].filter((d) => !observed.has(d)).map((d) => byDomain.get(d));
    const remainingBefore = failed.length;
    if (limitPerSignal > 0) failed = failed.slice(0, limitPerSignal);
    if (failed.length === 0) { perSignal[sig.id] = { retried: 0, recovered: 0, remaining: remainingBefore }; return; }

    console.log(`[retry] ${sig.id}: ${failed.length} domain(s) with no observation — re-collecting`);
    await sig.run(failed, supabase, randomUUID(), Date.now());

    const observedAfter = await observedDomains(supabase, sig.table, since);
    const recovered = failed.filter((f) => observedAfter.has(normaliseDomain(f.domain))).length;
    const remaining = remainingBefore - recovered;
    perSignal[sig.id] = { retried: failed.length, recovered, remaining };
    totalRetried += failed.length;
    totalRecovered += recovered;
    console.log(`[retry] ${sig.id}: recovered ${recovered}/${failed.length} (remaining ${remaining})`);
  }));

  const result = { totalRetried, totalRecovered, perSignal, note: 'single re-collection pass over transient failures (existing collectors)' };
  console.log('\nRetry pass complete:', JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));
  const limitPerSignal = args.limit ? Number(args.limit) : 0;
  retryPass({ limitPerSignal }).then((r) => {
    fs.writeFileSync(path.join(__dirname, 'dataset', 'retry-result.json'), JSON.stringify(r, null, 2), 'utf8');
    const stillRemaining = Object.values(r.perSignal).reduce((a, s) => a + s.remaining, 0);
    console.log(`REMAINING_TOTAL=${stillRemaining}`);
  }).catch((e) => { console.error('Retry failed:', e.stack || e.message); process.exit(1); });
}

module.exports = { retryPass };
