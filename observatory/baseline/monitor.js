'use strict';
// Baseline 001 completion monitor. Polls in-window per-signal coverage via fast
// head counts (the completion pass inserts one row per previously-missing domain,
// so in-window row count == distinct-domain count). Exits 0 when all 9 signals
// reach the full VERIFIED population, 2 if progress stalls (process likely died —
// re-launch retry.js to resume). Fault-tolerant: transient query errors are
// retried, never fatal.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SINCE = require('node:fs').readFileSync(path.join(__dirname, 'BASELINE_START.txt'), 'utf8').trim();
const TABLES = ['signal_facts_spf', 'signal_facts_dkim', 'signal_facts_dmarc', 'signal_facts_mtasts',
  'signal_facts_tlsrpt', 'signal_facts_dnssec', 'signal_facts_caa', 'signal_securityheaders_v1', 'signal_securitytxt_v1'];
const TARGET = 17057;

async function countIn(table) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true }).gte('collected_at', SINCE);
    if (!error) return count;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null; // unknown this tick — treat as no-progress-info, not a crash
}

(async () => {
  let prevSum = -1, stalls = 0;
  for (let tick = 0; tick < 240; tick++) { // up to ~8h
    const counts = {};
    for (const t of TABLES) counts[t] = await countIn(t);
    const known = Object.values(counts).filter((c) => c !== null);
    const sum = known.reduce((a, b) => a + b, 0);
    const done = Object.values(counts).filter((c) => c !== null && c >= TARGET).length;
    const slowest = Object.entries(counts).filter(([, c]) => c !== null).sort((a, b) => a[1] - b[1])[0] || ['?', 0];
    console.log(`[${new Date().toISOString()}] complete ${done}/9 · sum ${sum}/${TARGET * 9} · slowest ${slowest[0]}=${slowest[1]}`);
    if (done === 9) { console.log('ALL SIGNALS COMPLETE'); process.exit(0); }
    if (known.length === TABLES.length && sum === prevSum) {
      stalls++;
      if (stalls >= 3) { console.log(`STALLED at sum ${sum} — process likely died; resume needed`); process.exit(2); }
    } else stalls = 0;
    if (known.length === TABLES.length) prevSum = sum;
    await new Promise((r) => setTimeout(r, 150000)); // 2.5 min
  }
  console.log('monitor timed out'); process.exit(3);
})().catch((e) => { console.error('monitor fatal:', e.message); process.exit(4); });
