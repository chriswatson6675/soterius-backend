'use strict';

// run-if001.js — COL-DOMAINREGISTRATION-001 IF-001 Full Cohort Run
//
// Reads the complete IF-001 cohort manifest (1,893 domains), runs the domain
// registration collector against every domain, persists observations to
// signal_domainregistration_v1, and prints a full cohort summary.
//
// Recommendation: run the pilot (run-if001-pilot.js) first to validate the
// pipeline against 50 domains before committing to the full cohort.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/domainregistration/run-if001.js
//
// Prerequisites:
//   Migration 017_signal_domainregistration_v1.sql applied in Supabase.
//   backend/.env present with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//   run-if001-pilot.js executed and results reviewed (ITA-DOMAINREGISTRATION-001).
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   RATE_DELAY_MS             — optional, default 500 (ms between requests)
//   CONCURRENCY               — optional, default 1 (sequential; increase carefully)
//   RUN_ID                    — optional UUID; set to resume a failed run
//
// NOTE: RDAP collection is rate-managed. Default concurrency is 1 (sequential).
// If you increase CONCURRENCY, ensure rate limits are not exceeded — each worker
// shares the same rate manager per registry.

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

const COHORT_CODE   = 'IF-001';
const RATE_DELAY_MS = Number(process.env.RATE_DELAY_MS ?? 500);
const CONCURRENCY   = Number(process.env.CONCURRENCY ?? 1);
const RUN_ID        = process.env.RUN_ID ?? randomUUID();
const MANIFEST_PATH = path.join(__dirname, '../../if001-full/cohort-manifest.json');

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

function loadFullCohort() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `IF-001 cohort manifest not found at ${MANIFEST_PATH}\n` +
      `Run backend/signal-lab/if001-full/select-cohort.js first.`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const firms = manifest.firms ?? [];

  if (firms.length === 0) {
    throw new Error('IF-001 cohort manifest contains no firms');
  }

  return { firms, manifest };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(i, total, domain, evidence, dbError) {
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

  const tld  = (evidence.tld_type ?? '----').slice(0, 4);
  const lock = evidence.transfer_lock_present === true  ? 'LOCK' :
               evidence.transfer_lock_present === false ? 'open' : '----';

  const dbTag = dbError ? ` [DB!]` : '';

  return `  [${pct}%] [${stateTag}] [${ps}] [${tld}] [${lock}] ${domain.padEnd(36)}${dbTag}`;
}

