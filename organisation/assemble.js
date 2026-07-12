'use strict';

// assemble.js — builds a canonical Organisation (schema.js) from whichever
// authoritative identifiers are actually available, per ADR-SYS-010 §2.2 and
// the Organisation Discovery review, Priority 2 ("Generalise Organisation
// assembly so it begins from whichever authoritative identifiers are
// available rather than assuming SRA-first").
//
// One assembly core (assembleFromFacts) now serves both origin paths:
//  - an existing Repository Authority row (assembleFromAuthorityRow)
//  - a freshly resolved, not-yet-in-Repository-Authority discovery
//    (assembleFromDiscovery) — Priority 3's resolveIdentity() isNew case
// Both converge on the identical Organisation shape. There is no second
// assembly path, no scanner-specific or discovery-specific logic.
//
// v0.1 scope unchanged: computed live on every call, no persisted
// Observation log. Every field is either a real adapter fact or an explicit
// null; a missing source produces a null field and a `sourcesUnavailable`
// entry, never a coerced default (OC-4).

const sra = require('./adapters/sra');
const companiesHouse = require('./adapters/companiesHouse');
const observatory = require('./adapters/observatory');
const resolve = require('./resolve');
const { emptyOrganisation } = require('./schema');
const { deriveLifecycle } = require('./lifecycle');
const { deriveClassification, fromCompaniesHouse } = require('./classification');

/**
 * @param {string} orgId - canonical id, from resolve.search() or resolve.resolveIdentity()
 */
async function assembleById(orgId) {
  const reversed = resolve.reverse(orgId);
  if (!reversed.ok) return { ok: false, error: reversed.error };
  const row = reversed.row;
  const ids = row.identifiers || {};
  return assembleFromFacts({
    sraNumber: ids.sraIdentifier || null,
    companiesHouseNumber: ids.companiesHouseNumber || null,
    frn: ids.frn || null,
    name: row.organisationName || row.canonicalName || null,
    domain: row.verifiedDomain || null,
    regulators: row.regulators || [],
  }, orgId);
}

/**
 * Priority 3's isNew path: assemble directly from the identifiers a caller
 * supplied to resolve.resolveIdentity(), when nothing in Repository
 * Authority matched. Nothing is persisted — Phase A. This is the one place
 * a genuinely new organisation can be assembled at all today; without a
 * persisted store, it cannot later be re-fetched by id alone (see the
 * implementation report's constitutional note on this).
 * @param {object} input - the same bag passed to resolve.resolveIdentity()
 * @param {string} organisationId
 */
async function assembleFromDiscovery(input, organisationId) {
  return assembleFromFacts({
    sraNumber: input.sraNumber || null,
    companiesHouseNumber: input.companiesHouseNumber || null,
    frn: input.frn || null,
    name: input.name || null,
    domain: input.domain || null,
    regulators: [],
  }, organisationId);
}

/**
 * The shared assembly core. `facts` is a normalised bag of whichever
 * identifiers are known — from a Repository Authority row OR from raw
 * discovery input, indistinguishably from this point on.
 *
 * `id` is trusted, not recomputed-and-cross-checked, here — and that was a
 * deliberate correction made during verification, not the original design.
 * For assembleById, id already came from Repository Authority's own row: it
 * is the authoritative source, not a claim to re-derive. For
 * assembleFromDiscovery, resolveIdentity() just computed it moments earlier
 * from this exact input via the same normaliseFacts pipeline; recomputing it
 * here would be redundant, not an independent check. A real cross-check
 * attempt during verification (recomputing from a row's *published* fields)
 * produced false-positive mismatches for organisations whose id was assigned
 * from Repository Authority's internal pre-domain-ownership-resolution state
 * (or an internal IF-UUID tier) that isn't fully reproducible from the
 * published row alone — a genuine Repository Authority data-completeness
 * gap, not a resolution bug. See the implementation report.
 */
