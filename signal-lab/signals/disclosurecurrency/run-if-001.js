'use strict';

// run-if-001.js — SOT-DISCLOSURECURRENCY-001 (H-SIG-001) IF-001 Full Cohort Run
//
// Reads the IF-001 cohort manifest (1,893 firms), deduplicates to unique domains,
// runs the FROZEN Disclosure Currency collector + detector against each unique
// domain, persists one observation per unique domain to signal_disclosurecurrency_v1,
// and prints a cohort summary with an integrity check.
//
// Signal Lab rule: records observations only. No scores. No ratings.
// EM-H-D1: evidence_state is set ONLY when located_state = 'located' (also enforced
// by the DB CHECK constraint evidence_only_when_located).
//
// Usage:
//   node backend/signal-lab/signals/disclosurecurrency/run-if-001.js
//
// Prerequisites:
//   Migration 019_signal_lab_disclosurecurrency.sql applied in Supabase.
//   backend/.env present with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   CONCURRENCY               — optional, default 5
//   RUN_ID                    — optional UUID; set to resume/label a run
//   LIMIT                     — optional; cap unique domains (pilot)

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Frozen collector + detector (unchanged) ─────────────────────────────────────
const { discoverPolicy } = require('./policy-discovery');
const { retrievePolicy, closeBrowser } = require('./policy-retrieval');
const { detectCurrency } = require('./detect-currency');
const { deriveEvidenceState, sha256 } = require('./observation-writer');

// ── Configuration ───────────────────────────────────────────────────────────────
const COHORT_CODE        = 'IF-001';
const SIGNAL_ID          = 'SOT-DISCLOSURECURRENCY-001';
const SIGNAL_VERSION     = 1;
const COLLECTOR_VERSION  = 'hsig001-collector-1.0.0';
const ELEMENT_SET_VERSION = 'pad-v1';
const TABLE_NAME         = 'signal_disclosurecurrency_v1';
const CONCURRENCY        = Number(process.env.CONCURRENCY ?? 5);
const RUN_ID             = process.env.RUN_ID ?? randomUUID();
const LIMIT              = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const MANIFEST_PATH      = path.join(__dirname, '../../if001-full/cohort-manifest.json');

// ── Supabase client ─────────────────────────────────────────────────────────────
function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
  return createClient(url, key);
}