// ── Summary computation ───────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function computeSummary(results) {
  const n        = results.length;
  const observed = results.filter(r => r.evidence.endpoint_state === ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED);
  const no       = observed.length;

  const byState   = {};
  const byPrivacy = {};
  const byTld     = {};
  const dbErrors  = results.filter(r => r.dbError);
  const warnings  = results.filter(r => (r.warnings?.length ?? 0) > 0);

  for (const r of results) {
    const s = r.evidence.endpoint_state;
    byState[s] = (byState[s] ?? 0) + 1;
  }

  for (const r of observed) {
    const p = r.evidence.privacy_state ?? '(null)';
    byPrivacy[p] = (byPrivacy[p] ?? 0) + 1;
  }

  for (const r of results) {
    const t = r.evidence.tld_type ?? '(null)';
    byTld[t] = (byTld[t] ?? 0) + 1;
  }

  // Privacy adoption rate: denominator excludes REDACTED and ENTITY_ABSENT
  const psBase    = observed.filter(r => r.evidence.privacy_service_present !== null).length;
  const psPresent = observed.filter(r => r.evidence.privacy_service_present === true).length;

  // Transfer lock
  const lockBase    = observed.filter(r => r.evidence.transfer_lock_present !== null).length;
  const lockPresent = observed.filter(r => r.evidence.transfer_lock_present === true).length;

  // Domain active
  const activeBase    = observed.filter(r => r.evidence.domain_active !== null).length;
  const activePresent = observed.filter(r => r.evidence.domain_active === true).length;

  // Registrar distribution (top 15)
  const byRegistrar = {};
  for (const r of observed) {
    const name = r.evidence.registrar_name ?? '(null)';
    byRegistrar[name] = (byRegistrar[name] ?? 0) + 1;
  }

  // Privacy service provider distribution
  const byPsp = {};
  for (const r of observed.filter(r => r.evidence.privacy_state === 'PRIVACY_SERVICE')) {
    const id = r.evidence.privacy_service_provider_id ?? '(null)';
    byPsp[id] = (byPsp[id] ?? 0) + 1;
  }

  // Country code distribution (registrant)
  const byCountry = {};
  for (const r of observed.filter(r => r.evidence.registrant_country_code)) {
    const cc = r.evidence.registrant_country_code;
    byCountry[cc] = (byCountry[cc] ?? 0) + 1;
  }

  // Domain age buckets
  const ageRows  = observed.filter(r => r.evidence.domain_age_days != null);
  const under1yr = ageRows.filter(r => r.evidence.domain_age_days < 365).length;
  const yr1to5   = ageRows.filter(r => r.evidence.domain_age_days >= 365 && r.evidence.domain_age_days < 1825).length;
  const yr5to10  = ageRows.filter(r => r.evidence.domain_age_days >= 1825 && r.evidence.domain_age_days < 3650).length;
  const over10yr = ageRows.filter(r => r.evidence.domain_age_days >= 3650).length;

  // Expiry buckets
  const expRows      = observed.filter(r => r.evidence.expiry_days_remaining != null);
  const expired      = expRows.filter(r => r.evidence.expiry_days_remaining < 0).length;
  const expUnder90   = expRows.filter(r => r.evidence.expiry_days_remaining >= 0 && r.evidence.expiry_days_remaining < 90).length;
  const expUnder365  = expRows.filter(r => r.evidence.expiry_days_remaining >= 90 && r.evidence.expiry_days_remaining < 365).length;
  const expOver365   = expRows.filter(r => r.evidence.expiry_days_remaining >= 365).length;

  return {
    n, no, byState, byPrivacy, byTld,
    dbErrors: dbErrors.length, dbErrorDomains: dbErrors.map(r => ({ domain: r.domain, error: r.dbError?.message })),
    warnings: warnings.length,
    psBase, psPresent, lockBase, lockPresent, activeBase, activePresent,
    byRegistrar, byPsp, byCountry,
    ageRows: ageRows.length, under1yr, yr1to5, yr5to10, over10yr,
    expRows: expRows.length, expired, expUnder90, expUnder365, expOver365,
  };
}

