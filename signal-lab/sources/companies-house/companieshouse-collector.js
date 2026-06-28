'use strict';

// companieshouse-collector.js — the first production Companies House collector.
//
// Faithfully implements CCS-COMPHOUSE-001 (FROZEN v1.0), which in turn
// implements CCD/EOI/ESD-COMPHOUSE-001. The collector is a faithful executor of
// the Observe operation (ARCHITECTURE.md §5): it captures, with provenance, the
// register's published representation of one evidence object at one moment, and
// EMITS evidence objects suitable for Preserve. It stops at the Preserve
// boundary (CCS §0.2) — it defines what is emitted, not how it is stored.
//
// What it does NOT do (CCS §1.2): interpret, score, derive signals, normalise or
// resolve display values, reconstruct history, build the person graph, decide
// admissibility/category, define storage, resolve truth, auto-cross an entity
// boundary, or repair a failed observation. (N1–N10.)
//
// IMPLEMENTED in this build:
//   - Targeted-Snapshot mode (PDA REST), the anchor-driven core flow (CCS §4.1)
//   - EO-01 multi-resource coherent-moment assembly (R4)
//   - EO-02…EO-05, EO-07, EO-08, EO-09 enumeration with deterministic pagination
//     and list-wrapper discard (R7; §4 step 4)
//   - EO-06 two-step Document API retrieval, binary byte-for-byte (R5; §4 step 5)
//   - EO-10 disqualification (person/enforcement-anchored)
//   - record-not-traverse cross-entity links (R8; §4 step 6)
//   - observed / observed-absence / non-observation classification, kept
//     structurally apart (R9; §8.2)
//   - the coverage record (R12; §3.2–§3.3, §8.1)
//   - emission contract + provenance envelope (R6, R11; §5)
//   - idempotency: immutable=emit-once, mutable=emit-on-change (Part 7)
//
// DEFERRED to a later build (explicitly, to avoid silently implying coverage):
//   - Streaming mode (CCS §4.2) and Bulk-origin mode (§4.3). The architecture
//     here (anchor, scope, mode triple; surface-tagged provenance) is shaped to
//     accept them; `mode` other than 'targeted-snapshot' is rejected, not faked.
//
// Authority: CCS-COMPHOUSE-001 (all parts); EOI/CCD/ESD-COMPHOUSE-001.

const map = require('./endpoint-map');
const prov = require('./provenance');
const client = require('./ch-client');

const SURFACE = { PDA: 'PDA', DOC: 'DOC' };

const COVERAGE_STATUS = Object.freeze({
  OBSERVED: 'OBSERVED',
  OBSERVED_ABSENCE: 'OBSERVED_ABSENCE',
  NON_OBSERVATION: 'NON_OBSERVATION',
});

const NON_OBSERVATION_REASON = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',                 // surface/connection/5xx error (§6)
  INCOMPLETE: 'INCOMPLETE',                   // object not captured in full at a coherent moment (§6; §3.1)
  DOCUMENT_UNAVAILABLE: 'DOCUMENT_UNAVAILABLE', // EO-06 binary unavailable (§6; §8.3)
  RATE_LIMITED: 'RATE_LIMITED',               // 429 — object remains outstanding/resumable (§6; §8.4)
  PARSE_ERROR: 'PARSE_ERROR',                 // representation unparseable
  LIST_TRUNCATED: 'LIST_TRUNCATED',           // pagination could not complete (remainder non-observed)
});

const EMISSION_CLASS = Object.freeze({ IMMUTABLE: 'IMMUTABLE', MUTABLE: 'MUTABLE' });

const MAX_PAGES = 200;          // safety bound on deterministic pagination
const PAGE_SIZE = 100;          // CH list max for most resources

// ── Public entry point ──────────────────────────────────────────────────────────

