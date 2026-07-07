'use strict';
// DKIM replacement-baseline TAIL completion runner.
//
// Context: the isolated DKIM replacement collection (run collected_at
// 2026-07-07T14:04:14.249Z) ran cleanly for ~13,928 domains (~0.17% non-obs)
// then the long-running Node process's resolver state degraded (~90 min /
// ~280k queries), recording false DNS_FAILURE for reachable domains (verified:
// domains failing in the aged process resolve instantly in a fresh one). This
// runner completes the baseline in a FRESH process, collecting only the domains
// not already captured by a TRUSTWORTHY (pre-degradation) row, using the EXACT
// production collect+insert path (imported runDkim — no collector change, no
// drift). Rows are stamped with a new collected_at; the replacement baseline is
// then latest-per-domain over collected_at >= 2026-07-07T14:04Z, so these newer
// rows supersede the 42 degraded false-failure rows.
//
// Usage:
//   CONCURRENCY=10 node backend/collection/runs/if001/run-dkim-tail.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

// Point the default DNS resolver at high-capacity public resolvers. The local/ISP
// resolver rate-limits this source IP under DKIM's national query volume (~20
// lookups/domain × 17k ≈ 340k queries/day), producing false DNS_FAILURE on
// reachable domains (verified: such domains resolve cleanly for SPF). Public
// resolvers (Cloudflare/Google) tolerate far higher rates and answer fast.
// This re-points the resolver only — the collector's DNS logic is unchanged
// (collectDkim already reads the default node:dns resolver).
const dns = require('node:dns');
dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);

const { randomUUID } = require('node:crypto');
const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');
const { getClient, runDkim } = require('./run-all');

const TRUSTWORTHY_BEFORE = '2026-07-07T15:20:00Z'; // pre-degradation cutoff
const RUN_COLLECTED_AT   = '2026-07-07 14:04:14.249+00'; // the interrupted replacement run

(async () => {
  const sb = getClient();
  const cohort = loadOrganisations();
  const allFirms = cohort.organisations;
  console.log(`Canonical VERIFIED organisations: ${allFirms.length}`);

  // Trustworthy (pre-degradation) domains already captured by the replacement run.
  const trustworthy = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('signal_facts_dkim')
      .select('domain,created_at')
      .eq('collected_at', RUN_COLLECTED_AT)
      .lte('created_at', TRUSTWORTHY_BEFORE)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data) trustworthy.add(r.domain);
    if (data.length < 1000) break;
  }
  console.log(`Trustworthy pre-degradation rows: ${trustworthy.size}`);

  const missing = allFirms.filter(f => !trustworthy.has(f.domain));
  console.log(`Domains to (re)collect in fresh process: ${missing.length}\n`);
  if (missing.length === 0) { console.log('Nothing to do.'); return; }

  const start = Date.now();
  const stats = await runDkim(missing, sb, randomUUID(), start);
  console.log(`\nTAIL complete: ${stats.completed}/${stats.attempted} in ${stats.elapsedSec}s (${stats.successRate}%)`);
  console.log(`Tail rows carry a fresh collected_at (later than the interrupted run) and supersede degraded rows.`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
