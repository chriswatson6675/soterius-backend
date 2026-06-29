'use strict';

// run-if001-pilot.js — COL-DOMAINREGISTRATION-001 IF-001 Pilot Run (50 domains)
//
// Reads the first 50 domains from the IF-001 cohort manifest, runs the domain
// registration collector against each, persists observations to
// signal_domainregistration_v1, and prints a pilot summary.
//
// Purpose: Validate collection pipeline, RDAP coverage, and rate management
// before committing to the full 1,893-domain IF-001 run.
// Recommended 50-domain pilot per ITA-DOMAINREGISTRATION-001.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/domainregistration/run-if001-pilot.js
//
// Prerequisites:
//   Migration 017_signal_domainregistration_v1.sql applied in Supabase.
//   backend/.env present with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   PILOT_SIZE                — optional, default 50
//   RATE_DELAY_MS             — optional, default 500 (ms between requests)
//   RUN_ID                    — optional UUID; omit to generate fresh

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const path           = require('node:path');
const fs             = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const {
  collectDomainRegistrationSignal,
  persistObservation,
  initialiseRunContext,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  TABLE_NAME,
  ENDPOINT_STATES,
} = require('./domainregistration-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE    = 'IF-001';
const PILOT_SIZE     = Number(process.env.PILOT_SIZE ?? 50);
const RATE_DELAY_MS  = Number(process.env.RATE_DELAY_MS ?? 500);
const RUN_ID         = process.env.RUN_ID ?? randomUUID();
const MANIFEST_PATH  = path.join(__dirname, '../../if001-full/cohort-manifest.json');

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
  return createClient(url, key);
}

// ── Cohort loading ────────────────────────────────────────────────────────────