/**
 * Execute one observation request (CCS Part 2): a triple (anchor, scope, mode).
 * Never throws on observation failure — failures become recorded non-observations
 * (CCS §6). Throws ONLY on a malformed request (a programming error, not an
 * observation outcome).
 *
 * @param {ObservationRequest} request
 * @param {Object} deps
 * @param {string} deps.apiKey
 * @param {Object} [deps.client] - ch-client (injectable for tests)
 * @param {Object} [deps.rateManager]
 * @param {function} [deps.now] - () => ISO string
 * @param {Object} [deps.priorState] - { 'EO-xx:id': {contentHash, etag} } for idempotency (Part 7)
 * @returns {Promise<ObservationResult>}
 */
async function observe(request, deps = {}) {
  const mode = request?.mode ?? 'targeted-snapshot';
  if (mode !== 'targeted-snapshot') {
    throw new Error(`mode '${mode}' is not implemented by this collector build; only 'targeted-snapshot' (CCS §4.1) is available`);
  }
  const anchor = request?.anchor;
  if (!anchor || !anchor.type || anchor.value == null) {
    throw new Error('observation request requires an anchor (CCS §2.1): { type, value }');
  }

  const ctx = _makeContext(request, deps);

  if (anchor.type === 'company') return _targetedSnapshotCompany(anchor, ctx);
  if (anchor.type === 'disqualified-officer') return _observeDisqualification(anchor, ctx);
  throw new Error(`unsupported anchor type '${anchor.type}' (CCS §2.3)`);
}

// ── Context / shared state ───────────────────────────────────────────────────────

function _makeContext(request, deps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const scopeObjects = request?.scope?.objects ?? map.COMPANY_CHILD_OBJECTS;
  const includeDocuments = request?.scope?.includeDocuments === true ||
    (Array.isArray(scopeObjects) && scopeObjects.includes('EO-06'));
  return {
    request,
    apiKey: deps.apiKey,
    client: deps.client ?? client,
    rateManager: deps.rateManager,
    now,
    priorState: deps.priorState ?? {},
    scopeObjects,
    includeDocuments,
    moment: now(),
    out: { emitted: [], observedAbsences: [], nonObservations: [], crossLinks: [] },
  };
}

// ── Targeted-Snapshot: company anchor (CCS §4.1) ─────────────────────────────────

async function _targetedSnapshotCompany(anchor, ctx) {
  const n = String(anchor.value);
  const inScope = map.inScopeCompanyObjects(ctx.scopeObjects);
  const coverage = {
    anchor: { type: 'company', value: n },
    scope: { objects: ['EO-01', ...inScope, ...(ctx.includeDocuments ? ['EO-06'] : [])], includeDocuments: ctx.includeDocuments },
    observationMoment: ctx.moment,
    perObject: {},
    reconciliation: {},
    resumable: true,
  };

  // (3) Observe the anchor — EO-01 (multi-resource coherent-moment assembly).
  const eo01 = await _observeCompanyProfile(n, ctx);
  coverage.perObject['EO-01'] = eo01.coverage;
  if (eo01.coverage.status === COVERAGE_STATUS.NON_OBSERVATION) {
    // No anchor → no context. Coverage cannot proceed (CCS §4 step 3; §3.2).
    coverage.resumable = true;
    coverage.anchorObserved = false;
    return _finalise(ctx, coverage);
  }
  coverage.anchorObserved = true;

  // (4) Enumerate in-scope direct objects from the anchor.
  const docQueue = [];
  for (const eo of inScope) {
    coverage.perObject[eo] = await _observeCompanyChild(eo, n, ctx, docQueue);
  }

  // (5) EO-06 two-step document retrieval for queued EO-05 documents.
  if (ctx.includeDocuments) {
    const docCov = await _observeDocuments(docQueue, n, ctx);
    coverage.perObject['EO-06'] = docCov;
  }

  return _finalise(ctx, coverage);
}

