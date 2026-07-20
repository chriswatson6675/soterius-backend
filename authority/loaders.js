'use strict';

// Source loaders for the canonical Organisation Dataset.
//
// Every loader returns an array of *source records* in one common shape:
//
//   {
//     source,            // stable source id (e.g. 'fca-registry')
//     regulator,         // 'FCA' | 'SRA' | 'HE' | 'PRA' | null
//     name,              // raw organisation name
//     namePriority,      // lower = more authoritative display name
//     frn, sraNumber, ukprn, companyNumber, lei, ifUuid,  // identifiers (raw)
//     frcAudit, hmrcAml, pbsFirm,  // GCN-004 register identifiers (raw; not
//                        //   yet populated by any loader below — no source
//                        //   here is FRC/HMRC-AML/PBS-scoped. Documented so
//                        //   the shape here mirrors organisation/identity.js's
//                        //   GCN-004 precedence chain and batch-adapter-
//                        //   contract.js's CANONICAL_RECORD_FIELDS exactly)
//     domainRaw,         // raw website string as found (or null)
//     domainSource,      // 'fca-website' | 'sra-website' | 'he-website' |
//                        //   'observatory-if001' | 'manual-gc1' | null
//     domainPriority,    // authoritative-source rank (lower = better); null if not authoritative
//     noDomainAsserted,  // source positively records "no website"
//     sourceDate,        // ISO date of the source snapshot
//     provenance,        // { file, key }
//   }
//
// Identifiers are returned RAW; normalisation happens once in build.js so the
// rules live in exactly one place (lib/normalise.js).

const fs = require('fs');
const path = require('path');
const { parseCsv, parseCsvWithHeader } = require('./lib/csv');

const ROOT = path.join(__dirname, '..', '..'); // repo root (soterius/)
const BACKEND = path.join(__dirname, '..');

// Authoritative verified-domain source priority (spec §DOMAIN VERIFICATION).
const DOMAIN_PRIORITY = {
  'fca-website': 1,
  'sra-website': 2,
  'he-website': 3,
  'observatory-if001': 4,
  // 'manual-gc1' is UNAPPROVED manual input → candidate only, never authoritative.
};

const readLines = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);

// ── FCA Organisation Registry ────────────────────────────────────────────────
// backend/acquisition/runs/fca/registry.ndjson — FRN + company number + PPOB
// Website Address + SIC codes. The single richest governed registry.
function loadFcaRegistry() {
  const file = path.join(BACKEND, 'acquisition', 'runs', 'fca', 'registry.ndjson');
  const out = [];
  for (const line of readLines(file)) {
    const r = JSON.parse(line);
    const firm = Array.isArray(r.firm) && r.firm[0] ? r.firm[0] : {};
    const addresses = Array.isArray(r['firm.address']) ? r['firm.address'] : [];
    const hasSite = (a) => a && String(a['Website Address'] || '').trim().length > 0;
    const ppob = addresses.find((a) => hasSite(a) && /principal place of business/i.test(a['Address Type'] || ''));
    const fallback = addresses.find(hasSite);
    const website = (ppob || fallback) ? (ppob || fallback)['Website Address'] : '';
    out.push({
      source: 'fca-registry',
      regulator: 'FCA',
      name: firm['Organisation Name'] || null,
      namePriority: 2,
      frn: r.frn || firm.FRN || null,
      sraNumber: null,
      ukprn: null,
      companyNumber: r.companyNumber || firm['Companies House Number'] || null,
      lei: null,
      ifUuid: null,
      domainRaw: website || null,
      domainSource: website ? 'fca-website' : null,
      domainPriority: website ? DOMAIN_PRIORITY['fca-website'] : null,
      noDomainAsserted: false, // an empty FCA website field is "unknown", not "none"
      sicCodes: Array.isArray(r.sicCodes) ? r.sicCodes : [],
      status: firm.Status || null,
      sourceDate: r.persistedAt || '2026-06-30',
      provenance: { file: 'backend/acquisition/runs/fca/registry.ndjson', key: `FRN:${r.frn}` },
    });
  }
  return out;
}

