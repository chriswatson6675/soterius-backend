'use strict';

/*
 * build.js — deterministic build of the canonical Organisation Dataset.
 *
 *   Repository Authority: one record per real-world organisation, exactly once,
 *   with an immutable Organisation ID, merged from every legacy registry.
 *
 * Deterministic & reproducible: no clocks, no randomness, no network. All inputs
 * are repo files (regulator registries + the frozen Observatory snapshot in
 * inputs/observed-domains.ndjson). Re-running produces byte-identical output.
 *
 * Run: node backend/authority/build.js
 * Outputs (backend/authority/dataset/ and backend/authority/reports/):
 *   organisations.ndjson · pending.ndjson · domains.ndjson
 *   reconciliation-report.md · duplicate-resolution-report.md
 *   orphan-observations.md · coverage-report.md
 */

const fs = require('fs');
const path = require('path');
const N = require('./lib/normalise');
const { UnionFind } = require('./lib/unionfind');
const L = require('./loaders');
const Identity = require('../organisation/identity');

const OUT_DATASET = path.join(__dirname, 'dataset');
const OUT_REPORTS = path.join(__dirname, 'reports');
fs.mkdirSync(OUT_DATASET, { recursive: true });
fs.mkdirSync(OUT_REPORTS, { recursive: true });

const sha = Identity.sha;
const writeNdjson = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load every source record.
// ─────────────────────────────────────────────────────────────────────────────
console.error('Loading sources…');
const ch = L.loadCompaniesHouse();
const observed = L.loadObservedDomains();

let records = [].concat(
  L.loadFcaRegistry(),
  L.loadSraRegistry(),
  L.loadInvestmentFirms(),
  L.loadIf001('full'),
  L.loadIf001('pilot'),
  L.loadHe(),
  L.loadPra(),
  L.loadGc1(),
  // ENG-024 WP-3 — a source added as a row, per ARCHITECTURE.md §6 ("new
  // evidence sources extend the platform without changing the constitutional
  // architecture"). Empty until the first admin upload via
  // backend/api/routes/population-imports.js.
  L.loadHmrcAmlImport(),
);

// Assign a stable record id and normalise identifiers in one pass.
records.forEach((r, i) => {
  r.recId = `rec:${r.source}:${i}`;
  // IF-001 domains carry no company number; recover it via the CH firm.id link.
  if (!r.companyNumber && r.ifUuid && ch.uuidToCompanyNumber.has(r.ifUuid)) {
    r.companyNumber = ch.uuidToCompanyNumber.get(r.ifUuid);
    r.chLinkedViaUuid = true;
  }
  r.k = {
    frn: N.normaliseNumericId(r.frn),
    sra: N.normaliseNumericId(r.sraNumber),
    ukprn: N.normaliseNumericId(r.ukprn),
    cn: N.normaliseCompanyNumber(r.companyNumber),
    uuid: r.ifUuid || null,
    // GCN-004 register-identifier namespace members (ENG-030 §2 items 1-2).
    // No loader populates frcAudit/hmrcAml/pbsFirm yet (no FRC/HMRC-AML/PBS
    // source is wired into the source list above) — these are additive,
    // present-but-unpopulated fields until a future WP wires one in.
    frcAudit: N.normaliseRegisterId(r.frcAudit),
    hmrcAml: N.normaliseRegisterId(r.hmrcAml),
    pbsFirm: N.normaliseRegisterId(r.pbsFirm),
    lei: N.normaliseLei(r.lei),
  };
  r.domain = N.normaliseDomain(r.domainRaw);
  r.normName = N.normaliseName(r.name);
});

