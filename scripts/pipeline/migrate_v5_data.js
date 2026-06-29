'use strict';
/**
 * Migration V5 — Data Backfill (DML only).
 *
 * Applies all data changes for Migration A items.
 * Requires migrate_v5.sql DDL to have been applied first.
 *
 * Steps:
 *   A2  — Backfill sector + subsector for FCA firms
 *   A3  — Seed FCA Investment Firms dataset record
 *   A4  — Link FCA prospects to dataset record
 *   A6  — Create FCA Investment Firms cohort record (cohort_code = '002')
 *   A7  — Link FCA prospects to cohort record
 *   FIX — Verify fca.js sector/subsector is correct (code fix is separate)
 *
 * Usage:
 *   node scripts/pipeline/migrate_v5_data.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const SECTOR    = 'financial-services';
const SUBSECTOR = 'investment-management';
const REGULATOR = 'FCA';

function step(label) {
  console.log('\n' + '─'.repeat(60));
  console.log(` ${label}`);
  console.log('─'.repeat(60));
}

function ok(msg)   { console.log('  ✓ ' + msg); }
function err(msg)  { console.log('  ✗ ' + msg); }
function info(msg) { console.log('  → ' + msg); }

async function checkColumnExists(table, column) {
  const { error } = await client.from(table).select(column).limit(1);
  if (!error) return true;
  // PostgREST returns this message when the column does not exist
  return !error.message.includes(`column ${table}.${column} does not exist`)
      && !error.message.includes(`"${column}" does not exist`)
      && !error.message.includes('does not exist');
}

async function checkTableExists(table) {
  const { error } = await client.from(table).select('id').limit(1);
  if (!error) return true;
  // PostgREST schema cache miss means table doesn't exist
  return !error.message.includes('schema cache')
      && !error.message.includes('does not exist');
}

// ── A2: Backfill sector + subsector for all FCA firms ─────────────────────────

async function stepA2() {
  step('A2 — Backfill sector + subsector for FCA firms');

  const subsectorExists = await checkColumnExists('prospects', 'subsector');
  if (!subsectorExists) {
    err('prospects.subsector column does not exist — run migrate_v5.sql DDL first');
    return false;
  }

  // Count before
  const { data: before } = await client
    .from('prospects')
    .select('sector, subsector')
    .eq('regulator', REGULATOR)
    .or('sector.is.null,sector.eq.');

  info(`FCA firms with missing sector before backfill: ${before?.length ?? 'unknown'}`);

  // Update sector + subsector
  const { error: ue } = await client
    .from('prospects')
    .update({ sector: SECTOR, subsector: SUBSECTOR, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR);

  if (ue) {
    err(`Update failed: ${ue.message}`);
    return false;
  }

  // Verify
  const { data: after, error: ae } = await client
    .from('prospects')
    .select('sector, subsector')
    .eq('regulator', REGULATOR)
    .not('sector', 'eq', SECTOR);

  if (ae) { err(`Verification query failed: ${ae.message}`); return false; }

  if (!after || after.length === 0) {
    ok(`All FCA firms now have sector='${SECTOR}', subsector='${SUBSECTOR}'`);
  } else {
    err(`${after.length} FCA firms still have incorrect sector after update`);
    return false;
  }
  return true;
}

// ── A3/A4: Seed FCA Investment Firms dataset record ───────────────────────────

async function stepA3A4() {
  step('A3/A4 — Seed FCA Investment Firms dataset record');

  const datasetsExists = await checkTableExists('datasets');
  if (!datasetsExists) {
    err('datasets table does not exist — run migrate_v5.sql DDL first');
    return null;
  }

  // Check if already seeded
  const { data: existing } = await client
    .from('datasets')
    .select('id, dataset_code')
    .eq('dataset_code', 'fca-investment-firms')
    .maybeSingle();

  if (existing) {
    ok(`Dataset record already exists — id: ${existing.id}`);
    return existing.id;
  }

  const { data: inserted, error: ie } = await client
    .from('datasets')
    .insert({
      dataset_code:         'fca-investment-firms',
      name:                 'FCA Investment Firms Register',
      source_owner:         'Financial Conduct Authority',
      sector:               SECTOR,
      subsector:            SUBSECTOR,
      regulator:            REGULATOR,
      download_url:         'https://register.fca.org.uk/s/search?type=ADV_SRCH&p=1',
      identifier_type:      'FRN (Firm Reference Number)',
      refresh_cadence:      'monthly',
      legal_basis:          'Public register — no licence restriction',
      first_acquired_at:    '2026-06-15',
      last_refreshed_at:    '2026-06-15',
      entity_count:         2430,
      website_coverage_pct: 83.6,
      status:               'active',
      notes:                'FCA Cohort 001. June 2026 snapshot. 2430 firms acquired, 1928 scanned. Mean score 65.9%.',
    })
    .select('id')
    .single();

  if (ie) {
    err(`Insert failed: ${ie.message}`);
    return null;
  }

  ok(`Dataset record created — id: ${inserted.id}`);
  return inserted.id;
}

// ── A5: Link FCA prospects to dataset record ──────────────────────────────────

async function stepA5(datasetId) {
  step('A5 — Link FCA prospects to dataset record');

  if (!datasetId) {
    err('No datasetId — skipping A5');
    return false;
  }

  const datasetIdExists = await checkColumnExists('prospects', 'dataset_id');
  if (!datasetIdExists) {
    err('prospects.dataset_id column does not exist — run migrate_v5.sql DDL first');
    return false;
  }

  const { error: ue } = await client
    .from('prospects')
    .update({ dataset_id: datasetId, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR)
    .is('dataset_id', null);

  if (ue) {
    err(`Update failed: ${ue.message}`);
    return false;
  }

  // Verify
  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('dataset_id')
      .eq('regulator', REGULATOR)
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const linked   = all.filter(r => r.dataset_id === datasetId).length;
  const unlinked = all.filter(r => !r.dataset_id).length;

  if (unlinked === 0) {
    ok(`${linked} FCA firms linked to dataset record`);
  } else {
    err(`${unlinked} FCA firms still have null dataset_id`);
    return false;
  }
  return true;
}

// ── A6: Create FCA Investment Firms cohort record ─────────────────────────────

async function stepA6(datasetId) {
  step('A6 — Create FCA Investment Firms cohort record');

  // Check if already exists
  const { data: existing } = await client
    .from('cohorts')
    .select('id, cohort_code')
    .eq('cohort_code', 'FCA-001')
    .maybeSingle();

  if (existing) {
    ok(`Cohort record already exists — id: ${existing.id}`);
    return existing.id;
  }

  const cohortRecord = {
    cohort_code:           'FCA-001',
    name:                  'FCA Investment Firms — Cohort 001',
    sector:                SECTOR,
    region:                'United Kingdom',
    target_size:           2430,
    data_sources:          ['fca-register', 'fca-api'],
    defined_at:            '2026-06-15',
    collection_started_at: '2026-06-15',
    collection_closed_at:  '2026-06-15',
    notes:                 'FCA Investment Firms Register, June 2026 snapshot. 2430 firms acquired via fca.js + fca-enrich.js. 1928 firms scanned. Mean score 65.9%. See BOARD_FCA_MILESTONE_15_JUNE_2026.md.',
  };

  // Add extended fields if columns exist (added by migrate_v5.sql)
  const regulatorExists   = await checkColumnExists('cohorts', 'regulator');
  const subsectorExists   = await checkColumnExists('cohorts', 'subsector');
  const datasetIdExists   = await checkColumnExists('cohorts', 'dataset_id');
  const entityCountExists = await checkColumnExists('cohorts', 'entity_count_actual');

  if (regulatorExists)   cohortRecord.regulator            = REGULATOR;
  if (subsectorExists)   cohortRecord.subsector            = SUBSECTOR;
  if (datasetIdExists && datasetId) cohortRecord.dataset_id = datasetId;
  if (entityCountExists) {
    cohortRecord.entity_count_actual  = 2430;
    cohortRecord.website_coverage_pct = 83.6;
    cohortRecord.mean_score           = 65.9;
    cohortRecord.scan_count           = 1928;
  }

  const { data: inserted, error: ie } = await client
    .from('cohorts')
    .insert(cohortRecord)
    .select('id')
    .single();

  if (ie) {
    err(`Insert failed: ${ie.message}`);
    return null;
  }

  ok(`Cohort record created — id: ${inserted.id} (cohort_code: FCA-001)`);
  return inserted.id;
}

// ── A7: Link FCA prospects to cohort ─────────────────────────────────────────

async function stepA7(cohortId) {
  step('A7 — Link FCA prospects to cohort record');

  if (!cohortId) {
    err('No cohortId — skipping A7');
    return false;
  }

  const { error: ue } = await client
    .from('prospects')
    .update({ cohort_id: cohortId, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR)
    .is('cohort_id', null);

  if (ue) {
    err(`Update failed: ${ue.message}`);
    return false;
  }

  // Paginated verify
  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('cohort_id')
      .eq('regulator', REGULATOR)
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const linked   = all.filter(r => r.cohort_id === cohortId).length;
  const unlinked = all.filter(r => !r.cohort_id).length;

  if (unlinked === 0) {
    ok(`${linked} FCA firms linked to cohort FCA-001`);
  } else {
    err(`${unlinked} FCA firms still have null cohort_id`);
    return false;
  }
  return true;
}

// ── Validation summary ────────────────────────────────────────────────────────

async function runValidation() {
  step('VALIDATION — Final state verification');

  // Detect which columns exist before building the select
  const hasSubsector = await checkColumnExists('prospects', 'subsector');
  const hasDatasetId = await checkColumnExists('prospects', 'dataset_id');

  const selectCols = [
    'regulator', 'sector', 'cohort_id',
    hasSubsector ? 'subsector' : null,
    hasDatasetId ? 'dataset_id' : null,
  ].filter(Boolean).join(', ');

  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select(selectCols)
      .range(from, from + PAGE - 1);
    if (error) { err('Validation query failed: ' + error.message); return; }
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const fca = all.filter(r => r.regulator === 'FCA');

  console.log(`\n  Columns present: sector ✓ | subsector ${hasSubsector ? '✓' : '✗ (DDL pending)'} | dataset_id ${hasDatasetId ? '✓' : '✗ (DDL pending)'}`);

  console.log('\n  Sector / Subsector breakdown:');
  const groups = {};
  all.forEach(r => {
    const sub = hasSubsector ? (r.subsector || 'NULL') : '(col missing)';
    const k = `  ${r.regulator || 'NULL'} | ${r.sector || 'NULL'} | ${sub}`;
    groups[k] = (groups[k] || 0) + 1;
  });
  Object.entries(groups).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  n=${v}  ${k}`));

  console.log('\n  FCA null audit:');
  console.log(`  sector null:     ${fca.filter(r=>!r.sector).length} of ${fca.length}`);
  console.log(`  subsector null:  ${fca.filter(r=>!r.subsector).length} of ${fca.length}`);
  console.log(`  cohort_id null:  ${fca.filter(r=>!r.cohort_id).length} of ${fca.length}`);
  console.log(`  dataset_id null: ${fca.filter(r=>!r.dataset_id).length} of ${fca.length}`);

  // Dataset register check
  const { data: datasets } = await client.from('datasets').select('dataset_code, name, entity_count, status');
  console.log('\n  Dataset register:');
  if (datasets && datasets.length) {
    datasets.forEach(d => console.log(`  [${d.status}] ${d.dataset_code} — ${d.name} (${d.entity_count} entities)`));
  } else {
    console.log('  (empty — datasets table missing or not seeded)');
  }

  // Cohort check — only select extended stats if the columns exist
  const hasCohortStats = await checkColumnExists('cohorts', 'entity_count_actual');
  const cohortCols = hasCohortStats
    ? 'cohort_code, name, sector, entity_count_actual, scan_count, mean_score'
    : 'cohort_code, name, sector';
  const { data: cohorts } = await client.from('cohorts').select(cohortCols);
  console.log('\n  Cohort register:');
  if (cohorts && cohorts.length) {
    cohorts.forEach(c => {
      const stats = c.entity_count_actual ? ` | ${c.entity_count_actual} entities | ${c.scan_count} scanned | mean ${c.mean_score}%` : '';
      console.log(`  [${c.cohort_code}] ${c.name} (${c.sector})${stats}`);
    });
  }

  // GO/NO-GO
  const nullSector   = fca.filter(r=>!r.sector).length;
  const nullSubsect  = fca.filter(r=>!r.subsector).length;
  const nullCohort   = fca.filter(r=>!r.cohort_id).length;
  const nullDataset  = fca.filter(r=>!r.dataset_id).length;
  const allGood      = nullSector === 0 && nullSubsect === 0 && nullCohort === 0 && nullDataset === 0;

  console.log('\n' + '═'.repeat(60));
  if (allGood) {
    console.log(' ✓ GO — FCA Cohort 001 fully governed. Ready for next acquisition.');
  } else {
    console.log(' ✗ NO-GO — Outstanding gaps:');
    if (nullSector  > 0) console.log(`   sector null:    ${nullSector}`);
    if (nullSubsect > 0) console.log(`   subsector null: ${nullSubsect} (DDL pending?)`);
    if (nullCohort  > 0) console.log(`   cohort_id null: ${nullCohort}`);
    if (nullDataset > 0) console.log(`   dataset_id null:${nullDataset} (DDL pending?)`);
  }
  console.log('═'.repeat(60) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log(' MIGRATION V5 DATA BACKFILL');
  console.log('═'.repeat(60));

  const a2ok      = await stepA2();
  const datasetId = await stepA3A4();
  const a5ok      = await stepA5(datasetId);
  const cohortId  = await stepA6(datasetId);
  const a7ok      = await stepA7(cohortId);

  await runValidation();
}

run().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
