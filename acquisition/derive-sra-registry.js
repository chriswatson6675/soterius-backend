'use strict';

// derive-sra-registry.js — build the canonical SRA Organisation Registry from a
// sealed SRA Collection Package.
//
// SRA analogue of the FCA Population Acquisition step (acquire-fca.js → registry).
// The FCA registry is produced by LIVE acquisition from the FS Register; the SRA
// registry is DERIVED from the immutable SRA Collection Package (the SRA bulk
// register, already acquired and sealed by the frozen `sra-snapshot-collector`). The
// Collection Package remains the authoritative source-specific store; this registry
// is a lean, canonical projection consumed by the (future) SRA Organisation Provider.
//
// It does NOT recollect or perform live acquisition — the input is an existing,
// sealed package. Same lifecycle position as FCA:
//   External Source → Population Acquisition → Organisation Registry → Provider → Observatory
//
// Output (mirrors runs/fca/): runs/sra/registry.ndjson —
// one record per ELIGIBLE organisation — plus manifest.json (generation provenance +
// validation). Eligibility = the organisation has a website that normalises to a
// valid domain; a record with no scannable domain cannot be scanned, so it is
// excluded here (mirrors the FCA provider's no-website exclusion). EVERY non-eligible
// organisation is accounted for by category — nothing is silently discarded.
//
// Registry record (consistent organisation model; identifiers preserved for
// reconciliation; full source-specific detail stays in the Collection Package):
//   { sraNumber, companyNumber, firmName, website, domain, last_scanned, persistedAt }
//
// Determinism: source order preserved; pure transforms; `persistedAt` taken from the
// source package (not wall-clock) → re-deriving from the same package yields a
// byte-identical registry.ndjson.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COHORT_ID = 'SRA-REG-001';
const COHORT_NAME = 'SRA Organisation Registry';
const OUT_DIR = path.join(__dirname, 'runs', 'sra');

// Domain normalisation — identical rules to the FCA provider / IF cohort selection so
// every registry emits domains in the same shape (schema consistency).
function normaliseDomain(raw) {
  if (!raw) return null;
  const d = String(raw).toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
  return d.length ? d : null;
}

// A normalised value is a usable domain iff it is a dotted hostname.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function isValidDomain(d) { return !!d && d.length <= 253 && DOMAIN_RE.test(d); }

// Website selection: prefer the organisation-level `Websites`, then the first office
// that records a `Website` (analogue of FCA's PPOB-address-then-fallback).
function extractWebsite(org) {
  const orgSite = org && org.Websites != null ? String(org.Websites).trim() : '';
  if (orgSite) return orgSite;
  const offices = Array.isArray(org && org.Offices) ? org.Offices : [];
  const off = offices.find((o) => o && o.Website != null && String(o.Website).trim().length > 0);
  return off ? String(off.Website).trim() : '';
}

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Derive registry records + exclusion accounting from a Collection Package directory.
function derive(packageDir) {
  const rawPath = path.join(packageDir, 'raw', 'snapshot.json');
  const manifestPath = path.join(packageDir, 'manifest.json');
  if (!fs.existsSync(rawPath)) throw new Error(`SRA Collection Package raw snapshot not found: ${rawPath}`);
  const pkgManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const body = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const orgs = Array.isArray(body.Organisations) ? body.Organisations : [];
  const persistedAt = pkgManifest.collectionCompletedAt || null;

  const records = [];
  const excluded = { 'no-website': 0, 'malformed-website': 0, 'invalid-domain': 0 };

  for (const org of orgs) {
    const website = extractWebsite(org);
    if (!website) { excluded['no-website']++; continue; }
    const domain = normaliseDomain(website);
    if (!domain) { excluded['malformed-website']++; continue; }
    if (!isValidDomain(domain)) { excluded['invalid-domain']++; continue; }
    records.push({
      sraNumber: org.SraNumber ?? null,
      companyNumber: (org.CompanyRegNo != null && String(org.CompanyRegNo).trim()) ? String(org.CompanyRegNo).trim() : null,
      firmName: org.PracticeName ?? null,
      website,
      domain,
      last_scanned: null,
      persistedAt,
    });
  }
  return { pkgManifest, orgsTotal: orgs.length, records, excluded };
}

// Post-generation validation: duplicate domains (group firms — kept, not dropped),
// duplicate / missing organisation identifiers.
function validate(records) {
  const domainCounts = new Map();
  const idCounts = new Map();
  let missingId = 0;
  for (const r of records) {
    domainCounts.set(r.domain, (domainCounts.get(r.domain) || 0) + 1);
    if (r.sraNumber == null) missingId++;
    else idCounts.set(r.sraNumber, (idCounts.get(r.sraNumber) || 0) + 1);
  }
  const dupDomains = [...domainCounts.entries()].filter(([, c]) => c > 1);
  const dupIds = [...idCounts.entries()].filter(([, c]) => c > 1);
  return {
    distinctDomains: domainCounts.size,
    duplicateDomainGroups: dupDomains.length,
    organisationsSharingADomain: dupDomains.reduce((n, [, c]) => n + c, 0),
    topSharedDomains: dupDomains.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, c]) => ({ domain: d, orgs: c })),
    duplicateIdentifierGroups: dupIds.length,
    recordsMissingIdentifier: missingId,
  };
}

function main() {
  const packageDir = process.argv[2] || process.env.SRA_PACKAGE_DIR;
  if (!packageDir) throw new Error('usage: node derive-sra-registry.js <sra-collection-package-dir>  (or set SRA_PACKAGE_DIR)');

  const { pkgManifest, orgsTotal, records, excluded } = derive(packageDir);
  const excludedTotal = Object.values(excluded).reduce((a, b) => a + b, 0);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const registryPath = path.join(OUT_DIR, 'registry.ndjson');
  fs.writeFileSync(registryPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const registrySha = sha256File(registryPath);

  const manifest = {
    artefactType: 'sra-organisation-registry-manifest',
    cohortId: COHORT_ID,
    cohortName: COHORT_NAME,
    source: {
      type: 'sra-collection-package',
      runId: pkgManifest.runId ?? null,
      collectorVersion: pkgManifest.collectorVersion ?? null,
      sourceAuthority: pkgManifest.sourceAuthority ?? null,
      collectionCompletedAt: pkgManifest.collectionCompletedAt ?? null,
      rawSha256: (pkgManifest.segments && pkgManifest.segments[0] && pkgManifest.segments[0].sha256) || null,
    },
    totals: {
      organisationsInPackage: orgsTotal,
      eligible: records.length,
      excluded: excludedTotal,
      exclusionBreakdown: excluded,
      accountingBalanced: records.length + excludedTotal === orgsTotal,
    },
    validation: validate(records),
    registry: { path: 'runs/sra/registry.ndjson', records: records.length, sha256: registrySha },
    generatedBy: 'derive-sra-registry.js',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

if (require.main === module) main();
module.exports = { normaliseDomain, isValidDomain, extractWebsite, derive, validate, COHORT_ID, COHORT_NAME };
