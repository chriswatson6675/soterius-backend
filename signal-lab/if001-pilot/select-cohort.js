'use strict';

// IF-001-PILOT — Cohort Selection
//
// Queries the prospects table for FCA investment firms with a validated domain,
// draws a random 100-firm sample (IF-001-PILOT), and saves the manifest to
// cohort-manifest.json in this directory.
//
// Run this script ONCE before run-all.js. If the manifest already exists,
// re-running will overwrite it with a new random sample.
//
// Usage:
//   node backend/signal-lab/if001-pilot/select-cohort.js
//
// Prerequisites:
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env
//   Prospects table populated with FCA firms (source='fca-register')

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const { randomUUID }   = require('node:crypto');
const fs               = require('node:fs');
const path             = require('node:path');

const PILOT_SIZE    = 100;
const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');
const PAGE_SIZE     = 1000;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
      .select('id, firm_name, website')
      .eq('source', 'fca-register')
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
  console.log(' IF-001-PILOT — Cohort Selection');
  console.log(` Selecting ${PILOT_SIZE} firms from FCA prospects`);
  console.log(`${HR}\n`);

  const supabase   = getClient();
  const allRows    = await fetchAllFcaProspects(supabase);

  console.log(`  Total FCA prospects in prospects table : ${allRows.length}`);

  // Filter to firms with a non-empty website field
  const withDomain = allRows
    .map(r => ({ ...r, domain: normaliseDomain(r.website) }))
    .filter(r => r.domain && r.domain.length > 0);

  console.log(`  With non-empty website                 : ${withDomain.length}`);

  if (withDomain.length < PILOT_SIZE) {
    throw new Error(
      `Insufficient pool: ${withDomain.length} prospects available, ${PILOT_SIZE} required.`,
    );
  }

  // Fisher-Yates shuffle → take first PILOT_SIZE
  shuffle(withDomain);
  const sample = withDomain.slice(0, PILOT_SIZE);

  const manifest = {
    cohort_id:    'IF-001-PILOT',
    cohort_name:  'Investment Firms Pilot — 100-Firm Validation Cohort',
    selected_at:  new Date().toISOString(),
    selection_id: randomUUID(),
    pool_size:    withDomain.length,
    n:            sample.length,
    firms:        sample.map(r => ({
      id:        r.id,
      firm_name: r.firm_name,
      domain:    r.domain,
    })),
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`  Pilot size                             : ${manifest.n}`);
  console.log(`  Selection ID                           : ${manifest.selection_id}`);
  console.log(`  Selected at                            : ${manifest.selected_at}`);
  console.log(`  Manifest saved to                      : ${MANIFEST_PATH}`);
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
