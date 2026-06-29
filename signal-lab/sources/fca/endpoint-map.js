'use strict';

// endpoint-map.js — declarative FCA endpoint catalogue (data, not logic).
//
// Reference Collector v0.1 — PHASE 3 (IMP-FCA-001 §3; CCS-FCA-001 §5.1).
//
// Encodes, as pure data + pure functions, the logical-endpoint catalogue of the
// FS Register: each endpoint's id, family, parent, within-entity dependency,
// path builder, pagination expectation, and a descriptive response type. It also
// carries the small amount of within-entity navigation needed to build grandchild
// requests (a requirement reference; a passport country) — these are *dependency
// selectors* read from documented parent keys, NOT structured evidence extraction
// (CCS-FCA-001 §5.2 sanctions following within-entity links).
//
// It embeds NO execution logic, NO I/O, and assigns NO meaning. New FCA endpoints
// can be added here without touching the execution engine [CR-FCA-04/15].
//
// Cross-entity links (an AR's FRN, an individual-CF firm URL, a CIS operator URL,
// the Companies House number, the website) are FIELD VALUES inside responses —
// they are deliberately NOT catalogue entries, so the engine cannot traverse them
// [CR-FCA-13].
//
// Authority: CCS-FCA-001 §5.1, §5.2; EOI-FCA-001 (object families, pagination
//   facts); ESD-FCA-001 §4; CCD-FCA-001 CR-FCA-04/13/15.

const enc = encodeURIComponent;

// Deterministic execution order per family: parent first, then children, then
// grandchildren after their dependency parent (CCS-FCA-001 §5.2) [CR-FCA-02].
const FIRM_ORDER = [
  'firm',
  'firm.names',
  'firm.address',
  'firm.permissions',
  'firm.requirements',
  'firm.requirements.investmentTypes',
  'firm.individuals',
  'firm.cf',
  'firm.ar',
  'firm.regulators',
  'firm.disciplinaryHistory',
  'firm.waivers',
  'firm.exclusions',
  'firm.passports',
  'firm.passports.permission',
];
const INDIVIDUAL_ORDER = ['individual', 'individual.cf', 'individual.disciplinaryHistory'];
const PRODUCT_ORDER = ['cis', 'cis.names', 'cis.subfund'];

const FAMILY_ORDER = { firm: FIRM_ORDER, individual: INDIVIDUAL_ORDER, product: PRODUCT_ORDER };