// ── SRA Organisation Registry (whole register, from the sealed snapshot) ──────
// Reads the authoritative SRA Collection Package raw snapshot directly (the
// re-acquired live-004 whole-register document) and ingests EVERY organisation —
// not just the website-bearing ones the derived registry.ndjson kept. Each org is
// classified inline with the same eligibility rules as derive-sra-registry.js:
//   valid domain   → sra-website candidate (VERIFIED/PENDING downstream)
//   invalid website → website claimed but unusable → PENDING (no usable candidate)
//   no website      → NO_DOMAIN (positively asserts no public website)
const SRA_SNAPSHOT_PATH = process.env.SRA_SNAPSHOT_PATH
  || path.join(BACKEND, 'collection', 'sources', 'sra', 'runs', 'live-004', 'raw', 'snapshot.json');
const SRA_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const isValidSraDomain = (d) => !!d && d.length <= 253 && SRA_DOMAIN_RE.test(d);

function extractSraWebsite(org) {
  const orgSite = org && org.Websites != null ? String(org.Websites).trim() : '';
  if (orgSite) return orgSite;
  const offices = Array.isArray(org && org.Offices) ? org.Offices : [];
  const off = offices.find((o) => o && o.Website != null && String(o.Website).trim().length > 0);
  return off ? String(off.Website).trim() : '';
}

function loadSraRegistry() {
  const body = JSON.parse(fs.readFileSync(SRA_SNAPSHOT_PATH, 'utf8'));
  const orgs = Array.isArray(body.Organisations) ? body.Organisations : [];
  const sourceDate = '2026-07-06T23:08:41.671Z'; // live-004 collectionCompletedAt
  const rel = 'backend/collection/sources/sra/runs/live-004/raw/snapshot.json';
  const out = [];
  for (const org of orgs) {
    const website = extractSraWebsite(org);
    const normalised = website ? String(website).toLowerCase()
      .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').trim() : '';
    const usable = isValidSraDomain(normalised) ? normalised : null;
    out.push({
      source: 'sra-registry',
      regulator: 'SRA',
      name: org.PracticeName || null,
      namePriority: 3,
      frn: null,
      sraNumber: org.SraNumber != null ? String(org.SraNumber) : null,
      ukprn: null,
      companyNumber: (org.CompanyRegNo != null && String(org.CompanyRegNo).trim()) ? String(org.CompanyRegNo).trim() : null,
      lei: null,
      ifUuid: null,
      domainRaw: usable,
      domainSource: usable ? 'sra-website' : null,
      domainPriority: usable ? DOMAIN_PRIORITY['sra-website'] : null,
      // Only a genuinely absent website asserts NO_DOMAIN. A present-but-invalid
      // website is a claimed (unusable) site → PENDING, not NO_DOMAIN.
      noDomainAsserted: website.length === 0,
      sicCodes: [],
      status: org.AuthorisationStatus || null,
      sourceDate,
      provenance: { file: rel, key: `SRA:${org.SraNumber}` },
    });
  }
  return out;
}

