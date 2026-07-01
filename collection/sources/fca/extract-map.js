'use strict';

// extract-map.js — structural enumerators for FCA evidence extraction (pure).
//
// Reference Collector v0.1 — PHASE 5 (IMP-FCA-001 §5; CCS-FCA-001 §7).
//
// Given a parsed FCA response body and the endpoint's declared responseType
// (endpoint-map.js), an enumerator yields the discrete evidence items WITHIN the
// body, each with a precise location (`path` segments + human `jsonPath`) and the
// value VERBATIM. Enumerators read only structural positions and dynamic KEYS
// (Object.keys) — they assign NO meaning, rename nothing, merge nothing,
// canonicalise nothing [CR-FCA-04/15]. They never throw: an unexpected shape
// yields a single fallback item over the whole `Data` plus an `unrecognised` flag
// so nothing is lost and extraction continues [CCS-FCA-001 §13; IMP §5].
//
// Authority: CCS-FCA-001 §7; EOI-FCA-001 (object families & granularity);
//   CCD-FCA-001 CR-FCA-04/06/15.

// ── path helpers ─────────────────────────────────────────────────────────────────

/** Human-readable JSON path from segments: ['Data',0,'Current Names',2] → Data[0]["Current Names"][2]. */
function pathToString(segs) {
  let s = '';
  segs.forEach((seg, i) => {
    if (i === 0) s = String(seg);
    else if (typeof seg === 'number') s += `[${seg}]`;
    else s += `[${JSON.stringify(seg)}]`;
  });
  return s;
}

/** Navigate a parsed body by path segments. Returns undefined if absent. */
function getByPath(body, segs) {
  let cur = body;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function item(objectType, segs, value, key) {
  return { objectType, path: segs, jsonPath: pathToString(segs), value, key: key ?? null };
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ── enumerators (one per responseType) ───────────────────────────────────────────

// A single object carried in a 1-element Data array (firm, individual, cis).
function single(body, endpointId) {
  const data = body && body.Data;
  if (!Array.isArray(data)) return fallback(body, endpointId, 'expected Data array (single)');
  return { items: data.map((v, i) => item(endpointId, ['Data', i], v)) };
}

// A flat list: Data is an array, one item per element (address, regulators,
// requirements, disciplinary, waivers, exclusions, individuals, cis.names,
// cis.subfund, requirements.investmentTypes).
function list(body, endpointId) {
  const data = body && body.Data;
  if (data === null || data === undefined) return { items: [] }; // observed absence → no items
  if (!Array.isArray(data)) return fallback(body, endpointId, 'expected Data array (list)');
  return { items: data.map((v, i) => item(`${endpointId}.item`, ['Data', i], v)) };
}

// Names: Data is [{Current Names:[…]}, {Previous Names:[…]}] (container keys dynamic-ish).
function names(body, endpointId) {
  const data = body && body.Data;
  if (!Array.isArray(data)) return fallback(body, endpointId, 'expected Data array (names)');
  const items = [];
  data.forEach((container, i) => {
    if (!isObject(container)) return;
    for (const key of Object.keys(container)) {
      const arr = container[key];
      if (Array.isArray(arr)) arr.forEach((nm, j) => items.push(item(`${endpointId}.name`, ['Data', i, key, j], nm, key)));
    }
  });
  return { items };
}

// Permissions: Data is an object keyed by regulated-activity name (dynamic keys).
function dynamicMap(body, endpointId) {
  const data = body && body.Data;
  if (!isObject(data)) return fallback(body, endpointId, 'expected Data object (dynamic-map)');
  const items = Object.keys(data).map((key) => item(`${endpointId}.activity`, ['Data', key], data[key], key));
  return { items };
}

// Controlled functions: Data[0] holds Current / Previous maps keyed by (seq)role.
function dynamicMapCf(body, endpointId) {
  const data = body && body.Data;
  if (!Array.isArray(data) || !isObject(data[0])) return fallback(body, endpointId, 'expected Data[0] object (cf)');
  const items = [];
  for (const state of ['Current', 'Previous']) {
    const m = data[0][state];
    if (!isObject(m)) continue;
    for (const roleKey of Object.keys(m)) items.push(item(`${endpointId}.role`, ['Data', 0, state, roleKey], m[roleKey], roleKey));
  }
  return { items };
}

// Appointed representatives: Data is an object with Current/Previous AR arrays.
function ar(body, endpointId) {
  const data = body && body.Data;
  if (!isObject(data)) return fallback(body, endpointId, 'expected Data object (ar)');
  const items = [];
  for (const listKey of ['CurrentAppointedRepresentatives', 'PreviousAppointedRepresentatives']) {
    const arr = data[listKey];
    if (Array.isArray(arr)) arr.forEach((v, i) => items.push(item(`${endpointId}.appointedRepresentative`, ['Data', listKey, i], v, listKey)));
  }
  return { items };
}

// Passports: Data[0].Passports is an array of passport entries.
function passports(body, endpointId) {
  const data = body && body.Data;
  if (!Array.isArray(data) || !isObject(data[0]) || !Array.isArray(data[0].Passports)) {
    return fallback(body, endpointId, 'expected Data[0].Passports array');
  }
  return { items: data[0].Passports.map((v, i) => item(`${endpointId}.passport`, ['Data', 0, 'Passports', i], v)) };
}

// Fallback: preserve the whole Data verbatim and flag for discovery. Never loses data.
function fallback(body, endpointId, reason) {
  const data = body ? body.Data : undefined;
  return {
    items: [{ ...item(`${endpointId}.raw`, ['Data'], data), unrecognised: true }],
    unrecognised: true,
    reason,
  };
}

const ENUMERATORS = {
  'single': single,
  'list': list,
  'names': names,
  'dynamic-map': dynamicMap,
  'dynamic-map-cf': dynamicMapCf,
  'ar': ar,
  'passports': passports,
};

/** Enumerate the evidence items in a parsed body for a declared responseType. */
function enumerate(responseType, body, endpointId) {
  // A null/absent Data is an observed absence or an empty pagination-tail page
  // (e.g. a paginated list's final page returns FSR-API-…-22 with Data:null).
  // There is nothing to STRUCTURE — the raw page is already preserved (Phase 4),
  // and absence classification proper is Phase 7. Uniform across all responseTypes.
  const data = body ? body.Data : undefined;
  if (data === null || data === undefined) return { items: [] };

  const fn = ENUMERATORS[responseType];
  if (!fn) return fallback(body, endpointId, `unknown responseType '${responseType}'`);
  return fn(body, endpointId);
}

module.exports = { enumerate, ENUMERATORS, pathToString, getByPath };