async function _observeCompanyProfile(n, ctx) {
  const ep = ctx.client;
  const profileUri = map.buildUrl(map.PDA, map.EVIDENCE_OBJECTS['EO-01'].path(n));
  const profileRes = await ep.getJson(profileUri, _httpOpts(ctx));
  const requestUris = [profileUri];

  if (profileRes.errorType !== 'NONE') {
    // Anchor could not be observed → recorded non-observation (atomic).
    _recordNonObservation(ctx, 'EO-01', { company_number: n }, _reasonFor(profileRes), {
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
      endpoint: map.EVIDENCE_OBJECTS['EO-01'].endpoint, requestUri: profileUri, httpStatus: profileRes.httpStatus,
    });
    return { coverage: { status: COVERAGE_STATUS.NON_OBSERVATION, reason: _reasonFor(profileRes) } };
  }

  const representation = { ...profileRes.body };
  const resourceEtags = { profile: profileRes.etag };

  // Supporting resources → one coherent EO-01 (R4). 404/410 = observed-absent
  // attribute (null); a hard error makes the multi-resource moment INCOMPLETE
  // → the atomic object becomes a non-observation (CCS §3.1, §8.3).
  for (const sup of map.EVIDENCE_OBJECTS['EO-01'].supporting) {
    const uri = map.buildUrl(map.PDA, sup.path(n));
    const r = await ep.getJson(uri, _httpOpts(ctx));
    requestUris.push(uri);
    if (r.errorType === 'NONE') {
      representation[sup.key] = r.body;
      resourceEtags[sup.key] = r.etag;
    } else if (r.errorType === 'NOT_FOUND' || r.errorType === 'GONE') {
      // registered_office_address may already be on the profile; registers /
      // exemptions absent is a real observed absence of that attribute.
      if (representation[sup.key] === undefined) representation[sup.key] = null;
    } else {
      _recordNonObservation(ctx, 'EO-01', { company_number: n }, NON_OBSERVATION_REASON.INCOMPLETE, {
        observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
        endpoint: map.EVIDENCE_OBJECTS['EO-01'].endpoint, requestUris, httpStatus: r.httpStatus,
      });
      return { coverage: { status: COVERAGE_STATUS.NON_OBSERVATION, reason: NON_OBSERVATION_REASON.INCOMPLETE } };
    }
  }

  const objectIdentity = { objectType: 'EO-01', company_number: n };
  const hash = prov.contentHash(representation);
  const envelope = prov.buildProvenance({
    observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
    endpoint: map.EVIDENCE_OBJECTS['EO-01'].endpoint, requestUris,
    observedObjectId: n, contentHash: hash, etag: profileRes.etag,
  });
  const emittedFlag = _emit(ctx, {
    objectType: 'EO-01', objectIdentity, representation, provenance: envelope,
    emissionClass: EMISSION_CLASS.MUTABLE, etag: profileRes.etag, contentHash: hash,
    relationships: { parent: null, resourceEtags },
  });
  return { coverage: { status: COVERAGE_STATUS.OBSERVED, emitted: emittedFlag, contentHash: hash } };
}