function printSummary(s, startedAt, runId) {
  const HR  = '═'.repeat(76);
  const DIV = '─'.repeat(76);

  console.log(`\n${HR}`);
  console.log(` COL-DOMAINREGISTRATION-001 — IF-001 FULL COHORT SUMMARY`);
  console.log(` Signal: SOT-DOMAINREGISTRATION-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Cohort: ${COHORT_CODE}   n=${s.n}`);
  console.log(` Completed: ${new Date().toISOString()}`);
  console.log(` Run ID: ${runId}`);
  if (s.dbErrors > 0) {
    console.log(` WARNING: ${s.dbErrors} DB write error(s) — retry with RUN_ID=${runId}`);
  }
  console.log(HR);

  // 1. Endpoint state
  console.log('\n 1. ENDPOINT STATE DISTRIBUTION\n');
  for (const state of Object.values(ENDPOINT_STATES)) {
    const count = s.byState[state] ?? 0;
    if (count > 0) {
      const bar = '█'.repeat(Math.round((count / s.n) * 30));
      console.log(`    ${state.padEnd(26)}: ${String(count).padStart(4)}   ${pct(count, s.n)}  ${bar}`);
    }
  }
  console.log(`\n    RDAP collection base: ${s.no} of ${s.n} domains`);

  // 2. Privacy state
  console.log(`\n${DIV}`);
  console.log(`\n 2. PRIVACY STATE DISTRIBUTION  (${s.no} RDAP_RESPONSE_OBSERVED domains)\n`);
  for (const state of ['REGISTRANT_DATA', 'PRIVACY_SERVICE', 'REDACTED', 'ENTITY_ABSENT']) {
    const count = s.byPrivacy[state] ?? 0;
    const bar   = '█'.repeat(Math.round((count / s.no) * 30));
    console.log(`    ${state.padEnd(20)}: ${String(count).padStart(4)}   ${pct(count, s.no)}  ${bar}`);
  }

  // Privacy adoption rate (correct denominator)
  const psRate = s.psBase > 0 ? ((s.psPresent / s.psBase) * 100).toFixed(1) : 'N/A';
  console.log(`\n    Privacy adoption rate : ${psRate}%  (${s.psPresent}/${s.psBase} where privacy_service_present IS NOT NULL)`);

  // 3. TLD type
  console.log(`\n${DIV}`);
  console.log(`\n 3. TLD TYPE DISTRIBUTION  (${s.n} all domains)\n`);
  for (const type of ['GTLD', 'CCTLD', 'NEW_GTLD', 'SPONSORED', 'UNKNOWN']) {
    const count = s.byTld[type] ?? 0;
    if (count > 0) {
      console.log(`    ${type.padEnd(12)}: ${String(count).padStart(4)}   ${pct(count, s.n)}`);
    }
  }

  // 4. Domain age buckets
  console.log(`\n${DIV}`);
  console.log(`\n 4. DOMAIN AGE DISTRIBUTION  (${s.ageRows} domains with creation_date)\n`);
  console.log(`    Under 1 year      : ${String(s.under1yr).padStart(4)}   ${pct(s.under1yr, s.ageRows)}`);
  console.log(`    1–5 years         : ${String(s.yr1to5).padStart(4)}   ${pct(s.yr1to5, s.ageRows)}`);
  console.log(`    5–10 years        : ${String(s.yr5to10).padStart(4)}   ${pct(s.yr5to10, s.ageRows)}`);
  console.log(`    Over 10 years     : ${String(s.over10yr).padStart(4)}   ${pct(s.over10yr, s.ageRows)}`);

  // 5. Expiry
  console.log(`\n${DIV}`);
  console.log(`\n 5. DOMAIN EXPIRY DISTRIBUTION  (${s.expRows} domains with expiration_date)\n`);
  console.log(`    Already expired (< 0d) : ${String(s.expired).padStart(4)}   ${pct(s.expired, s.expRows)}`);
  console.log(`    Expiring < 90 days     : ${String(s.expUnder90).padStart(4)}   ${pct(s.expUnder90, s.expRows)}`);
  console.log(`    Expiring 90–365 days   : ${String(s.expUnder365).padStart(4)}   ${pct(s.expUnder365, s.expRows)}`);
  console.log(`    Expiring > 365 days    : ${String(s.expOver365).padStart(4)}   ${pct(s.expOver365, s.expRows)}`);

  // 6. Transfer lock and domain active
  console.log(`\n${DIV}`);
  console.log(`\n 6. STATUS FLAGS  (RDAP_RESPONSE_OBSERVED, non-null denominator)\n`);
  const lockRate   = s.lockBase   > 0 ? ((s.lockPresent   / s.lockBase)   * 100).toFixed(1) : 'N/A';
  const activeRate = s.activeBase > 0 ? ((s.activePresent / s.activeBase) * 100).toFixed(1) : 'N/A';
  console.log(`    Transfer lock   : ${lockRate.padStart(5)}%  (${s.lockPresent}/${s.lockBase})`);
  console.log(`    Domain active   : ${activeRate.padStart(5)}%  (${s.activePresent}/${s.activeBase})`);

  // 7. Top registrars
  console.log(`\n${DIV}`);
  console.log(`\n 7. TOP REGISTRARS  (${s.no} RDAP_RESPONSE_OBSERVED domains)\n`);
  const topRegistrars = Object.entries(s.byRegistrar).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [name, count] of topRegistrars) {
    const label = name.length > 45 ? name.slice(0, 44) + '…' : name;
    console.log(`    ${String(count).padStart(4)}   ${pct(count, s.no)}   ${label}`);
  }

  // 8. Privacy service provider distribution
  const psCount = Object.values(s.byPsp).reduce((a, b) => a + b, 0);
  if (psCount > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n 8. PRIVACY SERVICE PROVIDERS  (${psCount} PRIVACY_SERVICE domains)\n`);
    for (const [id, count] of Object.entries(s.byPsp).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${id.padEnd(10)}: ${String(count).padStart(4)}   ${pct(count, psCount)}`);
    }
  }

  // 9. Registrant country distribution
  const ccCount = Object.values(s.byCountry).reduce((a, b) => a + b, 0);
  if (ccCount > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n 9. REGISTRANT COUNTRY DISTRIBUTION  (${ccCount} domains with country code)\n`);
    const topCountries = Object.entries(s.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [cc, count] of topCountries) {
      console.log(`    ${cc.padEnd(6)}: ${String(count).padStart(4)}   ${pct(count, ccCount)}`);
    }
  }

  // 10. DB errors
  if (s.dbErrors > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n10. DB WRITE ERRORS  (${s.dbErrors} domains — retry with RUN_ID=${runId})\n`);
    for (const { domain, error } of s.dbErrorDomains) {
      console.log(`    • ${domain}  [${(error ?? '').slice(0, 60)}]`);
    }
  }

  console.log(`\n${HR}`);
  console.log(` Run ID: ${runId}`);
  console.log(` Register this run in SLG-003 if results are accepted.`);
  console.log(`${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(76);
  const startedAt = Date.now();

  console.log(`\n${HR}`);
  console.log(` COL-DOMAINREGISTRATION-001 — IF-001 FULL COHORT RUN`);
  console.log(` SOT-DOMAINREGISTRATION-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Cohort      : ${COHORT_CODE}`);
  console.log(` Rate delay  : ${RATE_DELAY_MS}ms`);
  console.log(` Concurrency : ${CONCURRENCY}`);
  console.log(` Run ID      : ${RUN_ID}`);
  console.log(` Started     : ${new Date().toISOString()}`);
  console.log(HR);

  // Load cohort
  const { firms, manifest } = loadFullCohort();
  console.log(`\n  Cohort: ${manifest.cohort_id} — ${manifest.cohort_name}`);
  console.log(`  Domains: ${firms.length}\n`);

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

  // Initialise run context
  console.log('  Initialising run context...');
  const ctx = await initialiseRunContext({ defaultRateDelayMs: RATE_DELAY_MS });
  console.log(`  Bootstrap: ${ctx.bootstrapCache.tldMap.size} TLD entries`);
  console.log(`  PSP index: ${ctx.pspIndex.byProviderName.size} providers (v${ctx.pspIndex.version})\n`);

  // Collection header
  const DIV = '─'.repeat(76);
  console.log(DIV);
  console.log(` Collecting ${firms.length} domains   concurrency: ${CONCURRENCY}   rate: ${RATE_DELAY_MS}ms`);
  console.log(` Columns: [%] [endpoint] [privacy] [tld] [lock] [domain]`);
  console.log(DIV + '\n');

  const rows = await runWithConcurrency(
    firms,
    async (firm, i) => {
      const domain = firm.domain;
      const result = await collectDomainRegistrationSignal(domain, ctx);
      const { error: dbError } = await persistObservation(supabase, RUN_ID, domain, result.evidence);

      process.stdout.write(progressLine(i, firms.length, domain, result.evidence, dbError) + '\n');

      return { domain, firmName: firm.firm_name, evidence: result.evidence, warnings: result.warnings, dbError };
    },
    CONCURRENCY,
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n  Completed: ${firms.length} domains in ${elapsed}s`);

  const summary = computeSummary(rows);
  printSummary(summary, startedAt, RUN_ID);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
