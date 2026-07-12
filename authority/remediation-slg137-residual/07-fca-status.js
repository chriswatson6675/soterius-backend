'use strict';
// Stage 7 — cross-check D/E domains whose org has an FRN against the locally
// held FCA registry snapshot (acquisition/runs/fca/registry.ndjson, captured
// 2026-06-30 as part of the Repository Authority build) for current Status.
// This is reading already-collected evidence, not a new live query.

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const IN_DNS = path.join(__dirname, '05-dns-results.ndjson');
const FCA_REGISTRY = path.join(__dirname, '../../acquisition/runs/fca/registry.ndjson');
const OUT = path.join(__dirname, '07-fca-status.ndjson');

async function loadFcaByFrn() {
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(FCA_REGISTRY) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const firm = Array.isArray(rec.firm) ? rec.firm[0] : rec.firm;
    if (!firm) continue;
    map.set(String(rec.frn), {
      status: firm.Status || null,
      statusEffectiveDate: firm['Status Effective Date'] || null,
      organisationName: firm['Organisation Name'] || null,
      businessType: firm['Business Type'] || null,
    });
  }
  return map;
}

async function main() {
  const rows = fs.readFileSync(IN_DNS, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.frn);
  console.log('FCA-linked D/E domains:', rows.length);
  const fcaByFrn = await loadFcaByFrn();
  console.log('FCA registry entries loaded:', fcaByFrn.size);

  const out = fs.createWriteStream(OUT);
  const summary = {};
  for (const r of rows) {
    const fca = fcaByFrn.get(String(r.frn)) || null;
    const rec = { ...r, fca_status: fca ? fca.status : 'NOT_IN_SNAPSHOT', fca_org_name: fca ? fca.organisationName : null };
    summary[rec.fca_status] = (summary[rec.fca_status] || 0) + 1;
    out.write(JSON.stringify(rec) + '\n');
  }
  out.end(() => console.log('FCA status summary:', summary));
}

main();