function loadPilotCohort() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `IF-001 cohort manifest not found at ${MANIFEST_PATH}\n` +
      `Run backend/signal-lab/if001-full/select-cohort.js first.`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const all      = manifest.firms ?? [];

  if (all.length === 0) {
    throw new Error('IF-001 cohort manifest contains no firms');
  }

  const pilot = all.slice(0, PILOT_SIZE);
  return { pilot, total: all.length, manifest };
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(i, total, domain, firmName, evidence, dbError) {
  const pct   = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const state = evidence.endpoint_state;

  const stateTag = {
    RDAP_RESPONSE_OBSERVED: 'RDAP ',
    DOMAIN_NOT_FOUND:       '404  ',
    RDAP_ERROR:             'ERR  ',
    RDAP_NOT_SUPPORTED:     'NSUP ',
    CONNECTION_ERROR:       'CONN!',
  }[state] ?? state.slice(0, 5);

  const ps = evidence.privacy_state
    ? evidence.privacy_state.slice(0, 4)
    : '----';

  const age = evidence.domain_age_days != null
    ? `${evidence.domain_age_days}d`
    : '--';

  const dbTag = dbError ? ` [DB:${(dbError.message ?? '').slice(0, 20)}]` : '';

  const nameLabel = (firmName ?? domain).slice(0, 28).padEnd(28);

  return `  [${pct}%] [${stateTag}] [${ps}] ${nameLabel} ${domain.padEnd(32)} age:${age}${dbTag}`;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(results, startedAt, runId) {
  const HR  = '═'.repeat(72);
  const DIV = '─'.repeat(72);
  const n   = results.length;

  const byState = {};
  for (const r of results) {
    const s = r.evidence.endpoint_state;
    byState[s] = (byState[s] ?? 0) + 1;
  }

  const observed = results.filter(r => r.evidence.endpoint_state === ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED);
  const no = observed.length;

  const byPrivacy = {};
  for (const r of observed) {
    const p = r.evidence.privacy_state ?? '(null)';
    byPrivacy[p] = (byPrivacy[p] ?? 0) + 1;
  }

  const byTldType = {};
  for (const r of results) {
    const t = r.evidence.tld_type ?? '(null)';
    byTldType[t] = (byTldType[t] ?? 0) + 1;
  }

  const dbErrors    = results.filter(r => r.dbError).length;
  const warnings    = results.filter(r => (r.warnings?.length ?? 0) > 0).length;
  const elapsed     = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n${HR}`);
  console.log(` COL-DOMAINREGISTRATION-001 — IF-001 PILOT SUMMARY`);
  console.log(` Signal: SOT-DOMAINREGISTRATION-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Cohort: ${COHORT_CODE}   Pilot size: ${n}   Run ID: ${runId}`);
  console.log(` Completed: ${new Date().toISOString()}   Elapsed: ${elapsed}s`);
  console.log(HR);

  console.log('\n 1. ENDPOINT STATE DISTRIBUTION\n');
  const stateOrder = Object.values(ENDPOINT_STATES);
  for (const state of stateOrder) {
    const count = byState[state] ?? 0;
    if (count > 0 || state === ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED) {
      console.log(`    ${state.padEnd(26)}: ${String(count).padStart(4)}   ${pct(count, n)}`);
    }
  }
  console.log(`\n    RDAP collection base: ${no} domains`);

  console.log(`\n${DIV}`);
  console.log('\n 2. PRIVACY STATE DISTRIBUTION  (RDAP_RESPONSE_OBSERVED only)\n');
  const privacyOrder = ['REGISTRANT_DATA', 'PRIVACY_SERVICE', 'REDACTED', 'ENTITY_ABSENT'];
  for (const state of privacyOrder) {
    const count = byPrivacy[state] ?? 0;
    console.log(`    ${state.padEnd(20)}: ${String(count).padStart(4)}   ${pct(count, no)}`);
  }

  const psPresent = observed.filter(r => r.evidence.privacy_service_present === true).length;
  if (no > 0) {
    console.log(`\n    Privacy adoption rate: ${((psPresent / no) * 100).toFixed(1)}%  (${psPresent}/${no} RDAP_RESPONSE_OBSERVED)`);
    console.log(`    (denominator: WHERE privacy_service_present IS NOT NULL, excluding REDACTED+ENTITY_ABSENT)`);
  }

  console.log(`\n${DIV}`);
  console.log('\n 3. TLD TYPE DISTRIBUTION  (all domains)\n');
  const tldOrder = ['GTLD', 'CCTLD', 'NEW_GTLD', 'SPONSORED', 'UNKNOWN'];
  for (const type of tldOrder) {
    const count = byTldType[type] ?? 0;
    if (count > 0) {
      console.log(`    ${type.padEnd(12)}: ${String(count).padStart(4)}   ${pct(count, n)}`);
    }
  }

  console.log(`\n${DIV}`);
  console.log('\n 4. REGISTRAR DISTRIBUTION  (RDAP_RESPONSE_OBSERVED only)\n');
  const registrarCounts = {};
  for (const r of observed) {
    const name = r.evidence.registrar_name ?? '(null)';
    const key  = name.length > 40 ? name.slice(0, 39) + '…' : name;
    registrarCounts[key] = (registrarCounts[key] ?? 0) + 1;
  }
  const topRegistrars = Object.entries(registrarCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [name, count] of topRegistrars) {
    console.log(`    ${String(count).padStart(4)}   ${pct(count, no)}   ${name}`);
  }

  if (dbErrors > 0 || warnings > 0) {
    console.log(`\n${DIV}`);
    console.log('\n 5. ERRORS AND WARNINGS\n');
    if (dbErrors > 0) {
      console.log(`    DB write errors: ${dbErrors}`);
      for (const r of results.filter(r => r.dbError)) {
        console.log(`      • ${r.domain}  [${(r.dbError.message ?? '').slice(0, 50)}]`);
      }
    }
    if (warnings > 0) {
      console.log(`    Collection warnings (multiple same-role entities): ${warnings}`);
    }
  }

  console.log(`\n${HR}`);
  console.log(` Run ID: ${runId}`);
  console.log(` Register this run in SLG-003 if results are accepted.\n`);
  console.log(HR + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(72);
  const startedAt = Date.now();

  console.log(`\n${HR}`);
  console.log(` COL-DOMAINREGISTRATION-001 — IF-001 PILOT RUN`);
  console.log(` SOT-DOMAINREGISTRATION-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Pilot size  : ${PILOT_SIZE} domains`);
  console.log(` Rate delay  : ${RATE_DELAY_MS}ms`);
  console.log(` Run ID      : ${RUN_ID}`);
  console.log(` Started     : ${new Date().toISOString()}`);
  console.log(HR);

  // Load cohort
  const { pilot, total, manifest } = loadPilotCohort();
  console.log(`\n  Manifest: ${manifest.cohort_id} — ${manifest.cohort_name}`);
  console.log(`  Total firms in manifest: ${total}`);
  console.log(`  Pilot selection: first ${pilot.length} firms\n`);

  // Supabase pre-flight
  const supabase = getClient();
  const { error: pingErr } = await supabase.from(TABLE_NAME).select('id').limit(1);
  if (pingErr) {
    const missing = pingErr.message?.includes('does not exist') || pingErr.code === '42P01';
    if (missing) {
      console.error(`\n  ERROR: ${TABLE_NAME} table not found.`);
      console.error(`  Apply backend/db/migrations/017_signal_domainregistration_v1.sql in Supabase first.\n`);
    } else {
      console.error(`\n  ERROR: Supabase — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log(`  Supabase: ${TABLE_NAME} ✓\n`);

  // Initialise run context (loads bootstrap, PSP index, TLD snapshot)
  console.log('  Initialising run context...');
  const ctx = await initialiseRunContext({ defaultRateDelayMs: RATE_DELAY_MS });
  console.log(`  Bootstrap: ${ctx.bootstrapCache.tldMap.size} TLD entries loaded`);
  console.log(`  PSP index: ${ctx.pspIndex.byProviderName.size} providers (v${ctx.pspIndex.version})\n`);

  // Collection header
  const DIV = '─'.repeat(72);
  console.log(DIV);
  console.log(` Collecting ${pilot.length} pilot domains — sequential (rate-managed at ${RATE_DELAY_MS}ms)`);
  console.log(` Columns: [endpoint] [privacy] [firm name] [domain] [age]`);
  console.log(DIV + '\n');

  // Sequential collection (rate-managed RDAP — no concurrency in pilot)
  const results = [];
  for (let i = 0; i < pilot.length; i++) {
    const firm   = pilot[i];
    const domain = firm.domain;

    const result   = await collectDomainRegistrationSignal(domain, ctx);
    const { error: dbError } = await persistObservation(supabase, RUN_ID, domain, result.evidence);

    results.push({ domain, firmName: firm.firm_name, evidence: result.evidence, warnings: result.warnings, dbError });

    console.log(progressLine(i, pilot.length, domain, firm.firm_name, result.evidence, dbError));
  }

  console.log('');
  printSummary(results, startedAt, RUN_ID);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