// ── FCA Investment Firms (IF-003 source) + Companies House enrichment ─────────
// FRN + name (no domain). Enrichment adds the company number by FRN.
function loadInvestmentFirms() {
  const srcFile = path.join(ROOT, 'datasets', 'cohorts', 'investment_firms', 'if003', 'source', 'investment-firms.csv');
  const enrFile = path.join(ROOT, 'datasets', 'cohorts', 'investment_firms', 'if003', 'enrichment', 'companies-house-enrichment.csv');

  // Enrichment: frn -> { companyNumber, companyName, lei }
  const enrichRows = parseCsv(fs.readFileSync(enrFile, 'utf8'));
  const enrHeader = enrichRows[0];
  const idx = (h) => enrHeader.indexOf(h);
  const byFrn = new Map();
  for (let i = 1; i < enrichRows.length; i++) {
    const row = enrichRows[i];
    const frn = row[idx('frn')];
    if (!frn) continue;
    byFrn.set(frn, {
      companyNumber: row[idx('company_number')] || null,
      lei: row[idx('lei')] || null,
    });
  }

  const rows = parseCsv(fs.readFileSync(srcFile, 'utf8'));
  const header = rows[0]; // FRN, Organisation Name, LEI, Status, ...
  const fi = header.indexOf('FRN');
  const ni = header.indexOf('Organisation Name');
  const li = header.findIndex((h) => /Legal Entity Identifier/i.test(h));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const frn = row[fi];
    if (!frn) continue;
    const enr = byFrn.get(frn) || {};
    out.push({
      source: 'fca-investment-firms',
      regulator: 'FCA',
      name: row[ni] || null,
      namePriority: 4,
      frn,
      sraNumber: null,
      ukprn: null,
      companyNumber: enr.companyNumber || null,
      lei: (li >= 0 ? row[li] : null) || enr.lei || null,
      ifUuid: null,
      domainRaw: null,
      domainSource: null,
      domainPriority: null,
      noDomainAsserted: false,
      sicCodes: [],
      status: null,
      sourceDate: '2026-06-14',
      provenance: { file: 'datasets/cohorts/investment_firms/if003/source/investment-firms.csv', key: `FRN:${frn}` },
    });
  }
  return out;
}

// ── IF-001 cohort manifests (archived) ───────────────────────────────────────
// The ONLY place the investment firms' validated, Observatory-observed domains
// survive. id === Companies House run's firm.id, so these link through CH
// resolution to a company number (done in build.js).
function loadIf001(which) {
  const file = which === 'pilot'
    ? path.join(ROOT, 'archive', 'signal-lab', 'if001-pilot', 'cohort-manifest.json')
    : path.join(ROOT, 'archive', 'signal-lab', 'if001-full', 'cohort-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const firms = manifest.firms || manifest.organisations || [];
  const rel = which === 'pilot'
    ? 'archive/signal-lab/if001-pilot/cohort-manifest.json'
    : 'archive/signal-lab/if001-full/cohort-manifest.json';
  return firms.map((f) => ({
    source: which === 'pilot' ? 'if-001-pilot' : 'if-001',
    regulator: 'FCA',
    name: f.firm_name || null,
    namePriority: 6,
    frn: null,
    sraNumber: null,
    ukprn: null,
    companyNumber: null, // resolved via CH firm.id in build.js
    lei: null,
    ifUuid: f.id || null,
    domainRaw: f.domain || null,
    domainSource: f.domain ? 'observatory-if001' : null,
    domainPriority: f.domain ? DOMAIN_PRIORITY['observatory-if001'] : null,
    noDomainAsserted: false,
    sicCodes: [],
    status: null,
    sourceDate: manifest.selected_at || '2026-06-17',
    provenance: { file: rel, key: `IF:${f.id}` },
  }));
}

// ── HE / Higher Education learning providers ─────────────────────────────────
// UKPRN + name + website. An empty WEBSITE_URL is a genuine "no website"
// assertion (e.g. Escape Studios).
function loadHe() {
  const file = path.join(BACKEND, 'data', 'uk-learning-providers-20260615.csv');
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  const ui = header.indexOf('UKPRN');
  const ni = header.indexOf('PROVIDER_NAME');
  const wi = header.indexOf('WEBSITE_URL');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const website = (row[wi] || '').trim();
    out.push({
      source: 'he-001',
      regulator: 'HE',
      name: row[ni] || null,
      namePriority: 5,
      frn: null,
      sraNumber: null,
      ukprn: row[ui] || null,
      companyNumber: null,
      lei: null,
      ifUuid: null,
      domainRaw: website || null,
      domainSource: website ? 'he-website' : null,
      domainPriority: website ? DOMAIN_PRIORITY['he-website'] : null,
      noDomainAsserted: website.length === 0,
      sicCodes: [],
      status: null,
      sourceDate: '2026-06-15',
      provenance: { file: 'backend/data/uk-learning-providers-20260615.csv', key: `UKPRN:${row[ui]}` },
    });
  }
  return out;
}

