'use strict';
// Local runner: identical collector logic, writes observations to a JSON file
// instead of Supabase. Does NOT touch any database.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { discoverPolicy } = require('./policy-discovery');
const { retrievePolicy, closeBrowser } = require('./policy-retrieval');
const { detectCurrency } = require('./detect-currency');
const { buildObservation } = require('./observation-writer');
const DOMAINS = require('./he-001-domains');

const COLLECTOR_VERSION = 'hsig001-collector-1.0.0-local';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : DOMAINS.length;

function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function summarize(rows) {
  const c = { total: rows.length, located: 0, not_located: 0, retrieval_failure: 0, ambiguous: 0, present: 0, absent: 0, indeterminate: 0 };
  for (const r of rows) {
    if (c[r.located_state] != null) c[r.located_state] += 1;
    if (r.evidence_state && c[r.evidence_state] != null) c[r.evidence_state] += 1;
  }
  c.coverage = c.total ? Number((c.located / c.total).toFixed(3)) : 0;
  return c;
}

async function main() {
  const runId = crypto.randomUUID();
  const domains = DOMAINS.slice(0, LIMIT);
  console.log(`[H-SIG-001 local] run_id=${runId} domains=${domains.length}`);
  const rows = [];
  const defects = [];
  for (const domain of domains) {
    try {
      const row = await processDomain(runId, domain);
      rows.push(row);
      console.log(`  ${String(domain).padEnd(22)} ${row.located_state.padEnd(18)} ${(row.evidence_state || '-').padEnd(13)} ${row.currency_form || ''} ${row.currency_raw_value ? '· ' + row.currency_raw_value : ''}`);
    } catch (err) {
      defects.push({ domain, error: String(err && err.message ? err.message : err) });
      console.error(`  ${domain}  DEFECT: ${err && err.message ? err.message : err}`);
    }
  }
  await closeBrowser();

  const summary = summarize(rows);
  const violations = rows.filter((r) => r.located_state !== 'located' && r.evidence_state != null);

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const slim = rows.map((r) => ({ ...r, raw_content: r.raw_content ? `[${r.raw_content.length} chars, sha256:${r.content_hash}]` : null }));
  fs.writeFileSync(path.join(outDir, 'he-001-local-run.json'), JSON.stringify({ runId, summary, rowsWritten: rows.length, integrityViolations: violations.length, defects, rows: slim }, null, 2));

  console.log('\n[H-SIG-001 local] summary: ' + JSON.stringify(summary));
  console.log(`[H-SIG-001 local] rows_written=${rows.length}/${domains.length}`);
  console.log(`[H-SIG-001 local] integrity_violations=${violations.length}`);
  console.log(`[H-SIG-001 local] defects=${defects.length}`);
  console.log(`[H-SIG-001 local] output: out/he-001-local-run.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
