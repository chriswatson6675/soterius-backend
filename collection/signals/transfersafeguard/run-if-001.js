'use strict';
// run-if-001.js — SOT-TRANSFERSAFEGUARD-001 (H-SIG-003) IF-001 standalone runner.
// Reuses the FROZEN H-SIG-001 discovery+retrieval; runs the Transfer Safeguard detector;
// persists one observation per domain to signal_transfersafeguard_v1. Records observations only.
// EM-H-D1 enforced (writer + DB CHECK). Usage/env identical to the other Category H runners.

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const { discoverPolicy } = require('../disclosurecurrency/policy-discovery');
const { retrievePolicy, closeBrowser } = require('../disclosurecurrency/policy-retrieval');
const { detectTransferSafeguard } = require('./detect-transfersafeguard');
const { deriveEvidence, sanitizeForPg, sha256 } = require('./observation-writer');

const SIGNAL_ID = 'SOT-TRANSFERSAFEGUARD-001';
const COLLECTOR_VERSION = 'hsig003-collector-1.0.0';
const TABLE_NAME = 'signal_transfersafeguard_v1';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const RUN_ID = process.env.RUN_ID ?? randomUUID();
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const MANIFEST_PATH = path.join(__dirname, '../../if001-full/cohort-manifest.json');

function getClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}
function loadUniqueDomains() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const seen = new Set(), domains = [];
  for (const f of (manifest.firms ?? [])) {
    const d = (f.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (d && !seen.has(d)) { seen.add(d); domains.push(d); }
  }
  return domains;
}
function stripHtml(s) { return s ? s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : s; }

function buildRow(domain, locatedState, discovery, retrieval, detectorResult, contentObserved) {
  const ev = deriveEvidence(locatedState, contentObserved, detectorResult);
  return {
    run_id: RUN_ID, domain, signal_version: 1, collector_version: COLLECTOR_VERSION, element_set_version: 'pad-v1',
    located_state: locatedState,
    evidence_state: ev.evidence_state, transfer_raw_value: ev.transfer_raw_value, transfer_form: ev.transfer_form,
    policy_url: (retrieval && retrieval.finalUrl) || (discovery && discovery.policyUrl) || null,
    retrieval_method: (retrieval && retrieval.retrievalMethod) || null,
    http_status: retrieval && retrieval.httpStatus != null ? retrieval.httpStatus : null,
    content_hash: sha256(contentObserved), content_observed: contentObserved || null,
    evidence: { redirect_chain: (discovery && discovery.redirectChain) || [], content_length: contentObserved ? contentObserved.length : 0, transfer_form: ev.transfer_form, transfer_raw_value: ev.transfer_raw_value, detector_trace: { detector: 'detect-transfersafeguard', collector_version: COLLECTOR_VERSION } },
  };
}
async function processDomain(domain) {
  const discovery = await discoverPolicy(domain);
  if (discovery.status !== 'located') return buildRow(domain, discovery.status, discovery, null, null, null);
  const retrieval = await retrievePolicy(discovery.policyUrl);
  if (!retrieval.ok) return buildRow(domain, 'retrieval_failure', discovery, retrieval, null, null);
  const contentObserved = sanitizeForPg(retrieval.retrievalMethod === 'static' ? stripHtml(retrieval.content) : retrieval.content);
  return buildRow(domain, 'located', discovery, retrieval, detectTransferSafeguard(contentObserved), contentObserved);
}
async function runWithConcurrency(items, fn, limit) {
  let next = 0; async function w() { while (next < items.length) { await fn(items[next++]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
}
async function main() {
  const client = getClient();
  const { error: pingErr } = await client.from(TABLE_NAME).select('id').limit(1);
  if (pingErr) { console.error(`\n  ERROR: ${TABLE_NAME} not found — apply migration 021. ${pingErr.message}\n`); process.exit(1); }
  let domains = loadUniqueDomains(); if (LIMIT) domains = domains.slice(0, LIMIT);
  console.log(`${SIGNAL_ID} (H-SIG-003) IF-001 — run_id=${RUN_ID} domains=${domains.length}`);
  const stats = { present: 0, absent: 0, indeterminate: 0, located: 0, written: 0, defects: 0 };
  let done = 0;
  await runWithConcurrency(domains, async (domain) => {
    try {
      const row = await processDomain(domain);
      const { error } = await client.from(TABLE_NAME).insert(row);
      done++;
      if (row.located_state === 'located') stats.located++;
      if (row.evidence_state) stats[row.evidence_state]++;
      if (error) stats.defects++; else stats.written++;
      console.log(`  [${String(Math.round(done / domains.length * 100)).padStart(3)}%] ${row.located_state.padEnd(17)} ${(row.evidence_state || '-').padEnd(13)} ${domain}${error ? ' [DB! ' + error.message + ']' : ''}`);
    } catch (e) { stats.defects++; console.error(`  ${domain} DEFECT: ${e.message}`); }
  }, CONCURRENCY);
  await closeBrowser();
  console.log(`\n SUMMARY run_id=${RUN_ID} written=${stats.written}/${domains.length} located=${stats.located} evidence={present:${stats.present},absent:${stats.absent},indeterminate:${stats.indeterminate}} defects=${stats.defects}`);
}
if (require.main === module) main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
module.exports = { buildRow, processDomain, stripHtml };