// ── PRA reference lists (5 raw Bank of England CSVs) ──────────────────────────
// Name + FRN (+ LEI on some). No domains. Header sits below a preamble.
function loadPra({ praDataDir } = {}) {
  const dir = praDataDir ? path.resolve(praDataDir) : path.join(ROOT, 'datasets', 'cohort data', 'pra');
  const files = [
    'pra-banks-2606.csv', 'pra-building-societies-2606.csv',
    'pra-credit-unions-2606.csv', 'pra-insurers-2606.csv', 'pra-designated-firms.csv',
  ];
  const matchHeader = (cells) => cells.some((c) => /^firm name$/i.test(c.trim())) && cells.some((c) => /^frn$/i.test(c.trim()));
  const out = [];
  const seenPerFile = new Set();
  for (const fname of files) {
    const p = path.join(dir, fname);
    if (!fs.existsSync(p)) continue;
    const { header, rows } = parseCsvWithHeader(fs.readFileSync(p, 'utf8'), matchHeader);
    if (!header) continue;
    const nameKey = header.find((h) => /^firm name$/i.test(h.trim()));
    const frnKey = header.find((h) => /^frn$/i.test(h.trim()));
    const leiKey = header.find((h) => /^lei$/i.test(h.trim()));
    for (const row of rows) {
      // Some PRA files are multi-section (e.g. "Banks incorporated outside
      // the UK" / "UK banks" / ...), each preceded by its own repeated
      // column-header line. parseCsvWithHeader locks onto the FIRST such
      // line as the canonical header; every later repeat then parses as an
      // ordinary data row unless explicitly recognised and skipped here —
      // reusing the exact same predicate that found the real header in the
      // first place (matchHeader), so a section repeat is caught regardless
      // of a later section's header using slightly different wording for a
      // column matchHeader doesn't itself check (e.g. "LEI" vs "Head Office
      // LEI" — confirmed present in pra-banks-2606.csv; ENG-031).
      if (matchHeader(Object.values(row))) continue;
      const frn = (row[frnKey] || '').trim();
      const name = (row[nameKey] || '').trim();
      if (!name) continue;
      // The insurers file repeats a firm per regulated activity — dedupe by FRN.
      const dedupeKey = `${fname}|${frn || name}`;
      if (seenPerFile.has(dedupeKey)) continue;
      seenPerFile.add(dedupeKey);
      out.push({
        source: 'pra-reference',
        regulator: 'PRA',
        name,
        namePriority: 4,
        frn: frn || null,
        sraNumber: null,
        ukprn: null,
        companyNumber: null,
        lei: leiKey ? (row[leiKey] || null) : null,
        ifUuid: null,
        domainRaw: null,
        domainSource: null,
        domainPriority: null,
        noDomainAsserted: false,
        sicCodes: [],
        status: null,
        sourceDate: '2026-06-26',
        provenance: { file: `datasets/cohort data/pra/${fname}`, key: frn ? `FRN:${frn}` : `NAME:${name}` },
      });
    }
  }
  return out;
}

// ── gc1 manual fintech list (unapproved) ─────────────────────────────────────
function loadGc1() {
  const file = path.join(ROOT, 'datasets', 'gc1', 'firms.txt');
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  const ni = header.indexOf('firm_name');
  const di = header.indexOf('domain');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const domain = (row[di] || '').trim();
    out.push({
      source: 'gc1-manual',
      regulator: null,
      name: row[ni] || null,
      namePriority: 7,
      frn: null,
      sraNumber: null,
      ukprn: null,
      companyNumber: null,
      lei: null,
      ifUuid: null,
      domainRaw: domain || null,
      domainSource: domain ? 'manual-gc1' : null,
      domainPriority: null, // unapproved manual → candidate only, never authoritative
      noDomainAsserted: false,
      sicCodes: [],
      status: null,
      sourceDate: '2026-06-01',
      provenance: { file: 'datasets/gc1/firms.txt', key: `NAME:${row[ni]}` },
    });
  }
  return out;
}