async function _observeCompanyChild(eo, n, ctx, docQueue) {
  const d = map.EVIDENCE_OBJECTS[eo];
  const baseUri = map.buildUrl(map.PDA, d.path(n));
  const paged = await _fetchAllListItems(eo, baseUri, ctx);

  if (paged.fatal) {
    // Could not consult the surface at all → non-observation (§8.2).
    _recordNonObservation(ctx, eo, { company_number: n }, paged.reason, {
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
      endpoint: d.endpoint, requestUris: paged.uris, httpStatus: paged.httpStatus,
    });
    return { status: COVERAGE_STATUS.NON_OBSERVATION, reason: paged.reason };
  }

  if (paged.absent) {
    // Empty-but-successful list, or 404/410 on the child resource = the register
    // was consulted and published nothing → OBSERVED ABSENCE (§8.2).
    _recordObservedAbsence(ctx, eo, n, paged.uris);
    return { status: COVERAGE_STATUS.OBSERVED_ABSENCE, count: 0 };
  }

  let emittedCount = 0;
  for (const item of paged.items) {
    const r = _emitChildItem(eo, d, n, item, ctx, docQueue);
    if (r.emitted) emittedCount++;
  }

  const complete = paged.total == null ? true : paged.items.length >= paged.total;
  if (!complete) {
    // Items we got are observed; the remainder could not be paged → recorded as
    // a non-observation of the list continuation (honest coverage, §8.1).
    _recordNonObservation(ctx, eo, { company_number: n }, NON_OBSERVATION_REASON.LIST_TRUNCATED, {
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
      endpoint: d.endpoint, requestUris: paged.uris, httpStatus: paged.httpStatus,
    });
  }
  return {
    status: COVERAGE_STATUS.OBSERVED,
    count: paged.items.length,
    declaredTotal: paged.total,
    complete,
    emitted: emittedCount,
  };
}

function _emitChildItem(eo, d, n, item, ctx, docQueue) {
  const oid = map.objectId(eo, item);
  const objectIdentity = { objectType: eo, company_number: n, objectId: oid };
  const immutable = d.nature === 'immutable';
  const hash = prov.contentHash(item);

  // Record (do NOT traverse) any cross-entity link (R8; §4 step 6; §5.5).
  const link = map.crossLink(eo, item);
  if (link) ctx.out.crossLinks.push({ from: objectIdentity, link });

  // Queue EO-06 retrieval from EO-05's document metadata link (do not traverse now).
  if (eo === 'EO-05' && ctx.includeDocuments) {
    const docUrl = d.documentMetadataUrl(item);
    if (docUrl) docQueue.push({ parent: objectIdentity, documentMetadataUrl: _absolute(docUrl) });
  }

  const envelope = prov.buildProvenance({
    observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
    endpoint: d.endpoint, requestUris: [map.buildUrl(map.PDA, d.path(n))],
    observedObjectId: `${n}/${oid ?? '?'}`, contentHash: hash, etag: item?.etag ?? null,
  });
  const emitted = _emit(ctx, {
    objectType: eo, objectIdentity, representation: item, provenance: envelope,
    emissionClass: immutable ? EMISSION_CLASS.IMMUTABLE : EMISSION_CLASS.MUTABLE,
    etag: item?.etag ?? null, contentHash: hash,
    relationships: { parent: { objectType: 'EO-01', company_number: n }, crossLink: link ?? null },
  });
  return { emitted };
}

// ── EO-06 two-step document retrieval (CCS §3.1, §4 step 5, §8.3) ────────────────