// `paginated` records the OBSERVED expectation (EOI-FCA-001). The engine follows
// `ResultInfo.Next` whenever present regardless, so correctness never relies on
// this flag — it is documentation.
const ENDPOINTS = {
  // ── Firm family (anchor: FRN) ──────────────────────────────────────────────
  'firm': { family: 'firm', parent: null, responseType: 'single', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}` },
  'firm.names': { family: 'firm', parent: 'firm', responseType: 'names', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/Names` },
  'firm.address': { family: 'firm', parent: 'firm', responseType: 'list', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}/Address` },
  'firm.permissions': { family: 'firm', parent: 'firm', responseType: 'dynamic-map', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/Permissions` },
  'firm.requirements': { family: 'firm', parent: 'firm', responseType: 'list', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}/Requirements` },
  'firm.requirements.investmentTypes': { family: 'firm', parent: 'firm.requirements', dependsOn: 'firm.requirements',
    responseType: 'list', paginated: false, perDependencyId: true,
    path: (frn, ref) => `/Firm/${enc(frn)}/Requirements/${enc(ref)}/InvestmentTypes`,
    // within-entity dependency: read requirement references from documented keys (CCS §5.2)
    dependencyFromParent: (parentBody) => (parentBody && Array.isArray(parentBody.Data) ? parentBody.Data : [])
      .map((r) => r && r['Requirement Reference']).filter(Boolean) },
  'firm.individuals': { family: 'firm', parent: 'firm', responseType: 'list', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/Individuals` },
  'firm.cf': { family: 'firm', parent: 'firm', responseType: 'dynamic-map-cf', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/CF` },
  'firm.ar': { family: 'firm', parent: 'firm', responseType: 'ar', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/AR` },
  'firm.regulators': { family: 'firm', parent: 'firm', responseType: 'list', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}/Regulators` },
  'firm.disciplinaryHistory': { family: 'firm', parent: 'firm', responseType: 'list', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/DisciplinaryHistory` },
  'firm.waivers': { family: 'firm', parent: 'firm', responseType: 'list', paginated: true,
    path: (frn) => `/Firm/${enc(frn)}/Waivers` },
  'firm.exclusions': { family: 'firm', parent: 'firm', responseType: 'list', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}/Exclusions` },
  'firm.passports': { family: 'firm', parent: 'firm', responseType: 'passports', paginated: false,
    path: (frn) => `/Firm/${enc(frn)}/Passports` },
  'firm.passports.permission': { family: 'firm', parent: 'firm.passports', dependsOn: 'firm.passports',
    responseType: 'list', paginated: false, perDependencyId: true,
    path: (frn, country) => `/Firm/${enc(frn)}/Passports/${enc(country)}/Permission`,
    dependencyFromParent: (parentBody) => {
      const arr = parentBody && Array.isArray(parentBody.Data) && parentBody.Data[0] && Array.isArray(parentBody.Data[0].Passports)
        ? parentBody.Data[0].Passports : [];
      return arr.map((p) => p && p.Country).filter(Boolean);
    } },

  // ── Individual family (anchor: IRN) ────────────────────────────────────────
  'individual': { family: 'individual', parent: null, responseType: 'single', paginated: false,
    path: (irn) => `/Individuals/${enc(irn)}` },
  'individual.cf': { family: 'individual', parent: 'individual', responseType: 'dynamic-map-cf', paginated: false,
    path: (irn) => `/Individuals/${enc(irn)}/CF` },
  'individual.disciplinaryHistory': { family: 'individual', parent: 'individual', responseType: 'list', paginated: false,
    path: (irn) => `/Individuals/${enc(irn)}/DisciplinaryHistory` },

  // ── Product family / Collective Investment Schemes (anchor: PRN) ────────────
  'cis': { family: 'product', parent: null, responseType: 'single', paginated: false,
    path: (prn) => `/CIS/${enc(prn)}` },
  'cis.names': { family: 'product', parent: 'cis', responseType: 'list', paginated: false,
    path: (prn) => `/CIS/${enc(prn)}/Names` },
  'cis.subfund': { family: 'product', parent: 'cis', responseType: 'list', paginated: true,
    path: (prn) => `/CIS/${enc(prn)}/Subfund` },
};

// ── Pure helpers ─────────────────────────────────────────────────────────────────

/** The deterministic execution order for a family, optionally filtered to a subset (order preserved). */
function orderFor(family, subset) {
  const full = FAMILY_ORDER[family];
  if (!full) throw new Error(`unknown family '${family}'`);
  if (!Array.isArray(subset)) return [...full];
  const want = new Set(subset);
  return full.filter((id) => want.has(id));
}

function def(id) { return ENDPOINTS[id] ?? null; }

function pathFor(id, anchor, dependencyId) {
  const d = ENDPOINTS[id];
  if (!d) throw new Error(`unknown endpoint '${id}'`);
  return d.path(anchor, dependencyId);
}

function isPaginated(id) { return !!(ENDPOINTS[id] && ENDPOINTS[id].paginated); }

function dependencyParent(id) { return ENDPOINTS[id] ? (ENDPOINTS[id].dependsOn ?? null) : null; }

/** Extract within-entity dependency ids (requirement refs; passport countries) from a parent body. */
function dependencyIds(id, parentBody) {
  const d = ENDPOINTS[id];
  if (!d || typeof d.dependencyFromParent !== 'function') return [];
  return d.dependencyFromParent(parentBody) || [];
}

module.exports = {
  ENDPOINTS,
  FAMILY_ORDER, FIRM_ORDER, INDIVIDUAL_ORDER, PRODUCT_ORDER,
  orderFor, def, pathFor, isPaginated, dependencyParent, dependencyIds,
};
