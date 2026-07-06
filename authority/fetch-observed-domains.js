'use strict';

/*
 * fetch-observed-domains.js — one-time (re-runnable) snapshot of the Observatory.
 *
 * The Observatory's evidence lives ONLY in the live Supabase `signal_*` tables,
 * keyed by `domain`. To keep the canonical build deterministic and offline, we
 * freeze the observed universe to a repo file: inputs/observed-domains.ndjson.
 *
 * Each line: {"domain": "...", "has_catd": bool, "has_complete": bool}
 *   has_catd     — TLS/certificate observed (signal_certificate_v1 ∪ signal_tls_v1)
 *   has_complete — full Trust Profile (signal_transfersafeguard_v1, the narrowest tier)
 *
 * Run: node backend/authority/fetch-observed-domains.js
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (backend/.env).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { normaliseDomain } = require('./lib/normalise');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}
const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

// Every domain-keyed signal table (the observed universe = their union).
const ALL_TABLES = [
  'signal_facts_spf', 'signal_facts_dmarc', 'signal_facts_dkim', 'signal_facts_mtasts',
  'signal_facts_tlsrpt', 'signal_facts_dnssec', 'signal_facts_caa',
  'signal_securityheaders_v1', 'signal_securitytxt_v1',
  'signal_certificate_v1', 'signal_tls_v1',
  'signal_domainregistration_v1', 'signal_disclosurecurrency_v1',
  'signal_retentiontransparency_v1', 'signal_transfersafeguard_v1',
];
const CATD_TABLES = ['signal_certificate_v1', 'signal_tls_v1'];
const COMPLETE_TABLES = ['signal_transfersafeguard_v1'];

const PAGE = 1000;

async function distinctDomains(table) {
  const set = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('domain')
      .order('domain', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const d = normaliseDomain(row.domain);
      if (d) set.add(d);
    }
    if (data.length < PAGE) break;
  }
  return set;
}

async function unionOf(tables) {
  const set = new Set();
  for (const t of tables) {
    const s = await distinctDomains(t);
    for (const d of s) set.add(d);
    console.error(`  ${t}: ${s.size} distinct (running union ${set.size})`);
  }
  return set;
}

(async () => {
  console.error('Observed universe (all signal tables):');
  const observed = await unionOf(ALL_TABLES);
  console.error('Category D (TLS/cert):');
  const catd = await unionOf(CATD_TABLES);
  console.error('Complete Trust Profile (transfer safeguard):');
  const complete = await unionOf(COMPLETE_TABLES);

  const outDir = path.join(__dirname, 'inputs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'observed-domains.ndjson');
  const domains = [...observed].sort();
  const lines = domains.map((d) => JSON.stringify({
    domain: d,
    has_catd: catd.has(d),
    has_complete: complete.has(d),
  }));
  fs.writeFileSync(outFile, lines.join('\n') + '\n');

  console.error('');
  console.error(`Wrote ${domains.length} observed domains to ${outFile}`);
  console.error(`  Category D: ${[...catd].filter((d) => observed.has(d)).length}`);
  console.error(`  Complete:   ${[...complete].filter((d) => observed.has(d)).length}`);
})().catch((e) => { console.error(e); process.exit(1); });