async function _observeDocuments(docQueue, n, ctx) {
  let observed = 0, absent = 0, nonObs = 0;
  for (const q of docQueue) {
    const metaRes = await ctx.client.getJson(q.documentMetadataUrl, _httpOpts(ctx));
    if (metaRes.errorType !== 'NONE') {
      // Binary/metadata unavailable → EO-06 non-observation; parent EO-05 unaffected.
      _recordNonObservation(ctx, 'EO-06', { document_metadata: q.documentMetadataUrl, parent: q.parent },
        NON_OBSERVATION_REASON.DOCUMENT_UNAVAILABLE, {
          observationTimestamp: ctx.moment, sourceSurface: SURFACE.DOC,
          endpoint: 'GET {document_metadata}', requestUri: q.documentMetadataUrl, httpStatus: metaRes.httpStatus,
        });
      nonObs++; continue;
    }
    const meta = metaRes.body ?? {};
    const documentId = _lastSeg(q.documentMetadataUrl);
    const contentUrl = _absolute(meta?.links?.document) || (q.documentMetadataUrl.replace(/\/+$/, '') + '/content');
    const accept = _preferredContentType(meta);

    const binRes = await ctx.client.getBinary(contentUrl, { ..._httpOpts(ctx), accept });
    if (binRes.errorType !== 'NONE' || !binRes.bytes) {
      _recordNonObservation(ctx, 'EO-06', { document_id: documentId, parent: q.parent },
        NON_OBSERVATION_REASON.DOCUMENT_UNAVAILABLE, {
          observationTimestamp: ctx.moment, sourceSurface: SURFACE.DOC,
          endpoint: 'GET {…}/content', requestUri: contentUrl, httpStatus: binRes.httpStatus,
        });
      nonObs++; continue;
    }

    // The EO-06 representation IS the binary, byte-for-byte (CCS §5.1, R5).
    const bytes = binRes.bytes;
    const hash = prov.contentHash(bytes);
    const objectIdentity = { objectType: 'EO-06', document_id: documentId };
    const envelope = prov.buildProvenance({
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.DOC,
      endpoint: 'GET {document_metadata} → GET {…}/content',
      requestUris: [q.documentMetadataUrl, contentUrl],
      observedObjectId: documentId, contentHash: hash,
      representationObserved: binRes.contentType,
    });
    const representation = {
      metadata: meta,
      contentType: binRes.contentType,
      byteLength: bytes.length,
      contentHash: hash,
      bytesBase64: bytes.toString('base64'),
    };
    const emitted = _emit(ctx, {
      objectType: 'EO-06', objectIdentity, representation, provenance: envelope,
      emissionClass: EMISSION_CLASS.IMMUTABLE, etag: null, contentHash: hash,
      _hashTarget: bytes, // hash is over the bytes, not the wrapper
      relationships: { parent: q.parent },
    });
    if (emitted) observed++;
  }
  const status = docQueue.length === 0 ? COVERAGE_STATUS.OBSERVED_ABSENCE
    : (observed > 0 ? COVERAGE_STATUS.OBSERVED : COVERAGE_STATUS.NON_OBSERVATION);
  return { status, queued: docQueue.length, observed, nonObservations: nonObs };
}

// ── EO-10 disqualification (person/enforcement-anchored, CCS §2.3, §3.1) ─────────

async function _observeDisqualification(anchor, ctx) {
  const officerType = anchor.officerType === 'corporate' ? 'corporate' : 'natural';
  const uri = map.buildUrl(map.PDA, map.EVIDENCE_OBJECTS['EO-10'].path(String(anchor.value), officerType));
  const coverage = {
    anchor: { type: 'disqualified-officer', value: String(anchor.value), officerType },
    scope: { objects: ['EO-10'] }, observationMoment: ctx.moment, perObject: {}, resumable: true,
  };
  const res = await ctx.client.getJson(uri, _httpOpts(ctx));

  if (res.errorType === 'NOT_FOUND' || res.errorType === 'GONE') {
    _recordObservedAbsence(ctx, 'EO-10', String(anchor.value), [uri]);
    coverage.perObject['EO-10'] = { status: COVERAGE_STATUS.OBSERVED_ABSENCE };
    return _finalise(ctx, coverage);
  }
  if (res.errorType !== 'NONE') {
    _recordNonObservation(ctx, 'EO-10', { officer_id: String(anchor.value), officerType }, _reasonFor(res), {
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
      endpoint: map.EVIDENCE_OBJECTS['EO-10'].endpoint, requestUri: uri, httpStatus: res.httpStatus,
    });
    coverage.perObject['EO-10'] = { status: COVERAGE_STATUS.NON_OBSERVATION, reason: _reasonFor(res) };
    return _finalise(ctx, coverage);
  }

  const representation = res.body;
  const hash = prov.contentHash(representation);
  const objectIdentity = { objectType: 'EO-10', officer_id: String(anchor.value), officerType };
  const envelope = prov.buildProvenance({
    observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
    endpoint: map.EVIDENCE_OBJECTS['EO-10'].endpoint, requestUris: [uri],
    observedObjectId: String(anchor.value), contentHash: hash, etag: res.etag,
  });
  const emitted = _emit(ctx, {
    objectType: 'EO-10', objectIdentity, representation, provenance: envelope,
    emissionClass: EMISSION_CLASS.MUTABLE, etag: res.etag, contentHash: hash,
    relationships: { parent: null },
  });
  coverage.perObject['EO-10'] = { status: COVERAGE_STATUS.OBSERVED, emitted, contentHash: hash };
  return _finalise(ctx, coverage);
}

