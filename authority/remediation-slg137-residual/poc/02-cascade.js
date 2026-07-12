'use strict';
// POC — deterministic Canonical Domain Resolution cascade, Stages 1-4, over
// the 25-org sample. No search engine used in this script (Stage 6 is
// handled separately, manually, only for whatever remains unresolved).

const fs    = require('fs');
const path  = require('path');
const https = require('node:https');
const dns   = require('node:dns').promises;
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getJson, createRateManager, PDA_HOST } = require('../../../collection/sources/companies-house/ch-client');

const IN  = path.join(__dirname, '01-sample-full.ndjson');
const OUT = path.join(__dirname, '02-cascade-results.ndjson');

const FCA_EMAIL = process.env.FCA_EMAIL, FCA_KEY = process.env.FCA_API_KEY;
const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY;
const SRA_SNAPSHOT = path.join(__dirname, '../../../collection/sources/sra/runs/live-004/raw/snapshot.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normHost(s) { if (!s) return null; return s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }

// ── Stage 1: redirect chain (both www and bare, both http/https) ──────────────
function fetchOnce(url) {
  return new Promise((resolve) => {
    let parsed; try { parsed = new URL(url); } catch { return resolve({ error: 'BAD_URL' }); }
    const req = https.request({
      hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: 'GET',
      rejectUnauthorized: false, timeout: 10000,
      headers: { 'User-Agent': 'Soterius-RepoAuthority-POC/1.0' },
    }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || null }); });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}
async function traceChain(domain) {
  const chain = []; let url = `https://${domain}/`; const seen = new Set();
  for (let hop = 0; hop < 20; hop++) {
    if (seen.has(url)) return { chain, outcome: 'LOOP' };
    seen.add(url);
    const r = await fetchOnce(url);
    if (r.error) { chain.push({ url, error: r.error }); return { chain, outcome: chain.length === 1 ? 'UNREACHABLE' : 'ERROR_MID_CHAIN' }; }
    chain.push({ url, status: r.status, location: r.location });
    if (r.status >= 300 && r.status < 400 && r.location) { url = new URL(r.location, url).toString(); continue; }
    return { chain, outcome: r.status < 400 ? 'RESOLVED' : 'HTTP_ERROR_TERMINAL' };
  }
  return { chain, outcome: 'MAX_HOPS' };
}

// ── Stage 2: DNS evidence ──────────────────────────────────────────────────────
async function dnsEvidence(domain) {
  const out = { a: null, cname: null, mx: null, ns: null, spf: null, dmarc: null };
  try { out.a = await dns.resolve4(domain); } catch {}
  try { out.cname = await dns.resolveCname(domain); } catch {}
  try { out.mx = (await dns.resolveMx(domain)).map(m => m.exchange); } catch {}
  try { out.ns = await dns.resolveNs(domain); } catch {}
  try {
    const txt = await dns.resolveTxt(domain);
    const flat = txt.map(t => t.join(''));
    out.spf = flat.find(t => t.startsWith('v=spf1')) || null;
  } catch {}
  try {
    const dtxt = await dns.resolveTxt(`_dmarc.${domain}`);
    out.dmarc = dtxt.map(t => t.join('')).find(t => t.startsWith('v=DMARC1')) || null;
  } catch {}
  return out;
}
function extractDomainsFromDns(ev) {
  const found = new Set();
  if (ev.cname) ev.cname.forEach(c => found.add(normHost(c)));
  if (ev.mx) ev.mx.forEach(m => found.add(normHost(m)));
  if (ev.spf) { const incl = [...ev.spf.matchAll(/include:([a-z0-9.-]+)/gi)].map(m => m[1]); incl.forEach(i => found.add(normHost(i))); }
  if (ev.dmarc) { const rua = [...ev.dmarc.matchAll(/rua=mailto:[^@]+@([a-z0-9.-]+)/gi)].map(m => m[1]); rua.forEach(r => found.add(normHost(r))); }
  return [...found].filter(Boolean);
}

