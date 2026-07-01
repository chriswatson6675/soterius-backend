'use strict';
/**
 * HE-001 Data Governance — set subsector, seed dataset + cohort records, link prospects.
 *
 * Steps:
 *   B1 — Set subsector = 'university' for all OfS prospects
 *   B2 — Seed ofs-higher-education dataset record
 *   B3 — Link OfS prospects to dataset record (dataset_id)
 *   B4 — Create HE-001 cohort record
 *   B5 — Link OfS prospects to cohort record (cohort_id)
 *
 * Idempotent — skips inserts if records already exist.
 *
 * Usage:
 *   node scripts/pipeline/migrate_he_data.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const SECTOR      = 'higher-education';
const SUBSECTOR   = 'university';
const REGULATOR   = 'OfS';
const TODAY       = new Date().toISOString().slice(0, 10);

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
  return !error.message.includes(`column ${table}.${column} does not exist`)
      && !error.message.includes(`"${column}" does not exist`)
      && !error.message.includes('does not exist');
}

// ── B1: Set subsector for all OfS prospects ───────────────────────────────────

async function stepB1() {
  step('B1 — Set subsector for all OfS prospects');

  const subsectorExists = await checkColumnExists('prospects', 'subsector');
  if (!subsectorExists) {
    err('prospects.subsector column does not exist — run 005_dataset_governance.sql DDL first');
    return false;
  }

  const { data: before } = await client
    .from('prospects')
    .select('id')
    .eq('regulator', REGULATOR)
    .or('subsector.is.null,subsector.eq.');

  info(`OfS prospects with missing subsector: ${before?.length ?? 'unknown'}`);

  const { error: ue } = await client
    .from('prospects')
    .update({ subsector: SUBSECTOR, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR);

  if (ue) { err(`Update failed: ${ue.message}`); return false; }

  const { data: after } = await client
    .from('prospects')
    .select('id')
    .eq('regulator', REGULATOR)
    .not('subsector', 'eq', SUBSECTOR);

  if (!after || after.length === 0) {
    ok(`All OfS prospects now have subsector='${SUBSECTOR}'`);
    return true;
  }
  err(`${after.length} OfS prospects still have incorrect subsector`);
  return false;
}

// ── B2: Seed ofs-higher-education dataset record ──────────────────────────────

async function stepB2() {
  step('B2 — Seed ofs-higher-education dataset record');

  const { data: existing } = await client
    .from('datasets')
    .select('id, dataset_code')
    .eq('dataset_code', 'ofs-higher-education')
    .maybeSingle();

  if (existing) {
    ok(`Dataset record already exists — id: ${existing.id}`);
    return existing.id;
  }

  const { data: inserted, error: ie } = await client
    .from('datasets')
    .insert({
      dataset_code:         'ofs-higher-education',
      name:                 'UK Higher Education Providers — data.ac.uk',
      source_owner:         'Jisc / data.ac.uk',
      sector:               SECTOR,
      subsector:            SUBSECTOR,
      regulator:            REGULATOR,
      download_url:         'https://learning-provider.data.ac.uk/data/learning-providers-plus.csv',
      identifier_type:      'UKPRN (UK Provider Reference Number)',
      refresh_cadence:      'ad-hoc',
      legal_basis:          'Open data — no licence restriction',
      first_acquired_at:    TODAY,
      last_refreshed_at:    TODAY,
      entity_count:         166,
      website_coverage_pct: 100.0,
      status:               'active',
      notes:                'HE-001 cohort. 166 UK universities and specialist HE institutions. Source: learning-provider.data.ac.uk.',
    })
    .select('id')
    .single();

  if (ie) { err(`Insert failed: ${ie.message}`); return null; }

  ok(`Dataset record created — id: ${inserted.id}`);
  return inserted.id;
}

// ── B3: Link OfS prospects to dataset record ──────────────────────────────────

async function stepB3(datasetId) {
  step('B3 — Link OfS prospects to dataset record');

  if (!datasetId) { err('No datasetId — skipping B3'); return false; }

  const datasetIdExists = await checkColumnExists('prospects', 'dataset_id');
  if (!datasetIdExists) {
    err('prospects.dataset_id column does not exist — run 005_dataset_governance.sql DDL first');
    return false;
  }

  const { error: ue } = await client
    .from('prospects')
    .update({ dataset_id: datasetId, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR)
    .is('dataset_id', null);

  if (ue) { err(`Update failed: ${ue.message}`); return false; }

  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('dataset_id')
      .eq('regulator', REGULATOR)
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const unlinked = all.filter(r => !r.dataset_id).length;
  if (unlinked === 0) {
    ok(`${all.length} OfS prospects linked to dataset record`);
    return true;
  }
  err(`${unlinked} OfS prospects still have null dataset_id`);
  return false;
}

// ── B4: Create HE-001 cohort record ──────────────────────────────────────────

async function stepB4(datasetId) {
  step('B4 — Create HE-001 cohort record');

  const { data: existing } = await client
    .from('cohorts')
    .select('id, cohort_code')
    .eq('cohort_code', 'HE-001')
    .maybeSingle();

  if (existing) {
    ok(`Cohort record already exists — id: ${existing.id}`);
    return existing.id;
  }

  const cohortRecord = {
    cohort_code:           'HE-001',
    name:                  'UK Higher Education Providers — Cohort 002',
    sector:                SECTOR,
    region:                'United Kingdom',
    target_size:           166,
    data_sources:          ['ofs-register'],
    defined_at:            TODAY,
    collection_started_at: TODAY,
    notes:                 'Source: data.ac.uk learning-providers-plus.csv. 166 universities and specialist HE institutions.',
  };

  const regulatorExists   = await checkColumnExists('cohorts', 'regulator');
  const subsectorExists   = await checkColumnExists('cohorts', 'subsector');
  const datasetIdExists   = await checkColumnExists('cohorts', 'dataset_id');
  const entityCountExists = await checkColumnExists('cohorts', 'entity_count_actual');

  if (regulatorExists)  cohortRecord.regulator  = REGULATOR;
  if (subsectorExists)  cohortRecord.subsector  = SUBSECTOR;
  if (datasetIdExists && datasetId) cohortRecord.dataset_id = datasetId;
  if (entityCountExists) {
    cohortRecord.entity_count_actual  = 166;
    cohortRecord.website_coverage_pct = 100.0;
  }

  const { data: inserted, error: ie } = await client
    .from('cohorts')
    .insert(cohortRecord)
    .select('id')
    .single();

  if (ie) { err(`Insert failed: ${ie.message}`); return null; }

  ok(`Cohort record created — id: ${inserted.id}`);
  return inserted.id;
}

// ── B5: Link OfS prospects to cohort ─────────────────────────────────────────

async function stepB5(cohortId) {
  step('B5 — Link OfS prospects to cohort HE-001');

  if (!cohortId) { err('No cohortId — skipping B5'); return false; }

  const { error: ue } = await client
    .from('prospects')
    .update({ cohort_id: cohortId, updated_at: new Date().toISOString() })
    .eq('regulator', REGULATOR)
    .is('cohort_id', null);

  if (ue) { err(`Update failed: ${ue.message}`); return false; }

  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('cohort_id')
      .eq('regulator', REGULATOR)
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const unlinked = all.filter(r => !r.cohort_id).length;
  if (unlinked === 0) {
    ok(`${all.length} OfS prospects linked to cohort HE-001`);
    return true;
  }
  err(`${unlinked} OfS prospects still have null cohort_id`);
  return false;
}

// ── Validation ────────────────────────────────────────────────────────────────

async function runValidation() {
  step('VALIDATION — Final state');

  const PAGE = 1000; let all = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('sector, subsector, cohort_id, dataset_id, pipeline_status')
      .eq('regulator', REGULATOR)
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\n  Total OfS prospects         : ${all.length}`);
  console.log(`  sector = higher-education   : ${all.filter(r => r.sector === SECTOR).length}`);
  console.log(`  subsector = university      : ${all.filter(r => r.subsector === SUBSECTOR).length}`);
  console.log(`  cohort_id linked            : ${all.filter(r => r.cohort_id).length}`);
  console.log(`  dataset_id linked           : ${all.filter(r => r.dataset_id).length}`);
  console.log(`  pending_validate (ready)    : ${all.filter(r => r.pipeline_status === 'pending_validate').length}`);

  const nullCohort  = all.filter(r => !r.cohort_id).length;
  const nullDataset = all.filter(r => !r.dataset_id).length;
  const allGood     = all.length === 166 && nullCohort === 0 && nullDataset === 0;

  console.log('\n' + '═'.repeat(60));
  if (allGood) {
    console.log(' ✓ GO — HE-001 governance complete. 166 prospects linked.');
  } else {
    console.log(' ✗ NO-GO:');
    if (all.length !== 166) console.log(`   OfS count:       ${all.length} (expected 166)`);
    if (nullCohort > 0)     console.log(`   cohort_id null:  ${nullCohort}`);
    if (nullDataset > 0)    console.log(`   dataset_id null: ${nullDataset}`);
  }
  console.log('═'.repeat(60) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log(' HE-001 DATA GOVERNANCE');
  console.log('═'.repeat(60));

  const b1ok      = await stepB1();
  const datasetId = await stepB2();
  const b3ok      = await stepB3(datasetId);
  const cohortId  = await stepB4(datasetId);
  const b5ok      = await stepB5(cohortId);

  await runValidation();
}

run().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