const perSource = {};
for (const r of records) {
  perSource[r.source] = perSource[r.source] || { records: 0 };
  perSource[r.source].records++;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Merge — union-find over STRONG identifiers only (never by domain alone).
//    Shared identity: company number, FRN, SRA number, FRC audit-firm
//    registration number, HMRC AML registration number, permissioned-PBS
//    firm id, UKPRN, IF uuid, LEI (GCN-004 §F — the last four added per the
//    Repository Authority integration package, ENG-030; ENG-031 verified
//    zero impact on the existing dataset before this was wired in).
// ─────────────────────────────────────────────────────────────────────────────
console.error(`Merging ${records.length} source records…`);
const uf = new UnionFind();
const mergeStats = { cn: 0, frn: 0, sra: 0, frcAudit: 0, hmrcAml: 0, pbsFirm: 0, ukprn: 0, uuid: 0, lei: 0 };
for (const r of records) {
  uf.add(r.recId);
  const keys = [];
  if (r.k.cn) keys.push(['cn', `cn:${r.k.cn}`]);
  if (r.k.frn) keys.push(['frn', `frn:${r.k.frn}`]);
  if (r.k.sra) keys.push(['sra', `sra:${r.k.sra}`]);
  if (r.k.frcAudit) keys.push(['frcAudit', `frcAudit:${r.k.frcAudit}`]);
  if (r.k.hmrcAml) keys.push(['hmrcAml', `hmrcAml:${r.k.hmrcAml}`]);
  if (r.k.pbsFirm) keys.push(['pbsFirm', `pbsFirm:${r.k.pbsFirm}`]);
  if (r.k.ukprn) keys.push(['ukprn', `ukprn:${r.k.ukprn}`]);
  if (r.k.uuid) keys.push(['uuid', `uuid:${r.k.uuid}`]);
  if (r.k.lei) keys.push(['lei', `lei:${r.k.lei}`]);
  for (const [, key] of keys) uf.union(r.recId, key);
}

// Group records by their union-find root (only 'rec:' nodes are real records).
const recById = new Map(records.map((r) => [r.recId, r]));
const groups = new Map(); // root -> record[]
for (const r of records) {
  const root = uf.find(r.recId);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Build one organisation per group.
// ─────────────────────────────────────────────────────────────────────────────
const pick = (arr) => arr.find((v) => v != null && v !== '') || null;

function chooseName(recs) {
  const sorted = [...recs].sort((a, b) =>
    (a.namePriority - b.namePriority) || a.provenance.key.localeCompare(b.provenance.key));
  return sorted.find((r) => r.name)?.name || null;
}

// Adapts the batch build's internal `org` shape into organisation/identity.js's
// flat identifiers contract — resolves the same name/domain fallback chain
// the original inline implementation did. Shape adaptation only; the
// precedence itself lives exclusively in organisation/identity.js
// (ADR-SYS-010 OC-6 — one implementation, not two).
function identifiersOf(org) {
  return {
    companiesHouseNumber: org.identifiers.companiesHouseNumber,
    frn: org.identifiers.frn,
    sraNumber: org.identifiers.sraIdentifier,
    // GCN-004 register-identifier namespace members (ENG-030 §2 item 5) —
    // reach organisation/identity.js's already-implemented precedence
    // branches for the first time via this adapter. identity.js itself is
    // unchanged; this only feeds it fields it already knows how to rank.
    frcAudit: org.identifiers.frcAudit,
    hmrcAml: org.identifiers.hmrcAml,
    pbsFirm: org.identifiers.pbsFirm,
    ukprn: org.identifiers.ukprn,
    ifUuid: org._ifUuids.length ? [...org._ifUuids].sort()[0] : null,
    lei: org.identifiers.lei,
    normalisedName: org.normalisedName || org.organisationName || null,
    domain: org._candidates[0]?.domain || null,
  };
}

// Deterministic immutable id: derived from the strongest identifier present,
// so it is stable across rebuilds and independent of record order.
function primaryKeyOf(org) {
  return Identity.primaryKeyOf(identifiersOf(org));
}

const orgs = [];
for (const [root, recs] of groups) {
  const regulators = [...new Set(recs.map((r) => r.regulator).filter(Boolean))].sort();
  const frns = [...new Set(recs.map((r) => r.k.frn).filter(Boolean))].sort();
  const sras = [...new Set(recs.map((r) => r.k.sra).filter(Boolean))].sort();
  const ukprns = [...new Set(recs.map((r) => r.k.ukprn).filter(Boolean))].sort();
  const cns = [...new Set(recs.map((r) => r.k.cn).filter(Boolean))].sort();
  // GCN-004 additions (ENG-030 §2 item 4). `leis` now dedupes on the
  // normalised value (r.k.lei), matching every other identifier's pattern —
  // previously this deduped on the raw r.lei string (harmless while lei was
  // storage-only, but inconsistent now that it's a merge/precedence input).
  const leis = [...new Set(recs.map((r) => r.k.lei).filter(Boolean))].sort();
  const frcAudits = [...new Set(recs.map((r) => r.k.frcAudit).filter(Boolean))].sort();
  const hmrcAmls = [...new Set(recs.map((r) => r.k.hmrcAml).filter(Boolean))].sort();
  const pbsFirms = [...new Set(recs.map((r) => r.k.pbsFirm).filter(Boolean))].sort();
  const ifUuids = [...new Set(recs.map((r) => r.ifUuid).filter(Boolean))].sort();
  const sources = [...new Set(recs.map((r) => r.source))].sort();

  const companyNumber = cns[0] || null;
  const chProfile = companyNumber ? (ch.profileByCompanyNumber.get(companyNumber) || null) : null;

  const displayName = chooseName(recs);
  const canonicalName = (chProfile && chProfile.registeredName) || displayName;

  // SIC codes: CH profile first, else any FCA registry record's sicCodes.
  let sicCodes = chProfile && chProfile.sicCodes.length ? chProfile.sicCodes
    : [...new Set(recs.flatMap((r) => r.sicCodes || []))];
  sicCodes = [...new Set(sicCodes)].sort();

  // Candidate domains (dedupe by domain; keep the most authoritative source).
  const candMap = new Map();
  for (const r of recs) {
    if (!r.domain) continue;
    const prev = candMap.get(r.domain);
    const prio = r.domainPriority == null ? 99 : r.domainPriority;
    if (!prev || prio < prev.priority) {
      candMap.set(r.domain, {
        domain: r.domain, source: r.domainSource, priority: prio,
        authoritative: r.domainPriority != null, date: r.sourceDate,
        provenance: r.provenance,
      });
    }
  }
  const candidates = [...candMap.values()].sort((a, b) => a.priority - b.priority || a.domain.localeCompare(b.domain));

  const noDomainAsserted = candidates.length === 0 && recs.some((r) => r.noDomainAsserted);

  orgs.push({
    _root: root,
    _recs: recs,
    _sources: sources,
    _ifUuids: ifUuids,
    _candidates: candidates,
    _noDomainAsserted: noDomainAsserted,
    _frnConflict: frns.length > 1,
    _cnConflict: cns.length > 1,
    organisationId: null, // assigned after primary key
    organisationName: displayName,
    canonicalName,
    normalisedName: N.normaliseName(canonicalName),
    regulators,
    identifiers: {
      frn: frns[0] || null,
      praIdentifier: null, // PRA issues no separate id; membership tracked via regulators + FRN
      sraIdentifier: sras[0] || null,
      ukprn: ukprns[0] || null,
      companiesHouseNumber: companyNumber,
      lei: leis[0] || null,
      // GCN-004 register identifiers (ENG-030 §2 item 4) — no loader
      // populates these yet, so these are always null until a future WP
      // wires in a source for one of them.
      frcAudit: frcAudits[0] || null,
      hmrcAml: hmrcAmls[0] || null,
      pbsFirm: pbsFirms[0] || null,
    },
    companiesHouse: chProfile,
    sicCodes,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Assign immutable Organisation IDs (deterministic, collision-safe).
// ─────────────────────────────────────────────────────────────────────────────
const idSeen = new Map();
// Sort by primary key so any (astronomically unlikely) hash collision is broken
// deterministically rather than by iteration order.
orgs.sort((a, b) => primaryKeyOf(a).localeCompare(primaryKeyOf(b)));
for (const org of orgs) {
  const pk = primaryKeyOf(org);
  let id = Identity.canonicalOrgId(identifiersOf(org));
  if (idSeen.has(id)) {
    let n = 2;
    while (idSeen.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  idSeen.set(id, org);
  org.organisationId = id;
  org._primaryKey = pk;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Global domain ownership — every domain resolves to exactly ONE org.
//    No duplicate verified domains: the best-priority claimant owns it.
// ─────────────────────────────────────────────────────────────────────────────
const domainClaims = new Map(); // domain -> [{orgId, priority, cand}]
for (const org of orgs) {
  for (const c of org._candidates) {
    if (!domainClaims.has(c.domain)) domainClaims.set(c.domain, []);
    domainClaims.get(c.domain).push({ orgId: org.organisationId, priority: c.priority, cand: c });
  }
}
const domainOwner = new Map();   // domain -> orgId
const domainContest = new Map(); // domain -> competing orgIds (excluding owner)
for (const [domain, claims] of domainClaims) {
  claims.sort((a, b) => a.priority - b.priority || a.orgId.localeCompare(b.orgId));
  domainOwner.set(domain, claims[0].orgId);
  if (claims.length > 1) domainContest.set(domain, claims.slice(1).map((c) => c.orgId));
}

const orgById = new Map(orgs.map((o) => [o.organisationId, o]));

// ─────────────────────────────────────────────────────────────────────────────
// 6. Per-org: verified domain, status, Observatory coverage, pending reasons.
// ─────────────────────────────────────────────────────────────────────────────
const tierOf = (domain) => {
  const o = observed.get(domain);
  if (!o) return 'none';
  if (o.has_complete) return 'complete';
  if (o.has_catd) return 'catD';
  return 'core';
};

for (const org of orgs) {
  const ownedAuthoritative = org._candidates.filter(
    (c) => c.authoritative && domainOwner.get(c.domain) === org.organisationId);
  const verified = ownedAuthoritative[0] || null;

  org.candidateDomains = org._candidates.map((c) => ({
    domain: c.domain,
    source: c.source,
    authoritative: c.authoritative,
    owner: domainOwner.get(c.domain) === org.organisationId,
    observed: observed.has(c.domain),
  }));

  if (verified) {
    org.domainStatus = 'VERIFIED';
    org.verifiedDomain = verified.domain;
    org.verification = {
      source: verified.source,
      method: verified.source === 'observatory-if001' ? 'observatory-validated' : 'authoritative-registry-field',
      date: verified.date,
      provenance: verified.provenance,
    };
  } else if (org._noDomainAsserted) {
    org.domainStatus = 'NO_DOMAIN';
    org.verifiedDomain = null;
    org.verification = null;
  } else {
    org.domainStatus = 'PENDING';
    org.verifiedDomain = null;
    org.verification = null;
  }

  // Observatory: evidence attaches to the domain OWNER only, so each observed
  // domain counts for exactly one organisation (no double-counting across orgs
  // that merely share a domain as a losing candidate).
  const observedCands = org.candidateDomains.filter((c) => c.observed && c.owner);
  let tier = 'none';
  for (const c of observedCands) {
    const t = tierOf(c.domain);
    if (t === 'complete') { tier = 'complete'; break; }
    if (t === 'catD' && tier !== 'complete') tier = 'catD';
    else if (t === 'core' && tier === 'none') tier = 'core';
  }
  org.observatory = {
    observed: observedCands.length > 0,
    tier,
    verifiedDomainObserved: !!(org.verifiedDomain && observed.has(org.verifiedDomain)),
    completeTrustProfile: tier === 'complete',
  };

  // Pending workflow reasons (spec §PENDING WORKFLOW).
  if (org.domainStatus === 'PENDING') {
    const reasons = [];
    if (org._candidates.length === 0) reasons.push('no-domain-candidate');
    if (org._candidates.length > 0 && !verified) reasons.push('unverified-or-contested-candidate');
    if (org.candidateDomains.some((c) => !c.owner)) reasons.push('domain-owned-by-other-organisation');
    if (org._candidates.length > 1) reasons.push('multiple-candidate-domains');
    // GCN-004 additions (ENG-030 §2 item 4): frcAudit/hmrcAml/pbsFirm/lei are
    // now strong-identifier members too (GCN-004 §F) — included here so an
    // org anchored only on one of them is not misreported as having no
    // strong identifier at all.
    if (!org.identifiers.frn && !org.identifiers.sraIdentifier && !org.identifiers.ukprn
      && !org.identifiers.companiesHouseNumber && !org.identifiers.frcAudit
      && !org.identifiers.hmrcAml && !org.identifiers.pbsFirm && !org.identifiers.lei) {
      reasons.push('no-strong-identifier');
    }
    if (org._frnConflict || org._cnConflict) reasons.push('conflicting-identifiers');
    org.pendingReasons = [...new Set(reasons)];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Emit dataset files.
// ─────────────────────────────────────────────────────────────────────────────
function publicOrg(org) {
  return {
    organisationId: org.organisationId,
    organisationName: org.organisationName,
    canonicalName: org.canonicalName,
    normalisedName: org.normalisedName,
    regulators: org.regulators,
    identifiers: org.identifiers,
    companiesHouse: org.companiesHouse,
    sicCodes: org.sicCodes,
    domainStatus: org.domainStatus,
    verifiedDomain: org.verifiedDomain,
    verification: org.verification,
    candidateDomains: org.candidateDomains,
    observatory: org.observatory,
    pendingReasons: org.pendingReasons || [],
    provenance: { sources: org._sources, recordCount: org._recs.length },
  };
}

const sortedOrgs = [...orgs].sort((a, b) => a.organisationId.localeCompare(b.organisationId));
const publicOrgs = sortedOrgs.map(publicOrg);
writeNdjson(path.join(OUT_DATASET, 'organisations.ndjson'), publicOrgs);

const pendingOrgs = sortedOrgs.filter((o) => o.domainStatus === 'PENDING');
writeNdjson(path.join(OUT_DATASET, 'pending.ndjson'), pendingOrgs.map((o) => ({
  organisationId: o.organisationId,
  organisationName: o.organisationName,
  regulators: o.regulators,
  identifiers: o.identifiers,
  candidateDomains: o.candidateDomains,
  pendingReasons: o.pendingReasons,
  provenance: { sources: o._sources },
})));

// domains.ndjson — one row per distinct domain (single owner) + orphans.
const allCandidateDomains = new Set(domainOwner.keys());
const domainRows = [];
for (const [domain, ownerId] of [...domainOwner.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const owner = orgById.get(ownerId);
  const cand = owner._candidates.find((c) => c.domain === domain);
  domainRows.push({
    domain,
    organisationId: ownerId,
    status: cand.authoritative ? 'verified' : 'candidate',
    source: cand.source,
    method: cand.source === 'observatory-if001' ? 'observatory-validated'
      : (cand.authoritative ? 'authoritative-registry-field' : 'unapproved-manual'),
    verificationDate: cand.date,
    observed: observed.has(domain),
    observationTier: tierOf(domain),
    contested: domainContest.has(domain),
    competingOrganisationIds: domainContest.get(domain) || [],
  });
}
// Orphan observed domains (no organisation candidate anywhere).
const orphanDomains = [...observed.keys()].filter((d) => !allCandidateDomains.has(d)).sort();
for (const domain of orphanDomains) {
  domainRows.push({
    domain,
    organisationId: null,
    status: 'orphan',
    source: 'observatory-only',
    method: null,
    verificationDate: null,
    observed: true,
    observationTier: tierOf(domain),
    contested: false,
    competingOrganisationIds: [],
  });
}
writeNdjson(path.join(OUT_DATASET, 'domains.ndjson'), domainRows);

// ─────────────────────────────────────────────────────────────────────────────
// 8. Reports.
// ─────────────────────────────────────────────────────────────────────────────
// Provenance-recovery reconciliation: how many of SLG-039's 954 "orphan"
// domains this build reclaims by extracting FCA-registry websites (which the
// census never did) and the IF-001 pilot cohort.
const fcaRegistryDomains = new Set(records.filter((r) => r.source === 'fca-registry' && r.domain).map((r) => r.domain));
const nonFcaCandidateDomains = new Set(records.filter((r) => r.source !== 'fca-registry' && r.domain).map((r) => r.domain));
const censusOrphans = [...observed.keys()].filter((d) => !nonFcaCandidateDomains.has(d));
const recoveredByFca = censusOrphans.filter((d) => fcaRegistryDomains.has(d));
const recovery = {
  censusOrphans: censusOrphans.length,
  recoveredByFcaRegistry: recoveredByFca.length,
  recoveredByOther: censusOrphans.length - recoveredByFca.length - orphanDomains.length,
  remainingOrphans: orphanDomains.length,
};

require('./reports').generate({
  orgs: publicOrgs, orphanDomains, observed, domainOwner, domainContest,
  domainRows, perSource, records, ch, recovery, outDir: OUT_REPORTS,
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. STOP summary.
// ─────────────────────────────────────────────────────────────────────────────
const verifiedCount = sortedOrgs.filter((o) => o.domainStatus === 'VERIFIED').length;
const pendingCount = sortedOrgs.filter((o) => o.domainStatus === 'PENDING').length;
const noDomainCount = sortedOrgs.filter((o) => o.domainStatus === 'NO_DOMAIN').length;
const withEvidence = sortedOrgs.filter((o) => o.observatory.observed).length;
const complete = sortedOrgs.filter((o) => o.observatory.completeTrustProfile).length;
const multiRegulator = sortedOrgs.filter((o) => o.regulators.length > 1).length;
const mergedAway = records.length - sortedOrgs.length;
const verifiedDomains = domainRows.filter((d) => d.status === 'verified').length;

const summary = {
  totalOrganisations: sortedOrgs.length,
  verifiedDomains: verifiedCount,
  distinctVerifiedDomains: verifiedDomains,
  pendingOrganisations: pendingCount,
  noDomainOrganisations: noDomainCount,
  duplicatesMerged: mergedAway,
  crossRegulatorOrganisations: multiRegulator,
  organisationsWithObservatoryEvidence: withEvidence,
  organisationsWithCompleteTrustProfile: complete,
  orphanObservations: orphanDomains.length,
  sourceRecordsIn: records.length,
};
fs.writeFileSync(path.join(OUT_DATASET, 'build-summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.error('\n════════════════ CANONICAL ORGANISATION DATASET ════════════════');
for (const [k, v] of Object.entries(summary)) console.error(`  ${k.padEnd(38)} ${v}`);
console.error('═════════════════════════════════════════════════════════════════');

// ─────────────────────────────────────────────────────────────────────────────
// 10. Integrity Report — measurement only (Repository Authority Integrity Review).
//     Reads the dataset just written and emits authority/reports/integrity-report.*.
//     It observes; it changes nothing above. Isolated in try/catch so a reporting
//     fault can never invalidate an otherwise-good build — the dataset is the
//     product, the report is measurement of it.
// ─────────────────────────────────────────────────────────────────────────────
require('./integrity-report')
  .generate()
  .then((s) => {
    console.error(`\nIntegrity report — health: ${s.health.overall} | reconstructable: ${s.metrics.reconstructability.reconstructablePercent}% | strong-id collisions: ${s.metrics.identityIntegrity.strongIdentifierCollisions} | review groups: ${s.metrics.transparency.identityReviewGroups}`);
  })
  .catch((e) => console.error(`\nIntegrity report generation failed (dataset unaffected): ${e.message}`));
