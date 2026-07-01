'use strict';

// snapshot-source.js — declarative definition of the SRA dataset acquisition surface.
//
// SRA Snapshot Collector v0.1 — Observe layer.
//
// PURE DATA + a pure locator helper. NO business logic: it does not fetch, retry,
// preserve, or interpret. It declares WHAT to acquire and WHERE the operational
// markers live within the payload, so that acquire-snapshot.js can execute it
// generically. When the SRA Technical Document is available, ONLY this file changes.
//
// The thin SRA analogue of the FCA endpoint-map — but with NO dependency graph,
// NO per-anchor traversal: the SRA surface is a whole-dataset snapshot.
//
// Segmentation strategies:
//   - 'single' : one request returns the whole dataset (one segment).
//   - 'cursor' : follow a next-link found in each payload until exhausted.
//
// Authority: SRA Snapshot Collector design §"New SRA-specific modules: snapshot-source".

const SOURCE_AUTHORITY = 'Solicitors Regulation Authority';

// PLACEHOLDER locators/paths — every value below marked TBD must be CONFIRMED
// against the SRA Technical Document (registration-gated). The shape (declarative
// locators) is final; only the concrete values change.
const SRA_SNAPSHOT_SOURCE = Object.freeze({
  sourceId: 'sra',
  sourceAuthority: SOURCE_AUTHORITY,

  // Acquisition entry path (relative to config.baseUrl). CONFIRMED live 2026-06-29:
  // GET https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll
  datasetPath: '/datashare/api/V1/organisation/GetAll',

  // Segmentation. CONFIRMED 'single': GetAll returns the whole dataset
  // ({ Count, Organisations: [...] }) in one ~24 MB JSON document — no pagination.
  segmentation: Object.freeze({
    mode: 'single',                       // 'single' | 'cursor'
    singleSegmentName: 'snapshot.json',
    // cursor-mode settings (unused while mode === 'single'):
    nextPath: ['links', 'next'],
    segmentPrefix: 'segment-',            // segment-0001.json, segment-0002.json, …
    maxSegments: 10000,                   // safety bound; honestly flagged if hit
  }),

  // Records container. CONFIRMED: payload is { Count, Organisations: [ … ] }.
  recordsPath: ['Organisations'],

  // Dataset production timestamp. NOTE: the live GetAll payload exposes NO dataset
  // production timestamp (verified 2026-06-29 — top-level keys are only Count +
  // Organisations; no Last-Modified header). This locator resolves to null until a
  // metadata source is identified. See validation findings (worker-dedup impact).
  productionTimestampPath: ['ProductionDate'],

  // ── Extract-layer locators (relative to a single firm/organisation record) ──
  // Offices array within an organisation. CONFIRMED key: "Offices".
  officesPath: ['Offices'],
  // Stable organisational anchor (SRA number). CONFIRMED key: "SraNumber" (numeric).
  // Read verbatim — never inferred.
  anchorPath: ['SraNumber'],
});

/**
 * Build a source definition by overriding the defaults (used once the Technical
 * Document is known, or in tests). Shallow-merges top level; pass a full
 * `segmentation` object to override segmentation. Pure.
 */
function defineSource(overrides = {}) {
  const seg = overrides.segmentation
    ? { ...SRA_SNAPSHOT_SOURCE.segmentation, ...overrides.segmentation }
    : SRA_SNAPSHOT_SOURCE.segmentation;
  return Object.freeze({ ...SRA_SNAPSHOT_SOURCE, ...overrides, segmentation: Object.freeze(seg) });
}

/**
 * Pure locator: read a value from a parsed object by a path array. Returns
 * undefined if any segment is absent. Navigation only — assigns no meaning.
 */
function locate(obj, pathArray) {
  if (!Array.isArray(pathArray)) return undefined;
  let cur = obj;
  for (const seg of pathArray) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

module.exports = { SRA_SNAPSHOT_SOURCE, defineSource, locate, SOURCE_AUTHORITY };
