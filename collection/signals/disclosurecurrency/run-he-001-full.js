'use strict';
// Full HE-001 cohort run, baseline collector, LOCAL file output (no DB).
// Loads the authoritative data.ac.uk cohort CSV (same source as the other 9 signals).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { discoverPolicy } = require('./policy-discovery');
const { retrievePolicy, closeBrowser } = require('./policy-retrieval');
const { detectCurrency } = require('./detect-currency');
const { buildObservation } = require('./observation-writer');

const COLLECTOR_VERSION = 'hsig001-collector-1.0.0';
const CSV_PATH = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 6;
const OUT_DIR = path.join(__dirname, 'out');
const JSONL = path.join(OUT_DIR, 'he-001-full.jsonl');
const SUMMARY = path.join(OUT_DIR, 'he-001-full-summary.json');

function splitCsvLine(line) {
  const r = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { r.push(c); c = ''; }
    else c += ch;
  }
  r.push(c); return r;
}
function loadCohort() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter((l) => l.trim());
  const h = splitCsvLine(lines[0]);
  const urlIdx = h.indexOf('WEBSITE_URL');
  const domains = []; let skipped = 0;
  for (const line of lines.slice(1)) {
    const u = (splitCsvLine(line)[urlIdx] || '').trim();
    if (!u) { skipped++; continue; }
    try { const d = new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); if (d) domains.push(d); else skipped++; }
    catch { skipped++; }
  }
  return { domains: [...new Set(domains)], skipped };
}

function stripHtml(s) {
  if (!s) return s;
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function processDomain(runId, domain) {
  const discovery = await discoverPolicy(domain);
  if (discovery.status !== 'located') {
    return buildObservation({ runId, domain, collectorVersion: COLLECTOR_VERSION, locatedState: discovery.status, discovery, retrieval: null, detectorResult: null, content: null });
  }
  const retrieval = await retrievePolicy(discovery.policyUrl);
  if (!retrieval.ok) {
    return buildObservation({ runId, domain, collectorVersion: COLLECTOR_VERSION, locatedState: 'retrieval_failure', discovery, retrieval, detectorResult: null, content: null });
  }
  const detectorInput = retrieval.retrievalMethod === 'static' ? stripHtml(retrieval.content) : retrieval.content;
  const detectorResult = detectCurrency(detectorInput);
  return buildObservation({ runId, domain, collectorVersion: COLLECTOR_VERSION, locatedState: 'located', discovery, retrieval, detectorResult, content: retrieval.content });
}

async function runPool(items, limit, fn) {
  let next = 0;
  const results = new Array(items.length);
  async function worker() { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function summarize(rows) {
  const c = { total: rows.length, located: 0, not_located: 0, retrieval_failure: 0, ambiguous: 0, present: 0, absent: 0, indeterminate: 0 };
  for (const r of rows) { if (c[r.located_state] != null) c[r.located_state]++; if (r.evidence_state && c[r.evidence_state] != null) c[r.evidence_state]++; }
  c.coverage = c.total ? Number((c.located / c.total).toFixed(3)) : 0;
  return c;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(JSONL, '');
  const { domains, skipped } = loadCohort();
  const runId = crypto.randomUUID();
  const started = Date.now();
  console.log(`[H-SIG-001 full] run_id=${runId} cohort=HE-001 domains=${domains.length} skipped=${skipped} concurrency=${CONCURRENCY}`);

  let done = 0;
  const defects = [];
  const rows = await runPool(domains, CONCURRENCY, async (domain) => {
    try {
      const row = await processDomain(runId, domain);
      fs.appendFileSync(JSONL, JSON.stringify(row) + '\n');
      done++;
      if (done % 10 === 0 || done === domains.length) console.log(`  [${done}/${domains.length}] last=${domain} ${row.located_state}/${row.evidence_state || '-'}`);
      return row;
    } catch (err) {
      defects.push({ domain, error: String(err && err.message ? err.message : err) });
      console.error(`  ${domain} DEFECT: ${err && err.message ? err.message : err}`);
      return null;
    }
  });

  await closeBrowser();
  const clean = rows.filter(Boolean);
  const summary = summarize(clean);
  const violations = clean.filter((r) => r.located_state !== 'located' && r.evidence_state != null);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  fs.writeFileSync(SUMMARY, JSON.stringify({
    runId, cohort: 'HE-001', startedAt: new Date(started).toISOString(), elapsed_s: Number(elapsed),
    domains: domains.length, skipped_source: skipped, rows_written: clean.length,
    summary, integrity_violations: violations.length, defects,
  }, null, 2));

  console.log(`\n[H-SIG-001 full] DONE in ${elapsed}s`);
  console.log(`[H-SIG-001 full] summary: ${JSON.stringify(summary)}`);
  console.log(`[H-SIG-001 full] rows_written=${clean.length}/${domains.length}  integrity_violations=${violations.length}  defects=${defects.length}`);
  console.log(`[H-SIG-001 full] outputs: out/he-001-full.jsonl , out/he-001-full-summary.json`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