// ── Deterministic pagination (CCS §4 step 4; §8.2 reproducibility) ───────────────

async function _fetchAllListItems(eo, baseUri, ctx) {
  const items = [];
  const uris = [];
  let total = null;
  let httpStatus = null;
  let firstPage = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    const startIndex = page * PAGE_SIZE;
    const uri = `${baseUri}?items_per_page=${PAGE_SIZE}&start_index=${startIndex}`;
    const r = await ctx.client.getJson(uri, _httpOpts(ctx));
    uris.push(uri);
    httpStatus = r.httpStatus;

    if (r.errorType === 'NOT_FOUND' || r.errorType === 'GONE') {
      // Consulted, none present (for this resource class) → observed absence.
      if (firstPage) return { absent: true, items: [], total: 0, uris, httpStatus };
      break; // a later page 404 ends pagination cleanly
    }
    if (r.errorType !== 'NONE') {
      if (firstPage) return { fatal: true, reason: _reasonFor(r), uris, httpStatus };
      // mid-list failure: return what we have; caller records the gap.
      return { items, total, uris, httpStatus };
    }

    const batch = map.extractItems(eo, r.body);
    if (firstPage) total = map.extractTotal(eo, r.body);
    items.push(...batch);
    firstPage = false;

    if (batch.length === 0) break;                       // no more items
    if (total != null && items.length >= total) break;   // reached declared total
    if (batch.length < PAGE_SIZE) break;                 // short page = last page
  }

  if (items.length === 0 && total === 0) return { absent: true, items: [], total: 0, uris, httpStatus };
  if (items.length === 0) return { absent: true, items: [], total: total ?? 0, uris, httpStatus };
  return { items, total, uris, httpStatus };
}

// ── Emission + idempotency (CCS §5, Part 7) ──────────────────────────────────────

function _emit(ctx, obj) {
  const key = _idemKey(obj.objectType, obj.objectIdentity);
  const prior = ctx.priorState[key];

  // Part 7: immutable → emit once; mutable → emit on change; unchanged → nothing.
  if (prior) {
    if (obj.emissionClass === EMISSION_CLASS.IMMUTABLE) return false; // capture-once
    // The CONTENT HASH is the canonical change detector (CCS §7.2). The etag is
    // a cheap pre-check only and must NOT suppress emission on its own: for the
    // multi-resource EO-01 the profile etag does not cover the supporting
    // resources (registered-office / registers / exemptions), so an etag match
    // can mask a genuine content change and silently drop a snapshot (H1).
    const unchanged = prior.contentHash != null && prior.contentHash === obj.contentHash;
    if (unchanged) return false;
  }

  const emitted = {
    objectType: obj.objectType,
    objectIdentity: obj.objectIdentity,
    observationIdentity: prov.observationIdentity(obj.objectIdentity, ctx.moment, obj.contentHash),
    emissionClass: obj.emissionClass,
    representation: obj.representation,
    provenance: obj.provenance,
    relationships: obj.relationships ?? { parent: null },
  };
  ctx.out.emitted.push(emitted);
  return true;
}

function _recordObservedAbsence(ctx, objectType, anchorValue, requestUris) {
  ctx.out.observedAbsences.push({
    objectType,
    classification: COVERAGE_STATUS.OBSERVED_ABSENCE,
    anchor: anchorValue,
    provenance: {
      observationTimestamp: ctx.moment, sourceSurface: SURFACE.PDA,
      requestUris, source: prov.SOURCE, collectorVersion: prov.COLLECTOR_VERSION,
    },
    note: 'register consulted; no object of this class published (Unknown ≠ Absent: this IS an observation of absence)',
  });
}