// ── Stage 3: FCA / SRA ─────────────────────────────────────────────────────────
function fcaAddress(frn) {
  return new Promise((resolve) => {
    const url = `https://register.fca.org.uk/services/V0.1/Firm/${encodeURIComponent(frn)}/Address`;
    https.get(url, { headers: { 'X-Auth-Email': FCA_EMAIL, 'X-Auth-Key': FCA_KEY } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP_${res.statusCode}` });
        try {
          const json = JSON.parse(body); const data = json.Data || [];
          resolve({ found: true, records: data });
        } catch { resolve({ error: 'PARSE_ERROR' }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}
function fcaFirmStatus(frn) {
  return new Promise((resolve) => {
    const url = `https://register.fca.org.uk/services/V0.1/Firm/${encodeURIComponent(frn)}`;
    https.get(url, { headers: { 'X-Auth-Email': FCA_EMAIL, 'X-Auth-Key': FCA_KEY } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP_${res.statusCode}` });
        try {
          const json = JSON.parse(body); const data = (json.Data || [])[0] || null;
          resolve({ found: !!data, status: data ? data.Status : null, name: data ? data['Organisation Name'] : null, tradingNames: data ? data['Trading Names'] : null });
        } catch { resolve({ error: 'PARSE_ERROR' }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

// ── Stage 4: Companies House (profile + filing history) ───────────────────────
async function chProfile(number, rateManager) {
  const url = `https://${PDA_HOST}/company/${encodeURIComponent(number)}`;
  const res = await getJson(url, { apiKey: CH_API_KEY, rateManager });
  if (res.errorType !== 'NONE' || !res.body) return { error: res.errorType };
  return { found: true, body: res.body };
}
async function chFilingHistory(number, rateManager) {
  const url = `https://${PDA_HOST}/company/${encodeURIComponent(number)}/filing-history?category=officers,change-of-name,insolvency&items_per_page=25`;
  const res = await getJson(url, { apiKey: CH_API_KEY, rateManager });
  if (res.errorType !== 'NONE' || !res.body) return { error: res.errorType };
  return { found: true, items: (res.body.items || []).map(i => ({ date: i.date, type: i.type, description: i.description })) };
}

async function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const sraData = JSON.parse(fs.readFileSync(SRA_SNAPSHOT, 'utf8'));
  const sraByNumber = new Map(sraData.Organisations.map(o => [String(o.SraNumber), o]));
  const chRate = createRateManager({});

  const out = fs.createWriteStream(OUT);
  let n = 0;
  for (const r of rows) {
    n++;
    console.log(`\n[${n}/${rows.length}] ${r.organisation_name} (${r.stored_domain})`);
    const result = { organisation_name: r.organisation_name, stored_domain: r.stored_domain, identifiers: r.identifiers, organisation_status_prior: r.organisation_status };

    // Stage 1
    console.log('  Stage 1: redirect chain...');
    const trace = await traceChain(r.stored_domain);
    result.stage1 = trace;

    // Stage 2
    console.log('  Stage 2: DNS evidence...');
    const dnsEv = await dnsEvidence(r.stored_domain);
    result.stage2 = { ...dnsEv, candidateDomains: extractDomainsFromDns(dnsEv) };

    // Stage 3
    console.log('  Stage 3: FCA/SRA...');
    result.stage3 = {};
    if (r.identifiers.frn) {
      result.stage3.fcaAddress = await fcaAddress(r.identifiers.frn); await sleep(220);
      result.stage3.fcaStatus = await fcaFirmStatus(r.identifiers.frn); await sleep(220);
    }
    if (r.identifiers.sraIdentifier) {
      const sra = sraByNumber.get(String(r.identifiers.sraIdentifier));
      result.stage3.sra = sra ? {
        authorisationStatus: sra.AuthorisationStatus, tradingNames: sra.TradingNames, previousNames: sra.PreviousNames,
        websites: sra.Websites, officeWebsites: (sra.Offices || []).map(o => o.Website).filter(Boolean),
        officeEmails: (sra.Offices || []).map(o => o.Email).filter(Boolean), companyRegNo: sra.CompanyRegNo,
      } : null;
    }

    // Stage 4
    console.log('  Stage 4: Companies House...');
    result.stage4 = {};
    if (r.identifiers.companiesHouseNumber) {
      result.stage4.profile = await chProfile(r.identifiers.companiesHouseNumber, chRate);
      result.stage4.filingHistory = await chFilingHistory(r.identifiers.companiesHouseNumber, chRate);
    } else if (result.stage3.sra && result.stage3.sra.companyRegNo) {
      result.stage4.profile = await chProfile(result.stage3.sra.companyRegNo, chRate);
      result.stage4.filingHistory = await chFilingHistory(result.stage3.sra.companyRegNo, chRate);
      result.stage4.companyRegNoSource = 'SRA record';
    }

    out.write(JSON.stringify(result) + '\n');
  }
  out.end(() => console.log('\nDone ->', OUT));
}

main().catch(e => { console.error(e); process.exit(1); });
