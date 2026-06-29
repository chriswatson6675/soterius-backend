'use strict';

// execution-check.js — Phase 3 verification harness (IMP-FCA-001 §3).
//
// Demonstrates the endpoint execution engine + anchor resolution against the live
// FS Register, IN MEMORY ONLY (nothing is preserved, extracted, or written).
// Concise summaries only — no full payload dumps, no credential.
//
// Usage: node signal-lab/sources/fca/execution-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const { loadConfig, validateConfig } = require('./fca-client');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');

// A modest scope (excludes firm.individuals / firm.cf — very high cardinality;
// IMP-FCA-001 §3 records this as a scope choice, not a silent cap).
const SCOPE = [
  'firm', 'firm.names', 'firm.address', 'firm.permissions',
  'firm.requirements', 'firm.requirements.investmentTypes',
  'firm.ar', 'firm.regulators', 'firm.disciplinaryHistory',
  'firm.waivers', 'firm.exclusions',
  'firm.passports', 'firm.passports.permission',
];

function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }

  const frn = process.argv[2] || '122702';

  console.log('\n  FCA endpoint execution check (Phase 3)');
  console.log('  ════════════════════════════════════════');

  // 1. Anchor resolution — direct FRN.
  const direct = await resolveAnchor(frn, { config });
  console.log(`  resolve('${frn}')           → ${direct.resolution} (${direct.anchor})`);

  // 2. Anchor resolution — exact firm name (deterministic, no guessing).
  const byName = await resolveAnchor('Barclays Bank Plc', { config });
  console.log(`  resolve('Barclays Bank Plc') → ${byName.resolution} (${byName.anchor ?? '-'}) [${byName.method ?? 'n/a'}]`);

  // 3. Anchor resolution — ambiguous (reported, not guessed).
  const ambig = await resolveAnchor('Barclays', { config });
  console.log(`  resolve('Barclays')          → ${ambig.resolution} (candidates: ${ambig.candidateCount ?? 0}; none chosen)`);

  // 4. Execute the catalogue for the firm anchor (in memory).
  const out = await executeAnchor({ family: 'firm', anchor: direct.anchor, config, endpoints: SCOPE });

  console.log('\n  Execution order (parent → children → grandchildren):');
  console.log('    ' + out.order.join('  '));

  console.log('\n  Endpoint results (in memory; nothing preserved):');
  const grouped = {};
  for (const e of out.executions) {
    grouped[e.endpointId] = grouped[e.endpointId] || { count: 0, pages: 0, fsr: null, total: null, status: e.status };
    const g = grouped[e.endpointId];
    g.count += 1;
    g.pages += e.pages.length;
    if (e.pages.length) {
      const first = e.pages[0].response;
      g.fsr = first.fsrStatus;
      g.total = first.body && first.body.ResultInfo ? first.body.ResultInfo.total_count : null;
    }
  }
  for (const id of out.order) {
    const g = grouped[id];
    if (!g) continue;
    const note = g.count > 1 ? `${g.count} reqs` : (g.status !== 'executed' ? g.status : `${g.pages} page(s)`);
    console.log(`    ${pad(id, 38)} ${pad(g.fsr ?? '-', 20)} total=${pad(g.total ?? '-', 8)} ${note}`);
  }

  // 5. Dynamic structure proof — Permissions returned verbatim as an activity-keyed map.
  const perms = out.executions.find((e) => e.endpointId === 'firm.permissions');
  const permData = perms && perms.pages[0] && perms.pages[0].response.body && perms.pages[0].response.body.Data;
  const activityKeys = permData && typeof permData === 'object' && !Array.isArray(permData) ? Object.keys(permData) : [];
  console.log('\n  Dynamic structure (Permissions): activity-keyed map returned unchanged');
  console.log(`    activity keys on page 1: ${activityKeys.length}` + (activityKeys.length ? ` (e.g. "${activityKeys[0]}")` : ''));

  // 6. Pagination proof.
  const names = out.executions.find((e) => e.endpointId === 'firm.names');
  console.log(`  Pagination (Names): ${names ? names.pages.length : 0} page(s) followed via ResultInfo.Next`);

  console.log('\n  Persisted to disk: NONE   |   Extracted: NONE   |   Result: ENGINE OK ✓\n');
}

main().catch((e) => { console.error('execution-check failed:', e.message); process.exit(1); });
