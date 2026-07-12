'use strict';
// Stage 11 — resolve the 735 MANUAL_REVIEW organisations using ONLY official
// sources: live FCA Register /Firm/{FRN}/Address (Website Address field), and
// the sealed SRA Register snapshot (live-004, collected 2026-07-06,
// collection/sources/sra/runs/live-004/raw/snapshot.json — AuthorisationStatus
// + Offices[].Website + Websites[] fields, verbatim from the SRA's own GetAll
// API). No search-engine ranking used anywhere in this stage.

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const https = require('node:https');

const MR_IN = path.join(__dirname, 'mr-cohort-full.ndjson');
const SRA_SNAPSHOT = path.join(__dirname, '../../collection/sources/sra/runs/live-004/raw/snapshot.json');
const OUT = path.join(__dirname, '11-official-source-evidence.ndjson');

const FCA_EMAIL = process.env.FCA_EMAIL;
const FCA_KEY   = process.env.FCA_API_KEY;

function fcaFirmStatus(frn) {
  return new Promise((resolve) => {
    const url = `https://register.fca.org.uk/services/V0.1/Firm/${encodeURIComponent(frn)}`;
    https.get(url, { headers: { 'X-Auth-Email': FCA_EMAIL, 'X-Auth-Key': FCA_KEY } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP_${res.statusCode}` });
        try {
          const json = JSON.parse(body);
          const data = (json.Data || [])[0] || null;
          resolve({ found: !!data, status: data ? data.Status : null, name: data ? data['Organisation Name'] : null });
        } catch (e) { resolve({ error: 'PARSE_ERROR' }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

function fcaAddress(frn) {
  return new Promise((resolve) => {
    const url = `https://register.fca.org.uk/services/V0.1/Firm/${encodeURIComponent(frn)}/Address`;
    https.get(url, { headers: { 'X-Auth-Email': FCA_EMAIL, 'X-Auth-Key': FCA_KEY } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP_${res.statusCode}` });
        try {
          const json = JSON.parse(body);
          const data = json.Data || [];
          const ppob = data.find(d => d['Address Type'] === 'Principal Place of Business') || data[0];
          const website = data.map(d => d['Website Address']).find(w => w && w.trim());
          resolve({ found: true, website: website || null, raw: data });
        } catch (e) { resolve({ error: 'PARSE_ERROR' }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Loading SRA snapshot...');
  const sraData = JSON.parse(fs.readFileSync(SRA_SNAPSHOT, 'utf8'));
  const sraByNumber = new Map(sraData.Organisations.map(o => [String(o.SraNumber), o]));
  console.log('SRA records indexed:', sraByNumber.size);

  const rows = fs.readFileSync(MR_IN, 'utf8').trim().split('\n').map(JSON.parse);
  console.log('MANUAL_REVIEW cohort:', rows.length);

  const out = fs.createWriteStream(OUT);
  let fcaCalls = 0, sraHits = 0, neitherCount = 0;

  for (const r of rows) {
    const evidence = { domain: r.stored_domain, organisation_name: r.organisation_name };

    // FCA official source
    if (r.identifiers.frn) {
      const addr = await fcaAddress(r.identifiers.frn);
      fcaCalls++;
      await sleep(220); // stay well under 50 req/10s
      const status = await fcaFirmStatus(r.identifiers.frn);
      fcaCalls++;
      await sleep(220);
      evidence.fca_lookup = addr;
      evidence.fca_status = status;
      if (fcaCalls % 25 === 0) console.log(`  FCA ${fcaCalls}`);
    }

    // SRA official source
    if (r.identifiers.sraIdentifier) {
      const sra = sraByNumber.get(String(r.identifiers.sraIdentifier));
      if (sra) {
        sraHits++;
        const officeWebsites = (sra.Offices || []).map(o => o.Website).filter(Boolean);
        evidence.sra_record = {
          authorisationStatus: sra.AuthorisationStatus,
          type: sra.Type,
          websites: sra.Websites || null,
          officeWebsites,
          companyRegNo: sra.CompanyRegNo || null,
        };
      } else {
        evidence.sra_record = null;
      }
    }

    if (!r.identifiers.frn && !r.identifiers.sraIdentifier) neitherCount++;

    out.write(JSON.stringify({ ...r, official_evidence: evidence }) + '\n');
  }
  out.end(() => {
    console.log('FCA lookups:', fcaCalls, 'SRA matches:', sraHits, 'neither identifier:', neitherCount);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