// ── Cohort loading + domain deduplication ───────────────────────────────────────
function loadUniqueDomains() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`IF-001 cohort manifest not found at ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const firms = manifest.firms ?? [];
  if (firms.length === 0) throw new Error('IF-001 cohort manifest contains no firms');

  const seen = new Set();
  const domains = [];
  for (const f of firms) {
    const d = (f.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (d && !seen.has(d)) { seen.add(d); domains.push(d); }
  }
  return { firmCount: firms.length, domains };
}

// ── Content extraction (matches collector's detector input) ─────────────────────
function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Build a production row (signal_disclosurecurrency_v1) ────────────────────────
function buildRow(domain, locatedState, discovery, retrieval, detectorResult, contentObserved) {
  const ev = deriveEvidenceState(locatedState, detectorResult); // EM-H-D1 routing (frozen)
  return {
    run_id: RUN_ID,
    domain,
    signal_version: SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,
    element_set_version: ELEMENT_SET_VERSION,
    located_state: locatedState,
    evidence_state: ev.evidence_state,
    currency_raw_value: ev.currency_raw_value,
    currency_form: ev.currency_form,
    policy_url: (retrieval && retrieval.finalUrl) || (discovery && discovery.policyUrl) || null,
    retrieval_method: (retrieval && retrieval.retrievalMethod) || null,
    http_status: retrieval && retrieval.httpStatus != null ? retrieval.httpStatus : null,
    content_hash: sha256(contentObserved),
    content_observed: contentObserved || null,
    evidence: {
      redirect_chain: (discovery && discovery.redirectChain) || [],
      content_length: contentObserved ? contentObserved.length : 0,
      currency_form: ev.currency_form,
      currency_raw_value: ev.currency_raw_value,
    },
  };
}

// ── Per-domain pipeline (frozen collector + detector) ────────────────────────────
async function processDomain(domain) {
  const discovery = await discoverPolicy(domain);
  if (discovery.status !== 'located') {
    return buildRow(domain, discovery.status, discovery, null, null, null);
  }
  const retrieval = await retrievePolicy(discovery.policyUrl);
  if (!retrieval.ok) {
    return buildRow(domain, 'retrieval_failure', discovery, retrieval, null, null);
  }
  const contentObserved = retrieval.retrievalMethod === 'static' ? stripHtml(retrieval.content) : retrieval.content;
  const detectorResult = detectCurrency(contentObserved);
  return buildRow(domain, 'located', discovery, retrieval, detectorResult, contentObserved);
}

// ── Concurrency pool ─────────────────────────────────────────────────────────────
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

// ── Summary ──────────────────────────────────────────────────────────────────────
function summarize(rows) {
  const c = { total: rows.length, located: 0, not_located: 0, retrieval_failure: 0, ambiguous: 0, present: 0, absent: 0, indeterminate: 0 };
  for (const r of rows) {
    if (c[r.located_state] != null) c[r.located_state]++;
    if (r.evidence_state && c[r.evidence_state] != null) c[r.evidence_state]++;
  }
  c.coverage = c.total ? Number((c.located / c.total).toFixed(3)) : 0;
  return c;
}

// ── Main ──────────────────────────────────────────────────────────────────────────
async function main() {
  const client = getClient();

  // Verify table exists (migration 019 applied)
  const { error: pingErr } = await client.from(TABLE_NAME).select('id').limit(1);
  if (pingErr) {
    const missing = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    console.error(missing
      ? `\n  ERROR: ${TABLE_NAME} not found. Apply backend/db/migrations/019_signal_lab_disclosurecurrency.sql in Supabase first.\n`
      : `\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    process.exit(1);
  }

  let { firmCount, domains } = loadUniqueDomains();
  if (LIMIT) domains = domains.slice(0, LIMIT);

  console.log('═'.repeat(64));
  console.log(` ${SIGNAL_ID} (H-SIG-001) — ${COHORT_CODE} Disclosure Currency Run`);
  console.log(` run_id=${RUN_ID}`);
  console.log(` firms=${firmCount}  unique_domains=${domains.length}  concurrency=${CONCURRENCY}`);
  console.log('═'.repeat(64));

  const rows = [];
  const defects = [];
  let done = 0;

  await runWithConcurrency(domains, async (domain) => {
    try {
      const row = await processDomain(domain);
      const { error } = await client.from(TABLE_NAME).insert(row);
      done++;
      const pct = String(Math.round((done / domains.length) * 100)).padStart(3);
      const dbTag = error ? ` [DB! ${error.message}]` : '';
      console.log(`  [${pct}%] ${row.located_state.padEnd(17)} ${(row.evidence_state || '-').padEnd(13)} ${domain.padEnd(34)}${dbTag}`);
      if (error) defects.push({ domain, error: error.message });
      else rows.push(row);
    } catch (err) {
      defects.push({ domain, error: String(err && err.message ? err.message : err) });
      console.error(`  ${domain}  DEFECT: ${err && err.message ? err.message : err}`);
    }
  }, CONCURRENCY);

  await closeBrowser();

  const summary = summarize(rows);
  const violations = rows.filter((r) => r.located_state !== 'located' && r.evidence_state != null);

  console.log('\n' + '─'.repeat(64));
  console.log(` SUMMARY  run_id=${RUN_ID}`);
  console.log('─'.repeat(64));
  console.log(` rows_written      : ${rows.length}/${domains.length}`);
  console.log(` located_state     : ${JSON.stringify({ located: summary.located, not_located: summary.not_located, retrieval_failure: summary.retrieval_failure, ambiguous: summary.ambiguous })}`);
  console.log(` evidence (located): ${JSON.stringify({ present: summary.present, absent: summary.absent, indeterminate: summary.indeterminate })}`);
  console.log(` coverage          : ${summary.coverage}`);
  console.log(` integrity_violations (client-side): ${violations.length}`);
  console.log(` defects           : ${defects.length}`);
  if (defects.length) console.log(` defects: ${JSON.stringify(defects.slice(0, 20))}`);
}

main().catch((e) => { console.error('\nFatal:', e.message); process.exit(1); });
