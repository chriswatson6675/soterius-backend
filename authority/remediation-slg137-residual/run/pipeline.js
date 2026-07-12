'use strict';
// Repository Authority Exception Resolution pipeline — first operational run,
// Stages 1-5, against all 1,345 organisations. Deterministic only (no search).
// Checkpointed: appends one line per completed organisation to
// checkpoint.ndjson; on restart, already-completed domains are skipped.
//
// Produces NO Repository Authority writes — this is evidence gathering +
// recommendation only, per the operating brief.

const fs    = require('fs');
const path  = require('path');
const https = require('node:https');
const dns   = require('node:dns').promises;
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getJson, createRateManager, PDA_HOST } = require('../../../collection/sources/companies-house/ch-client');

const IN  = path.join(__dirname, '../01-groups.ndjson');
const CHECKPOINT = path.join(__dirname, 'checkpoint.ndjson');
const SRA_SNAPSHOT = path.join(__dirname, '../../../collection/sources/sra/runs/live-004/raw/snapshot.json');

const FCA_EMAIL = process.env.FCA_EMAIL, FCA_KEY = process.env.FCA_API_KEY;
const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normHost(s) { if (!s) return null; return s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }

// ── Stage 1: redirect chain, apex + www ────────────────────────────────────────
function fetchOnce(url) {
  return new Promise((resolve) => {
    let parsed; try { parsed = new URL(url); } catch { return resolve({ error: 'BAD_URL' }); }
    const req = https.request({
      hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: 'GET',
      rejectUnauthorized: false, timeout: 9000,
      headers: { 'User-Agent': 'Soterius-RepoAuthority-ExceptionResolution/1.0' },
    }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || null }); });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}
async function traceChain(startDomain) {
  const chain = []; let url = `https://${startDomain}/`; const seen = new Set();
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
async function stage1(domain) {
  const apex = await traceChain(domain);
  if (apex.outcome === 'RESOLVED') return { attempted: 'apex', apex, www: null };
  const www = await traceChain(`www.${domain}`);
  return { attempted: 'both', apex, www };
}

// ── Stage 2: DNS evidence ──────────────────────────────────────────────────────
async function dnsEvidence(domain) {
  const out = { a: null, aaaa: null, cname: null, mx: null, ns: null, spf: null, dmarc: null };
  try { out.a = await dns.resolve4(domain); } catch {}
  try { out.aaaa = await dns.resolve6(domain); } catch {}
  try { out.cname = await dns.resolveCname(domain); } catch {}
  try { out.mx = (await dns.resolveMx(domain)).map(m => m.exchange); } catch {}
  try { out.ns = await dns.resolveNs(domain); } catch {}
  try { const t = await dns.resolveTxt(domain); out.spf = t.map(x => x.join('')).find(x => x.startsWith('v=spf1')) || null; } catch {}
  try { const t = await dns.resolveTxt(`_dmarc.${domain}`); out.dmarc = t.map(x => x.join('')).find(x => x.startsWith('v=DMARC1')) || null; } catch {}
  const hasWeb = !!(out.a || out.aaaa || out.cname);
  const hasMail = !!(out.mx && out.mx.length);
  const hasAny = hasWeb || hasMail || !!out.ns;
  const controlState = hasWeb ? 'WEB_PRESENT' : hasMail ? 'EMAIL_ONLY' : hasAny ? 'NS_ONLY' : 'ABANDONED';
  return { ...out, controlState };
}

// ── Stage 3: FCA / SRA ─────────────────────────────────────────────────────────
function fcaAddress(frn) {
  return new Promise((resolve) => {
    const url = `https://register.fca.org.uk/services/V0.1/Firm/${encodeURIComponent(frn)}/Address`;
    https.get(url, { headers: { 'X-Auth-Email': FCA_EMAIL, 'X-Auth-Key': FCA_KEY } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `HTTP_${res.statusCode}` });
        try { const j = JSON.parse(body); resolve({ found: true, records: j.Data || [] }); }
        catch { resolve({ error: 'PARSE_ERROR' }); }
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
          const j = JSON.parse(body); const d = (j.Data || [])[0] || null;
          resolve({ found: !!d, status: d ? d.Status : null, name: d ? d['Organisation Name'] : null, tradingNames: d ? d['Trading Names'] : null });
        } catch { resolve({ error: 'PARSE_ERROR' }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

// ── Stage 4: Companies House ────────────────────────────────────────────────────
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

// ── Checkpointing ──────────────────────────────────────────────────────────────
function loadCompleted() {
  const done = new Set();
  if (!fs.existsSync(CHECKPOINT)) return done;
  for (const line of fs.readFileSync(CHECKPOINT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).domain); } catch {}
  }
  return done;
}

async function processOne(r, sraByNumber, chRate) {
  const result = {
    domain: r.domain, organisationId: r.organisationId, organisationName: r.organisationName,
    regulators: r.regulators, identifiers: { frn: r.frn, sraIdentifier: r.sraIdentifier, companiesHouseNumber: r.companiesHouseNumber },
  };
  result.stage1 = await stage1(r.domain);
  result.stage2 = await dnsEvidence(r.domain);
  result.stage3 = {};
  if (r.frn) {
    result.stage3.fcaAddress = await fcaAddress(r.frn); await sleep(210);
    result.stage3.fcaStatus = await fcaFirmStatus(r.frn); await sleep(210);
  }
  if (r.sraIdentifier) {
    const sra = sraByNumber.get(String(r.sraIdentifier));
    result.stage3.sra = sra ? {
      authorisationStatus: sra.AuthorisationStatus, tradingNames: sra.TradingNames, previousNames: sra.PreviousNames,
      websites: sra.Websites, officeWebsites: (sra.Offices || []).map(o => o.Website).filter(Boolean), companyRegNo: sra.CompanyRegNo,
    } : null;
  }
  result.stage4 = {};
  const chNumber = r.companiesHouseNumber || (result.stage3.sra && result.stage3.sra.companyRegNo) || null;
  if (chNumber) {
    result.stage4.profile = await chProfile(chNumber, chRate);
    result.stage4.filingHistory = await chFilingHistory(chNumber, chRate);
    result.stage4.companyNumberUsed = chNumber;
  }
  return result;
}

async function pool(items, worker, conc) {
  let idx = 0;
  async function run() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: conc }, run));
}

async function main() {
  const all = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const completed = loadCompleted();
  const remaining = all.filter(r => !completed.has(r.domain));
  console.log(`Total: ${all.length} | already checkpointed: ${completed.size} | remaining: ${remaining.length}`);

  const sraData = JSON.parse(fs.readFileSync(SRA_SNAPSHOT, 'utf8'));
  const sraByNumber = new Map(sraData.Organisations.map(o => [String(o.SraNumber), o]));
  const chRate = createRateManager({});

  const out = fs.createWriteStream(CHECKPOINT, { flags: 'a' });
  let done = 0;
  const startTime = Date.now();
  // Concurrency 12: bounded mainly by the CH/FCA rate managers, not raw HTTP.
  await pool(remaining, async (r) => {
    let result;
    try { result = await processOne(r, sraByNumber, chRate); }
    catch (e) { result = { domain: r.domain, organisationId: r.organisationId, organisationName: r.organisationName, error: e.message }; }
    out.write(JSON.stringify(result) + '\n');
    done++;
    if (done % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ${done}/${remaining.length} (${elapsed}s elapsed)`);
    }
  }, 12);

  await new Promise(res => out.end(res));
  console.log('Stages 1-4 complete for this run.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
