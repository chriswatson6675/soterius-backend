'use strict';

// endpoint-map.js — EO → endpoint mapping (CCS-COMPHOUSE-001 Part 3)
//
// Encodes, as data, the mapping from each preserved evidence object
// (EO-01…EO-10, EOI-COMPHOUSE-001) to the Companies House endpoints required to
// observe it, plus the small amount of shape-knowledge needed to (a) extract
// each item from its list wrapper and discard the wrapper (CCS §4 step 4;
// EOI §3.3), (b) read the register's `total_results`/`total_count` for coverage
// reconciliation (CCS §8.1), and (c) derive each object's company-scoped
// identity (CCS §5.2; EOI §2.1).
//
// It is pure data + pure functions: no I/O, no meaning assignment.
//
// Authority: CCS-COMPHOUSE-001 Part 3; EOI-COMPHOUSE-001 §1, §2.

// Company-scoped in-scope object set (CCS §2.2). EO-01 is the anchor itself;
// EO-06 is reached from EO-05; EO-10 is person/enforcement-anchored.
const COMPANY_CHILD_OBJECTS = ['EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-07', 'EO-08', 'EO-09'];

const PDA = 'https://api.company-information.service.gov.uk';
const DOC = 'https://document-api.company-information.service.gov.uk';

// Each descriptor is faithful to CCS §3.1. `listKey`/`totalKey` are null for
// single-resource objects. `idFrom` derives the object-scoped identifier.
const EVIDENCE_OBJECTS = {
  'EO-01': {
    name: 'Company', anchor: 'company', nature: 'mutable', kind: 'single',
    endpoint: 'GET /company/{company_number}',
    path: (n) => `/company/${encodeURIComponent(n)}`,
    // Multi-resource assembly into ONE coherent EO-01 (CCS §4 step 3; R4).
    supporting: [
      { key: 'registered_office_address', path: (n) => `/company/${encodeURIComponent(n)}/registered-office-address` },
      { key: 'registers',                 path: (n) => `/company/${encodeURIComponent(n)}/registers` },
      { key: 'exemptions',                path: (n) => `/company/${encodeURIComponent(n)}/exemptions` },
    ],
  },
  'EO-02': {
    name: 'Officer Appointment', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/officers',
    path: (n) => `/company/${encodeURIComponent(n)}/officers`,
    listKey: 'items', totalKey: 'total_results',
    idFrom: (item) => _lastSegment(item?.links?.self),
    // officer_id is a recorded-but-NOT-traversed cross-entity link (CCS §4.1; R8).
    crossLink: (item) => {
      const oid = _segmentBefore(item?.links?.officer?.appointments, 'appointments');
      return oid ? { type: 'officer_id', value: oid } : null;
    },
  },
  'EO-03': {
    name: 'PSC', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/persons-with-significant-control',
    path: (n) => `/company/${encodeURIComponent(n)}/persons-with-significant-control`,
    listKey: 'items', totalKey: 'total_results',
    idFrom: (item) => _lastSegment(item?.links?.self),
    // A corporate PSC's identification is a recorded cross-link to another entity.
    crossLink: (item) => {
      const kind = item?.kind;
      if (kind && String(kind).startsWith('corporate-entity')) {
        return { type: 'corporate_psc', value: item?.name ?? null, identification: item?.identification ?? null };
      }
      return null;
    },
  },
  'EO-04': {
    name: 'PSC Statement', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/persons-with-significant-control-statements',
    path: (n) => `/company/${encodeURIComponent(n)}/persons-with-significant-control-statements`,
    listKey: 'items', totalKey: 'total_results',
    idFrom: (item) => _lastSegment(item?.links?.self) ?? item?.statement_id ?? null,
  },
  'EO-05': {
    name: 'Filing Event', anchor: 'company', nature: 'immutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/filing-history',
    path: (n) => `/company/${encodeURIComponent(n)}/filing-history`,
    listKey: 'items', totalKey: 'total_count',
    idFrom: (item) => item?.transaction_id ?? _lastSegment(item?.links?.self),
    // EO-05 → EO-06 link (CCS §3.1; §4 step 5).
    documentMetadataUrl: (item) => item?.links?.document_metadata ?? null,
  },
  'EO-06': {
    name: 'Filed Document', anchor: 'document', nature: 'immutable', kind: 'document',
    endpoint: 'GET {document_metadata} then GET {…}/content',
    // No anchor path — reached via EO-05.documentMetadataUrl (two-step, CCS §3.1).
  },
  'EO-07': {
    name: 'Charge', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/charges',
    path: (n) => `/company/${encodeURIComponent(n)}/charges`,
    listKey: 'items', totalKey: 'total_count',
    idFrom: (item) => item?.id ?? _lastSegment(item?.links?.self),
  },
  'EO-08': {
    name: 'Insolvency Case', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/insolvency',
    path: (n) => `/company/${encodeURIComponent(n)}/insolvency`,
    // Insolvency returns a `cases` array, no total (EOI §2.2 — weak/composite id).
    listKey: 'cases', totalKey: null,
    idFrom: (item) => _insolvencyCompositeId(item),
  },
  'EO-09': {
    name: 'UK Establishment', anchor: 'company', nature: 'mutable', kind: 'list',
    endpoint: 'GET /company/{company_number}/uk-establishments',
    path: (n) => `/company/${encodeURIComponent(n)}/uk-establishments`,
    listKey: 'items', totalKey: 'total_results',
    // A BR-numbered establishment is itself a company_number (EOI §2).
    idFrom: (item) => item?.company_number ?? _lastSegment(item?.links?.self),
  },
  'EO-10': {
    name: 'Disqualification', anchor: 'disqualified-officer', nature: 'mutable', kind: 'single',
    endpoint: 'GET /disqualified-officers/{natural|corporate}/{officer_id}',
    // officerType ∈ {natural, corporate}
    path: (id, officerType) => `/disqualified-officers/${officerType}/${encodeURIComponent(id)}`,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** In-scope company-child objects for a declared scope (CCS §2.2). */
function inScopeCompanyObjects(scopeObjects) {
  if (!Array.isArray(scopeObjects)) return [...COMPANY_CHILD_OBJECTS];
  return COMPANY_CHILD_OBJECTS.filter((eo) => scopeObjects.includes(eo));
}

/** Extract the array of item representations from a list body, discarding the wrapper. */
function extractItems(objectType, body) {
  const d = EVIDENCE_OBJECTS[objectType];
  if (!d || d.kind !== 'list' || body == null) return [];
  const arr = body[d.listKey];
  return Array.isArray(arr) ? arr : [];
}

/** The register's declared total for a list, or null where the register gives none. */
function extractTotal(objectType, body) {
  const d = EVIDENCE_OBJECTS[objectType];
  if (!d || d.totalKey == null || body == null) return null;
  const t = body[d.totalKey];
  return Number.isInteger(t) ? t : null;
}

/** Company-scoped/object identity for one item (CCS §5.2). */
function objectId(objectType, item) {
  const d = EVIDENCE_OBJECTS[objectType];
  return d && typeof d.idFrom === 'function' ? d.idFrom(item) : null;
}

/** Recorded-not-traversed cross-entity link for an item, or null (CCS §4.1; §5.5). */
function crossLink(objectType, item) {
  const d = EVIDENCE_OBJECTS[objectType];
  return d && typeof d.crossLink === 'function' ? d.crossLink(item) : null;
}

function buildUrl(host, path) { return host.replace(/\/+$/, '') + path; }

function _lastSegment(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0].replace(/\/+$/, '');
  const seg = clean.split('/').filter(Boolean).pop();
  return seg || null;
}

function _segmentBefore(url, marker) {
  if (!url || typeof url !== 'string') return null;
  const segs = url.split('?')[0].split('/').filter(Boolean);
  const i = segs.indexOf(marker);
  return i > 0 ? segs[i - 1] : null;
}

function _insolvencyCompositeId(c) {
  if (!c || typeof c !== 'object') return null;
  // Weak composite recorded as-presented (EOI §2.2).
  const parts = [c.number, c.type, Array.isArray(c.dates) ? (c.dates.find(d => d.type === 'wound-up-on' || d.type)?.date) : null];
  const id = parts.filter(Boolean).join('|');
  return id || null;
}

module.exports = {
  EVIDENCE_OBJECTS,
  COMPANY_CHILD_OBJECTS,
  PDA, DOC,
  inScopeCompanyObjects,
  extractItems,
  extractTotal,
  objectId,
  crossLink,
  buildUrl,
  _lastSegment, _segmentBefore,
};
