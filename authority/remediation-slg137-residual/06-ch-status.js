'use strict';
// Stage 6 — live Companies House company-profile lookup for every D/E domain
// whose org record carries a companiesHouseNumber. Rate-limited via the
// existing ch-client.js rate manager (600 req/5min budget, same as the
// production CH collector).

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getJson, createRateManager, PDA_HOST } = require('../../collection/sources/companies-house/ch-client');

const IN  = path.join(__dirname, '05-dns-results.ndjson');
const OUT = path.join(__dirname, '06-ch-status.ndjson');
const apiKey = process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY;

async function main() {
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.companiesHouseNumber);
  console.log('CH lookups to run:', rows.length);

  const rateManager = createRateManager({});
  const out = fs.createWriteStream(OUT);
  let i = 0;
  const summary = {};
  for (const r of rows) {
    i++;
    const url = `https://${PDA_HOST}/company/${encodeURIComponent(r.companiesHouseNumber)}`;
    const res = await getJson(url, { apiKey, rateManager });
    let chStatus = null, chName = null, prevNames = null, dissolutionDate = null;
    if (res.errorType === 'NONE' && res.body) {
      chStatus = res.body.company_status || null;
      chName = res.body.company_name || null;
      prevNames = (res.body.previous_company_names || []).map(n => n.name);
      dissolutionDate = res.body.date_of_cessation || null;
    }
    const rec = {
      ...r,
      ch_lookup_error: res.errorType === 'NONE' ? null : res.errorType,
      ch_company_status: chStatus,
      ch_company_name: chName,
      ch_previous_names: prevNames,
      ch_dissolution_date: dissolutionDate,
    };
    summary[rec.ch_lookup_error || chStatus || 'UNKNOWN'] = (summary[rec.ch_lookup_error || chStatus || 'UNKNOWN'] || 0) + 1;
    out.write(JSON.stringify(rec) + '\n');
    if (i % 50 === 0) console.log(`  ${i}/${rows.length}`);
  }
  out.end(() => console.log('CH status summary:', summary));
}

main().catch(e => { console.error(e); process.exit(1); });
