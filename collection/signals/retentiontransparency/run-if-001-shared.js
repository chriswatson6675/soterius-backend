'use strict';

// run-if-001-shared.js — Category H SHARED co-collection runner (H-SIG-001 + H-SIG-002).
//
// Retrieves each domain's privacy disclosure ONCE, then runs BOTH detectors independently
// against the same retrieved content and writes two independent evidence rows under the SAME
// run_id:
//   - Disclosure Currency  (DE-PAD-014) -> signal_disclosurecurrency_v1
//   - Retention Specification (DE-PAD-015) -> signal_retentiontransparency_v1
//
// The signals remain fully independent (separate detectors, separate tables, disjoint forms);
// only the discovery+retrieval cost is shared. Records observations only — no scores, no ratings.
// EM-H-D1: evidence_state is set ONLY when located_state = 'located' (also DB-enforced).
//
// Usage:  node backend/signal-lab/signals/retentiontransparency/run-if-001-shared.js
// Prereq: migrations 019 AND 020 applied in Supabase; backend/.env present.
// Env:    CONCURRENCY (default 5) · RUN_ID (optional UUID) · LIMIT (optional cap)

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// Shared frozen discovery + retrieval (H-SIG-001 pipeline)
const { discoverPolicy } = require('../disclosurecurrency/policy-discovery');
const { retrievePolicy, closeBrowser } = require('../disclosurecurrency/policy-retrieval');
// H-SIG-001 detector + evidence routing
const { detectCurrency } = require('../disclosurecurrency/detect-currency');
const { deriveEvidenceState, sha256 } = require('../disclosurecurrency/observation-writer');
// H-SIG-002 detector + evidence routing
const { detectRetention } = require('./detect-retention');
const { deriveEvidence, sanitizeForPg } = require('./observation-writer');
// H-SIG-003 detector + evidence routing
const { detectTransferSafeguard } = require('../transfersafeguard/detect-transfersafeguard');
const { deriveEvidence: deriveTransfer } = require('../transfersafeguard/observation-writer');

const COHORT_CODE  = 'IF-001';
const CONCURRENCY  = Number(process.env.CONCURRENCY ?? 5);
const RUN_ID       = process.env.RUN_ID ?? randomUUID();
const LIMIT        = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const MANIFEST_PATH = path.join(__dirname, '../../if001-full/cohort-manifest.json');

const CURRENCY = { table: 'signal_disclosurecurrency_v1', collector: 'hsig001-collector-1.0.0' };
const RETENTION = { table: 'signal_retentiontransparency_v1', collector: 'hsig002-collector-1.0.0' };
const TRANSFER = { table: 'signal_transfersafeguard_v1', collector: 'hsig003-collector-1.0.0' };

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

function provenance(discovery, retrieval, contentObserved) {
  return {
    policy_url: (retrieval && retrieval.finalUrl) || (discovery && discovery.policyUrl) || null,
    retrieval_method: (retrieval && retrieval.retrievalMethod) || null,
    http_status: retrieval && retrieval.httpStatus != null ? retrieval.httpStatus : null,
    content_hash: sha256(contentObserved),
    content_observed: contentObserved || null,
    redirect_chain: (discovery && discovery.redirectChain) || [],
    content_length: contentObserved ? contentObserved.length : 0,
  };
}

function currencyRow(domain, locatedState, prov, detectorResult) {
  const ev = deriveEvidenceState(locatedState, detectorResult);
  return {
    run_id: RUN_ID, domain, signal_version: 1, collector_version: CURRENCY.collector, element_set_version: 'pad-v1',
    located_state: locatedState,
    evidence_state: ev.evidence_state, currency_raw_value: ev.currency_raw_value, currency_form: ev.currency_form,
    policy_url: prov.policy_url, retrieval_method: prov.retrieval_method, http_status: prov.http_status,
    content_hash: prov.content_hash, content_observed: prov.content_observed,
    evidence: { redirect_chain: prov.redirect_chain, content_length: prov.content_length, currency_form: ev.currency_form, currency_raw_value: ev.currency_raw_value },
  };
}

function retentionRow(domain, locatedState, prov, detectorResult) {
  const ev = deriveEvidence(locatedState, prov.content_observed, detectorResult);
  return {
    run_id: RUN_ID, domain, signal_version: 1, collector_version: RETENTION.collector, element_set_version: 'pad-v1',
    located_state: locatedState,
    evidence_state: ev.evidence_state, retention_raw_value: ev.retention_raw_value, retention_form: ev.retention_form,
    policy_url: prov.policy_url, retrieval_method: prov.retrieval_method, http_status: prov.http_status,
    content_hash: prov.content_hash, content_observed: prov.content_observed,
    evidence: { redirect_chain: prov.redirect_chain, content_length: prov.content_length, retention_form: ev.retention_form, retention_raw_value: ev.retention_raw_value, detector_trace: { detector: 'detect-retention', collector_version: RETENTION.collector } },
  };
}

function transferRow(domain, locatedState, prov, detectorResult) {
  const ev = deriveTransfer(locatedState, prov.content_observed, detectorResult);
  return {
    run_id: RUN_ID, domain, signal_version: 1, collector_version: TRANSFER.collector, element_set_version: 'pad-v1',
    located_state: locatedState,
    evidence_state: ev.evidence_state, transfer_raw_value: ev.transfer_raw_value, transfer_form: ev.transfer_form,
    policy_url: prov.policy_url, retrieval_method: prov.retrieval_method, http_status: prov.http_status,
    content_hash: prov.content_hash, content_observed: prov.content_observed,
    evidence: { redirect_chain: prov.redirect_chain, content_length: prov.content_length, transfer_form: ev.transfer_form, transfer_raw_value: ev.transfer_raw_value, detector_trace: { detector: 'detect-transfersafeguard', collector_version: TRANSFER.collector } },
  };
}