// ── Companies House enrichment (full run c2b93ed2) ───────────────────────────
// Not a population — an enrichment layer keyed by company number. Returns two
// maps: profileByCompanyNumber and uuidToCompanyNumber (from resolution).
function loadCompaniesHouse() {
  const runDir = path.join(BACKEND, 'collection', 'sources', 'companies-house', 'runs',
    'c2b93ed2-7dbe-40cc-960f-e1035439408a');
  const profileByCompanyNumber = new Map();
  const uuidToCompanyNumber = new Map();

  const eo1 = path.join(runDir, 'evidence', 'EO-01.ndjson');
  for (const line of readLines(eo1)) {
    const o = JSON.parse(line);
    const rep = o.representation || {};
    const cn = rep.company_number;
    if (cn && !profileByCompanyNumber.has(cn)) {
      profileByCompanyNumber.set(cn, {
        registeredName: rep.company_name || null,
        companyStatus: rep.company_status || null,
        incorporationDate: rep.date_of_creation || null,
        sicCodes: Array.isArray(rep.sic_codes) ? rep.sic_codes : [],
        jurisdiction: rep.jurisdiction || null,
      });
    }
    if (o.firm && o.firm.id && cn) uuidToCompanyNumber.set(o.firm.id, cn);
  }

  const resFile = path.join(runDir, 'resolution.ndjson');
  for (const line of readLines(resFile)) {
    const o = JSON.parse(line);
    if (o.status === 'RESOLVED' && o.firm && o.firm.id && o.companyNumber) {
      uuidToCompanyNumber.set(o.firm.id, o.companyNumber);
    }
  }

  return {
    profileByCompanyNumber,
    uuidToCompanyNumber,
    runId: 'c2b93ed2-7dbe-40cc-960f-e1035439408a',
  };
}

// ── HMRC AML import (ENG-024 WP-3 — Population Onboarding, admin upload) ─────
// Reads back the canonical records the WP-2 HMRC AML Batch Adapter
// (backend/pae/adapters/hmrc-aml, via runBatchAdapter) already emitted for
// the most recent admin-uploaded register — the upload route
// (backend/api/routes/population-imports.js) writes them here. This loader
// performs no parsing/validation/normalisation of its own: that already
// happened once, in the adapter, per the WP-1 contract (ENG-018 §3 — never
// duplicated). Mirrors loadObservedDomains()'s exact pattern immediately
// below: a synchronous read of a pre-materialised ndjson snapshot, so
// build.js's fully-synchronous load step needs no change to accommodate a
// source whose own parsing (ODS/jszip) is unavoidably async — the
// asynchronous adapter run happens once, upstream, in the upload route; this
// loader only ever does a synchronous file read, exactly like every other
// loader in this file.
function loadHmrcAmlImport() {
  const file = path.join(__dirname, 'inputs', 'hmrc-aml-import.ndjson');
  if (!fs.existsSync(file)) return [];
  return readLines(file).map((line) => JSON.parse(line));
}

// ── Frozen Observatory observation set ───────────────────────────────────────
function loadObservedDomains() {
  const file = path.join(__dirname, 'inputs', 'observed-domains.ndjson');
  const map = new Map(); // domain -> { has_catd, has_complete }
  for (const line of readLines(file)) {
    const o = JSON.parse(line);
    map.set(o.domain, { has_catd: !!o.has_catd, has_complete: !!o.has_complete });
  }
  return map;
}

module.exports = {
  DOMAIN_PRIORITY,
  loadFcaRegistry,
  loadSraRegistry,
  loadInvestmentFirms,
  loadIf001,
  loadHe,
  loadPra,
  loadGc1,
  loadHmrcAmlImport,
  loadCompaniesHouse,
  loadObservedDomains,
};
