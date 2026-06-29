'use strict';

// PRA cohort overlap assessment
// Reads all 5 PRA CSV files, extracts firm names and FRNs,
// then queries the prospects table to find any existing records.

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

const DATA_DIR = path.join(__dirname, '../../../data/pra');

// Parse a PRA CSV file — returns array of { firmName, frn }
// Handles: header preamble rows, multi-row insurer activity lines, section headers
function parsePraFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim());
  const firms = [];
  const seen  = new Set();

  for (const line of lines) {
    if (!line) continue;
    // Strip surrounding quotes for parsing
    const parts = line.split(',').map(p => p.replace(/^"|"$/g, '').trim());
    const name  = parts[0];
    const frnRaw = parts[1];

    // Skip if FRN is not a number
    if (!frnRaw || !/^\d+$/.test(frnRaw)) continue;
    // Skip if name looks like a header or preamble
    if (!name || name.length < 2) continue;

    const frn = frnRaw;
    if (!seen.has(frn)) {
      seen.add(frn);
      firms.push({ firmName: name, frn });
    }
  }

  return firms;
}

async function fetchAllProspects(supabase) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, firm_name, website, source')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function normName(s) {
  return (s || '').toLowerCase()
    .replace(/\b(limited|ltd|plc|llp|lp|incorporated|inc|public limited company|p\.l\.c\.)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const supabase = getClient();

  // Load PRA files
  const files = {
    banks:      { path: path.join(DATA_DIR, 'pra-banks-2606.csv'),              label: 'Banks' },
    building:   { path: path.join(DATA_DIR, 'pra-building-societies-2606.csv'), label: 'Building Societies' },
    credit:     { path: path.join(DATA_DIR, 'pra-credit-unions-2606.csv'),      label: 'Credit Unions' },
    insurers:   { path: path.join(DATA_DIR, 'pra-insurers-2606.csv'),           label: 'Insurers' },
    designated: { path: path.join(DATA_DIR, 'pra-designated-firms.csv'),        label: 'Designated Investment Firms' },
  };

  const praByCategory = {};
  let allPraFirms = [];

  for (const [key, meta] of Object.entries(files)) {
    const firms = parsePraFile(meta.path);
    praByCategory[key] = firms;
    allPraFirms = allPraFirms.concat(firms.map(f => ({ ...f, category: key })));
    console.log(`${meta.label}: ${firms.length} unique firms`);
  }
  console.log(`Total PRA: ${allPraFirms.length} unique firms\n`);

  // Fetch all prospects
  console.log('Fetching prospects table...');
  const prospects = await fetchAllProspects(supabase);
  console.log(`Prospects table: ${prospects.length} total rows\n`);

  // Build lookup maps
  const prospectsByNormName = new Map();
  for (const p of prospects) {
    const key = normName(p.firm_name);
    if (!prospectsByNormName.has(key)) prospectsByNormName.set(key, []);
    prospectsByNormName.get(key).push(p);
  }

  // FCA-source prospects
  const fcaProspects = prospects.filter(p => p.source === 'fca-register');
  const fcaByNormName = new Map();
  for (const p of fcaProspects) {
    const key = normName(p.firm_name);
    if (!fcaByNormName.has(key)) fcaByNormName.set(key, []);
    fcaByNormName.get(key).push(p);
  }

  console.log(`FCA-source prospects: ${fcaProspects.length}`);
  console.log(`FCA with non-empty website: ${fcaProspects.filter(p => p.website).length}\n`);

  // --- Match PRA firms against prospects ---
  const results = {};

  for (const [catKey, firms] of Object.entries(praByCategory)) {
    let inProspects = 0;
    let inFcaSource = 0;
    let withDomain  = 0;
    const matches   = [];

    for (const firm of firms) {
      const normKey = normName(firm.firmName);
      const allMatches = prospectsByNormName.get(normKey) || [];
      const fcaMatches = fcaByNormName.get(normKey) || [];

      if (allMatches.length > 0) {
        inProspects++;
        const hasDomain = allMatches.some(p => p.website && p.website.trim());
        if (hasDomain) withDomain++;
        const domain = allMatches.find(p => p.website)?.website || null;
        matches.push({ firmName: firm.firmName, frn: firm.frn, inProspects: true, inFcaSource: fcaMatches.length > 0, domain });
      } else {
        matches.push({ firmName: firm.firmName, frn: firm.frn, inProspects: false, inFcaSource: false, domain: null });
      }
      if (fcaMatches.length > 0) inFcaSource++;
    }

    results[catKey] = {
      total:       firms.length,
      inProspects,
      inFcaSource,
      withDomain,
      notInProspects: firms.length - inProspects,
      matches,
    };
  }

  // Print summary
  console.log('=== OVERLAP RESULTS ===\n');
  for (const [cat, r] of Object.entries(results)) {
    const label = files[cat].label;
    console.log(`${label} (${r.total} firms):`);
    console.log(`  In prospects table (any source) : ${r.inProspects} (${(r.inProspects/r.total*100).toFixed(1)}%)`);
    console.log(`  In FCA-source prospects         : ${r.inFcaSource} (${(r.inFcaSource/r.total*100).toFixed(1)}%)`);
    console.log(`  With domain already             : ${r.withDomain} (${(r.withDomain/r.total*100).toFixed(1)}%)`);
    console.log(`  Not in prospects at all         : ${r.notInProspects} (${(r.notInProspects/r.total*100).toFixed(1)}%)`);
    // Sample matches
    const withDomainSample = r.matches.filter(m => m.domain).slice(0, 5);
    if (withDomainSample.length > 0) {
      console.log('  Sample firms with domain:');
      withDomainSample.forEach(m => console.log(`    ${m.firmName} → ${m.domain}`));
    }
    console.log('');
  }

  // Overlap with FCA investment firm population (IF-001 cohort firms)
  console.log('=== DESIGNATED FIRMS vs FCA INVESTMENT FIRM POPULATION ===');
  const desMatches = results.designated.matches;
  desMatches.forEach(m => {
    console.log(`  ${m.firmName} | FRN:${m.frn} | inProspects:${m.inProspects} | domain:${m.domain || 'none'}`);
  });

  // Output JSON for the document
  const output = {
    timestamp: new Date().toISOString(),
    prospectTableTotal: prospects.length,
    fcaSourceTotal: fcaProspects.length,
    fcaWithDomain: fcaProspects.filter(p => p.website).length,
    categories: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, {
        total:          v.total,
        inProspects:    v.inProspects,
        inFcaSource:    v.inFcaSource,
        withDomain:     v.withDomain,
        notInProspects: v.notInProspects,
      }])
    ),
    designatedDetail: results.designated.matches,
  };

  fs.writeFileSync(
    path.join(__dirname, 'overlap-results.json'),
    JSON.stringify(output, null, 2),
    'utf8'
  );
  console.log('\nResults written to overlap-results.json');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
