'use strict';

// IF-001 — Cohort Selection (Full Cohort)
//
// Queries the prospects table for all FCA investment firms with a previously
// validated domain (last_scanned IS NOT NULL) and saves the full manifest to
// cohort-manifest.json in this directory.
//
// This selects the complete IF-001 cohort — no sampling. All qualifying firms
// are included. Expected size: ~1,928 domains.
//
// Usage:
//   node backend/signal-lab/if001-full/select-cohort.js
//
// Prerequisites:
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env
//   Prospects table populated with FCA firms (source='fca-register')

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const { randomUUID }   = require('node:crypto');
const fs               = require('node:fs');
const path             = require('node:path');

const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');
const PAGE_SIZE     = 1000;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

function normaliseDomain(raw) {
  if (!raw) return null;
  return raw.toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

async function fetchAllFcaProspects(supabase) {
  const rows = [];
  let from   = 0;

  while (true) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, firm_name, website, last_scanned')
      .eq('source', 'fca-register')
      .not('last_scanned', 'is', null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function main() {
  const HR = '═'.repeat(68);
  console.log(`\n${HR}`);
  console.log(' IF-001 — Full Cohort Selection');
  console.log(' Selecting all FCA prospects with previously validated domain');
  console.log(`${HR}\n`);

  const supabase = getClient();
  const allRows  = await fetchAllFcaProspects(supabase);

  console.log(`  Total FCA prospects with last_scanned   : ${allRows.length}`);

  // Filter to firms with a non-empty normalised domain
  const withDomain = allRows
    .map(r => ({ ...r, domain: normaliseDomain(r.website) }))
    .filter(r => r.domain && r.domain.length > 0);

  console.log(`  With non-empty normalised domain        : ${withDomain.length}`);

  if (withDomain.length === 0) {
    throw new Error('No qualifying firms found. Check that prospects table is populated.');
  }

  const manifest = {
    cohort_id:    'IF-001',
    cohort_name:  'Investment Firms — FCA Full Cohort',
    selected_at:  new Date().toISOString(),
    selection_id: randomUUID(),
    pool_size:    allRows.length,
    n:            withDomain.length,
    firms:        withDomain.map(r => ({
      id:           r.id,
      firm_name:    r.firm_name,
      domain:       r.domain,
      last_scanned: r.last_scanned,
    })),
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`  Cohort size                             : ${manifest.n}`);
  console.log(`  Selection ID                            : ${manifest.selection_id}`);
  console.log(`  Selected at                             : ${manifest.selected_at}`);
  console.log(`  Manifest saved to                       : ${MANIFEST_PATH}`);
  console.log('\n  Sample (first 10 selected):\n');
  for (const f of manifest.firms.slice(0, 10)) {
    console.log(`    ${f.domain.padEnd(44)} ${f.firm_name.slice(0, 40)}`);
  }
  console.log(`\n  ${HR}`);
  console.log('  Cohort manifest saved. Run run-all.js to execute Signal Lab collection.');
  console.log(`  ${HR}\n`);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