function _recordNonObservation(ctx, objectType, target, reason, attempt) {
  ctx.out.nonObservations.push({
    objectType,
    classification: COVERAGE_STATUS.NON_OBSERVATION,
    target,
    reason,
    attemptProvenance: prov.attemptProvenance(attempt),
    note: 'could not consult the register; this is a property of the observation, not the entity (CCS §6)',
  });
}

function _finalise(ctx, coverage) {
  const metrics = {
    emitted: ctx.out.emitted.length,
    observedAbsences: ctx.out.observedAbsences.length,
    nonObservations: ctx.out.nonObservations.length,
    crossLinks: ctx.out.crossLinks.length,
  };
  return { ...ctx.out, coverage, metrics };
}

// ── small helpers ────────────────────────────────────────────────────────────────

function _httpOpts(ctx) {
  return { apiKey: ctx.apiKey, rateManager: ctx.rateManager };
}

function _idemKey(objectType, identity) {
  // Company-scoped ids (appointment_id / psc_id / statement id / charge_id, and
  // the weak insolvency composite) are unique only WITHIN a company (CCS §5.2;
  // EOI §2.1). The key must carry the full composite identity so the same local
  // id at two different companies cannot collide in prior-state (H2). Globally
  // unique identities (EO-01 company_number, EO-06 document_id, EO-10 officer_id)
  // keep their single-id form.
  if (identity.company_number != null && identity.objectId != null) {
    return `${objectType}:${identity.company_number}/${identity.objectId}`;
  }
  const id = identity.objectId ?? identity.company_number ?? identity.document_id ?? identity.officer_id ?? '?';
  return `${objectType}:${id}`;
}

function _reasonFor(res) {
  switch (res.errorType) {
    case 'RATE_LIMITED': return NON_OBSERVATION_REASON.RATE_LIMITED;
    case 'PARSE_ERROR':  return NON_OBSERVATION_REASON.PARSE_ERROR;
    default:             return NON_OBSERVATION_REASON.UNAVAILABLE;
  }
}

function _absolute(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return map.DOC + url; // document links are DOC-host relative
  return url;
}

function _lastSeg(url) { return map._lastSegment(url); }

function _preferredContentType(meta) {
  const resources = meta?.resources;
  if (resources && typeof resources === 'object') {
    const keys = Object.keys(resources);
    // Prefer PDF, then iXBRL/xhtml, else the first advertised representation.
    if (keys.includes('application/pdf')) return 'application/pdf';
    const xhtml = keys.find(k => k.includes('xhtml') || k.includes('xml'));
    if (xhtml) return xhtml;
    if (keys.length) return keys[0];
  }
  return 'application/pdf';
}

module.exports = {
  observe,
  COVERAGE_STATUS,
  NON_OBSERVATION_REASON,
  EMISSION_CLASS,
  SURFACE,
  // exported for tests
  _fetchAllListItems,
  _preferredContentType,
  _absolute,
  _idemKey,
};

/**
 * @typedef {Object} ObservationRequest
 * @property {{type:'company'|'disqualified-officer', value:string, officerType?:'natural'|'corporate'}} anchor
 * @property {{objects?:string[], includeDocuments?:boolean}} [scope]
 * @property {'targeted-snapshot'} [mode]
 */
/**
 * @typedef {Object} ObservationResult
 * @property {Array} emitted - emitted evidence objects (CCS §5)
 * @property {Array} observedAbsences - observed-absence records (§8.2)
 * @property {Array} nonObservations - recorded non-observations (§6)
 * @property {Array} crossLinks - recorded-not-traversed cross-entity links (§4.1)
 * @property {Object} coverage - the coverage record (§3.2–§3.3, §8.1)
 * @property {Object} metrics
 */