// Retrieve ONCE; run ALL THREE detectors independently on the same content.
async function processDomain(domain) {
  const discovery = await discoverPolicy(domain);
  if (discovery.status !== 'located') {
    const prov = provenance(discovery, null, null);
    return { currency: currencyRow(domain, discovery.status, prov, null), retention: retentionRow(domain, discovery.status, prov, null), transfer: transferRow(domain, discovery.status, prov, null) };
  }
  const retrieval = await retrievePolicy(discovery.policyUrl);
  if (!retrieval.ok) {
    const prov = provenance(discovery, retrieval, null);
    return { currency: currencyRow(domain, 'retrieval_failure', prov, null), retention: retentionRow(domain, 'retrieval_failure', prov, null), transfer: transferRow(domain, 'retrieval_failure', prov, null) };
  }
  const raw = retrieval.retrievalMethod === 'static' ? stripHtml(retrieval.content) : retrieval.content;
  const contentObserved = sanitizeForPg(raw); // persistence robustness: strip NUL / lone surrogates before detect + store
  const prov = provenance(discovery, retrieval, contentObserved);
  return {
    currency: currencyRow(domain, 'located', prov, detectCurrency(contentObserved)),
    retention: retentionRow(domain, 'located', prov, detectRetention(contentObserved)),
    transfer: transferRow(domain, 'located', prov, detectTransferSafeguard(contentObserved)),
  };
}

async function runWithConcurrency(items, fn, limit) {
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  const client = getClient();
  for (const t of [CURRENCY.table, RETENTION.table, TRANSFER.table]) {
    const { error } = await client.from(t).select('id').limit(1);
    if (error) { console.error(`\n  ERROR: ${t} not found / unreachable — apply migrations 019 + 020 + 021. ${error.message}\n`); process.exit(1); }
  }
  let { firmCount, domains } = loadUniqueDomains();
  if (LIMIT) domains = domains.slice(0, LIMIT);

  console.log('═'.repeat(64));
  console.log(` Category H SHARED co-collection — ${COHORT_CODE} (H-SIG-001 + H-SIG-002 + H-SIG-003)`);
  console.log(` run_id=${RUN_ID}  firms=${firmCount}  unique_domains=${domains.length}  concurrency=${CONCURRENCY}`);
  console.log('═'.repeat(64));

  const stats = { cur: { present: 0, absent: 0, indeterminate: 0 }, ret: { present: 0, absent: 0, indeterminate: 0 }, tra: { present: 0, absent: 0, indeterminate: 0 }, located: 0, written: 0, defects: [] };
  let done = 0;
  await runWithConcurrency(domains, async (domain) => {
    try {
      const { currency, retention, transfer } = await processDomain(domain);
      const e1 = (await client.from(CURRENCY.table).insert(currency)).error;
      const e2 = (await client.from(RETENTION.table).insert(retention)).error;
      const e3 = (await client.from(TRANSFER.table).insert(transfer)).error;
      done++;
      if (currency.located_state === 'located') stats.located++;
      if (currency.evidence_state) stats.cur[currency.evidence_state]++;
      if (retention.evidence_state) stats.ret[retention.evidence_state]++;
      if (transfer.evidence_state) stats.tra[transfer.evidence_state]++;
      if (!e1 && !e2 && !e3) stats.written++;
      if (e1) stats.defects.push({ domain, table: CURRENCY.table, error: e1.message });
      if (e2) stats.defects.push({ domain, table: RETENTION.table, error: e2.message });
      if (e3) stats.defects.push({ domain, table: TRANSFER.table, error: e3.message });
      const pct = String(Math.round((done / domains.length) * 100)).padStart(3);
      console.log(`  [${pct}%] ${currency.located_state.padEnd(17)} cur=${(currency.evidence_state || '-').padEnd(11)} ret=${(retention.evidence_state || '-').padEnd(11)} tra=${(transfer.evidence_state || '-').padEnd(11)} ${domain}`);
    } catch (err) {
      stats.defects.push({ domain, error: String(err && err.message ? err.message : err) });
      console.error(`  ${domain}  DEFECT: ${err && err.message ? err.message : err}`);
    }
  }, CONCURRENCY);

  await closeBrowser();
  console.log('\n' + '─'.repeat(64));
  console.log(` SUMMARY  run_id=${RUN_ID}  (one retrieval per domain; three evidence rows)`);
  console.log(` located=${stats.located}/${domains.length}  all_rows_written=${stats.written}`);
  console.log(` currency  evidence: ${JSON.stringify(stats.cur)}`);
  console.log(` retention evidence: ${JSON.stringify(stats.ret)}`);
  console.log(` transfer  evidence: ${JSON.stringify(stats.tra)}`);
  console.log(` defects: ${stats.defects.length}`);
  if (stats.defects.length) console.log(` ${JSON.stringify(stats.defects.slice(0, 20))}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('\nFatal:', e.message); process.exit(1); });
}

module.exports = { processDomain, currencyRow, retentionRow, provenance, stripHtml };