async function assembleFromFacts(facts, id) {
  const org = emptyOrganisation(id);
  const now = new Date().toISOString();
  org.displayName = facts.name;

  let sraFirm = null;
  let sraAsOf = null;
  if (facts.sraNumber) {
    const sraResult = sra.findBySraNumber(facts.sraNumber);
    org.metadata.sourcesConsulted.push('sra-snapshot');
    if (sraResult.ok) {
      sraFirm = sraResult.firm;
      sraAsOf = sraResult.asOf;
      org.displayName = org.displayName || sraFirm.name;
      org.identifiers.push({ scheme: 'uk.sra.number', value: sraFirm.sraNumber, primary: !facts.companiesHouseNumber });
      org.regulators.push({ regulator: 'SRA', identifier: sraFirm.sraNumber, status: sraFirm.authorisationStatus || null });
      org.provenance.push({
        section: `regulators[${org.regulators.length - 1}]`, source: 'sra-snapshot',
        observedAt: sraAsOf, retrievedAt: now, confidence: 'verified',
      });
    } else {
      org.metadata.sourcesUnavailable.push({ source: 'sra-snapshot', reason: sraResult.error });
    }
  }

  // FRN known (from Repository Authority's batch merge, or supplied directly)
  // but no live FCA adapter exists yet (providers.js: liveAdapter: false) —
  // record the regulator fact from what we do know, honestly labelled as
  // corroborated rather than independently verified.
  if (facts.frn) {
    org.identifiers.push({ scheme: 'uk.fca.frn', value: facts.frn, primary: !facts.companiesHouseNumber && !facts.sraNumber });
    org.regulators.push({ regulator: 'FCA', identifier: facts.frn, status: null });
    org.provenance.push({
      section: `regulators[${org.regulators.length - 1}]`, source: 'authority-dataset',
      observedAt: null, retrievedAt: now, confidence: 'corroborated',
    });
  }

  let legalEntity = sraFirm ? {
    identifier: { scheme: 'uk.sra.number', value: sraFirm.sraNumber },
    legalName: sraFirm.name,
    entityType: sraFirm.constitution || null,
    status: sraFirm.authorisationStatus || null,
    registeredOffice: sraFirm.principalOffice,
    numberOfOffices: sraFirm.numberOfOffices,
  } : null;

  const chNumber = facts.companiesHouseNumber || (sraFirm && sraFirm.companiesHouseNumber) || null;
  if (chNumber) {
    org.identifiers.push({ scheme: 'uk.companieshouse.number', value: chNumber, primary: true });
    const chResult = await companiesHouse.getCompanyProfile(chNumber);
    org.metadata.sourcesConsulted.push('companies-house');
    if (chResult.ok) {
      legalEntity = {
        identifier: { scheme: 'uk.companieshouse.number', value: chResult.company.companyNumber },
        legalName: chResult.company.name,
        entityType: chResult.company.type,
        jurisdiction: chResult.company.jurisdiction,
        incorporatedOn: chResult.company.incorporatedOn,
        status: chResult.company.status,
        registeredOffice: chResult.company.registeredOffice,
        numberOfOffices: legalEntity ? legalEntity.numberOfOffices : undefined,
      };
      org.displayName = org.displayName || chResult.company.name;
      org.provenance.push({
        section: 'legalEntities[0]', source: 'companies-house',
        observedAt: chResult.company.fetchedAt, retrievedAt: now, confidence: 'verified',
      });
      org.classification.push(...deriveClassification(fromCompaniesHouse(chResult.company.sicCodes, chResult.company.fetchedAt)));
    } else {
      // CH number known, but the live fetch failed. If we already have
      // SRA-sourced legalEntity data, it still needs its own provenance
      // record (OC-3) rather than being silently unattributed.
      org.metadata.sourcesUnavailable.push({ source: 'companies-house', reason: chResult.error });
      if (legalEntity) {
        org.provenance.push({
          section: 'legalEntities[0]', source: 'sra-snapshot',
          observedAt: sraAsOf, retrievedAt: now, confidence: 'verified',
        });
      }
    }
  } else if (legalEntity) {
    org.provenance.push({
      section: 'legalEntities[0]', source: 'sra-snapshot',
      observedAt: sraAsOf, retrievedAt: now, confidence: 'verified',
    });
  }
  if (legalEntity) org.legalEntities.push(legalEntity);

  const domain = facts.domain
    || (sraFirm && resolve.domainFromWebsite(sraFirm.principalOffice.website))
    || null;
  if (domain) {
    org.domains.push({ domain, role: 'primary' });
    const trustResult = await observatory.getObservatoryProfile(domain);
    org.metadata.sourcesConsulted.push('soterius-observatory');
    if (trustResult.ok && trustResult.signalsObserved > 0) {
      org.digitalTrust = {
        overallScore: trustResult.overallScore,
        grade: trustResult.grade,
        signalsObserved: trustResult.signalsObserved,
        signalsTotal: trustResult.signalsTotal,
        categories: trustResult.categories,
      };
      org.provenance.push({
        section: 'digitalTrust', source: 'soterius-observatory',
        observedAt: trustResult.fetchedAt, retrievedAt: now, confidence: 'verified',
      });
    } else {
      org.metadata.sourcesUnavailable.push({ source: 'soterius-observatory', reason: 'no signals observed for this domain yet' });
    }
  } else {
    org.metadata.sourcesUnavailable.push({ source: 'soterius-observatory', reason: 'no domain known for this organisation' });
  }

  org.lifecycle = deriveLifecycle(org);

  return { ok: true, organisation: org };
}

module.exports = { assembleById, assembleFromDiscovery, assembleFromFacts };
