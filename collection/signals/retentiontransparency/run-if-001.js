'use strict';

// run-if-001.js — SOT-RETENTIONTRANSPARENCY-001 (H-SIG-002) IF-001 Cohort Run.
//
// Mirrors the H-SIG-001 runner. Reuses the FROZEN H-SIG-001 discovery + retrieval pipeline
// (policy-discovery.js, policy-retrieval.js) and runs the Retention Specification detector
// against each unique domain, persisting one observation per domain to
// signal_retentiontransparency_v1.
//
// Signal Lab rule: records observations only. No scores. No ratings.
// EM-H-D1: evidence_state is set ONLY when located_state = 'located' (also enforced by the DB
// CHECK constraint evidence_only_when_located).
//
// Usage:   node backend/signal-lab/signals/retentiontransparency/run-if-001.js
// Prereq:  migration 020 applied in Supabase; backend/.env with SUPABASE_URL + SERVICE_ROLE_KEY.
// Env:     CONCURRENCY (default 5) · RUN_ID (optional UUID) · LIMIT (optional cap)

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Reused frozen H-SIG-001 discovery + retrieval ───────────────────────────────
const { discoverPolicy } = require('../disclosurecurrency/policy-discovery');
const { retrievePolicy, closeBrowser } = require('../disclosurecurrency/policy-retrieval');
// ── H-SIG-002 detector + evidence routing ───────────────────────────────────────
const { detectRetention } = require('./detect-retention');
const { deriveEvidence, sha256, sanitizeForPg } = require('./observation-writer');

const COHORT_CODE         = 'IF-001';
const SIGNAL_ID           = 'SOT-RETENTIONTRANSPARENCY-001';
const SIGNAL_VERSION      = 1;
const COLLECTOR_VERSION   = 'hsig002-collector-1.0.0';
const ELEMENT_SET_VERSION = 'pad-v1';
const TABLE_NAME          = 'signal_retentiontransparency_v1';
const CONCURRENCY         = Number(process.env.CONCURRENCY ?? 5);
const RUN_ID              = process.env.RUN_ID ?? randomUUID();
const LIMIT               = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const MANIFEST_PATH       = path.join(__dirname, '../../if001-full/cohort-manifest.json');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

function loadUniqueDomains() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`IF-001 cohort manifest not found at ${MANIFEST_PATH}`);
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

function stripHtml(s) {
  if (!s) return s;
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildRow(domain, locatedState, discovery, retrieval, detectorResult, contentObserved) {
  const ev = deriveEvidence(locatedState, contentObserved, detectorResult); // EM-H-D1 routing
  return {
    run_id: RUN_ID,
    domain,
    signal_version: SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,
    element_set_version: ELEMENT_SET_VERSION,
    located_state: locatedState,
    evidence_state: ev.evidence_state,
    retention_raw_value: ev.retention_raw_value,
    retention_form: ev.retention_form,
    policy_url: (retrieval && retrieval.finalUrl) || (discovery && discovery.policyUrl) || null,
    retrieval_method: (retrieval && retrieval.retrievalMethod) || null,
    http_status: retrieval && retrieval.httpStatus != null ? retrieval.httpStatus : null,
    content_hash: sha256(contentObserved),
    content_observed: contentObserved || null,
    evidence: {
      redirect_chain: (discovery && discovery.redirectChain) || [],
      content_length: contentObserved ? contentObserved.length : 0,
      retention_form: ev.retention_form,
      retention_raw_value: ev.retention_raw_value,
      detector_trace: { detector: 'detect-retention', collector_version: COLLECTOR_VERSION },
    },
  };
}

async function processDomain(domain) {
  const discovery = await discoverPolicy(domain);
  if (discovery.status !== 'located') return buildRow(domain, discovery.status, discovery, null, null, null);
  const retrieval = await retrievePolicy(discovery.policyUrl);
  if (!retrieval.ok) return buildRow(domain, 'retrieval_failure', discovery, retrieval, null, null);
  const raw = retrieval.retrievalMethod === 'static' ? stripHtml(retrieval.content) : retrieval.content;
  const contentObserved = sanitizeForPg(raw); // persistence robustness: strip NUL / lone surrogates before detect + store
  const detectorResult = detectRetention(contentObserved);
  return buildRow(domain, 'located', discovery, retrieval, detectorResult, contentObserved);
}

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function summarize(rows) {
  const c = { total: rows.length, located: 0, not_located: 0, retrieval_failure: 0, ambiguous: 0, present: 0, absent: 0, indeterminate: 0 };
  for (const r of rows) {
    if (c[r.located_state] != null) c[r.located_state]++;
    if (r.evidence_state && c[r.evidence_state] != null) c[r.evidence_state]++;
  }
  c.coverage = c.total ? Number((c.located / c.total).toFixed(3)) : 0;
  return c;
}

async function main() {
  const client = getClient();
  const { error: pingErr } = await client.from(TABLE_NAME).select('id').limit(1);
  if (pingErr) {
    const missing = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    console.error(missing
      ? `\n  ERROR: ${TABLE_NAME} not found. Apply backend/db/migrations/020_signal_lab_retentiontransparency.sql in Supabase first.\n`
      : `\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    process.exit(1);
  }

  let { firmCount, domains } = loadUniqueDomains();
  if (LIMIT) domains = domains.slice(0, LIMIT);

  console.log('═'.repeat(64));
  console.log(` ${SIGNAL_ID} (H-SIG-002) — ${COHORT_CODE} Retention Transparency Run`);
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
      if (error) defects.push({ domain, error: error.message }); else rows.push(row);
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

if (require.main === module) {
  main().catch((e) => { console.error('\nFatal:', e.message); process.exit(1); });
}

module.exports = { buildRow, processDomain, summarize, stripHtml };
