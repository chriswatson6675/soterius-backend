'use strict';

// sra-extract-map.js — structural enumerators for SRA snapshot extraction (pure).
//
// SRA Snapshot Collector v0.1 — Extract layer.
//
// Given a parsed raw snapshot body and the source's declared locators
// (snapshot-source.js), `enumerate` yields the discrete organisational evidence
// items within the body, each with a precise location (`path` segments + human
// `jsonPath`) and the value VERBATIM. It reads only structural positions and
// dynamic KEYS (Object.keys) — it assigns NO meaning, renames nothing, merges
// nothing, infers nothing, derives nothing, scores nothing.
//
// Granularity (deterministic, multi-view, lossless):
//   - sra.firm               one per firm; value = the firm object verbatim (canonical record)
//   - sra.firm.field         one per firm-level field (key + verbatim value); offices container excluded
//   - sra.firm.office        one per office; value = the office object verbatim
//   - sra.firm.office.field  one per office-level field (key + verbatim value)
// The firm's organisational anchor (SRA number) is read verbatim and attached to
// every item derived from that firm (null if absent — never inferred).
//
// Unknown / malformed structures are preserved using a lossless FALLBACK item
// (objectType `*.raw`, `unrecognised: true`, value kept verbatim) and recorded as a
// discovery candidate; enumeration continues without code changes and without loss.
//
// Determinism: firms are enumerated in array order; fields in Object.keys order
// (V8 preserves insertion order for the string keys SRA uses). Same input → same
// output, every time.

const { locate } = require('./snapshot-source');

// ── path helpers (mirrors the FCA extract-map convention) ──────────────────────────

/** Human-readable JSON path from segments: ['firms',0,'SRA number'] → firms[0]["SRA number"]. */
function pathToString(segs) {
  let s = '';
  segs.forEach((seg, i) => {
    if (i === 0) s = String(seg);
    else if (typeof seg === 'number') s += `[${seg}]`;
    else s += `[${JSON.stringify(seg)}]`;
  });
  return s;
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function item(objectType, path, value, key, anchor) {
  return { objectType, path, jsonPath: pathToString(path), value, key: key ?? null, anchor: anchor ?? null };
}

function fallback(objectType, path, value, reason, anchor) {
  return { objectType, path, jsonPath: pathToString(path), value, key: null, anchor: anchor ?? null, unrecognised: true, reason };
}

/** Read the organisational anchor (SRA number) from a firm object, verbatim. */
function readAnchor(firm, source) {
  const v = locate(firm, source.anchorPath);
  return (typeof v === 'string' || typeof v === 'number') ? v : null;
}

// ── enumeration ────────────────────────────────────────────────────────────────────

/**
 * Enumerate the organisational evidence items within a parsed snapshot body.
 *
 * @param {Object} body - the parsed raw snapshot segment
 * @param {Object} source - snapshot-source definition (recordsPath, officesPath, anchorPath)
 * @returns {{ items: Object[], discoveries: Object[] }}
 */
function enumerate(body, source) {
  const items = [];
  const discoveries = [];
  const recordsPath = source.recordsPath || [];
  const records = locate(body, recordsPath);

  // Observed absence: no records container, or it is null → nothing to enumerate.
  if (records === undefined || records === null) return { items, discoveries };

  // Unknown shape: the records container is not an array → lossless fallback.
  if (!Array.isArray(records)) {
    items.push(fallback('sra.snapshot.raw', recordsPath, records, 'records container is not an array'));
    discoveries.push({ type: 'unrecognised-records-container', jsonPath: pathToString(recordsPath) });
    return { items, discoveries };
  }

  const officesPath = Array.isArray(source.officesPath) && source.officesPath.length ? source.officesPath : null;
  const officesContainerKey = officesPath && officesPath.length === 1 ? officesPath[0] : null;

  records.forEach((firm, i) => {
    const firmPath = [...recordsPath, i];

    if (!isObject(firm)) {
      items.push(fallback('sra.firm.raw', firmPath, firm, 'firm record is not an object'));
      discoveries.push({ type: 'malformed-firm', jsonPath: pathToString(firmPath) });
      return;
    }

    const anchor = readAnchor(firm, source);

    // Canonical organisation record (whole firm object, verbatim).
    items.push(item('sra.firm', firmPath, firm, null, anchor));

    // Firm-level fields (verbatim), excluding the offices container (enumerated below).
    for (const key of Object.keys(firm)) {
      if (officesContainerKey && key === officesContainerKey) continue;
      items.push(item('sra.firm.field', [...firmPath, key], firm[key], key, anchor));
    }

    // Offices.
    if (officesPath) {
      const offices = locate(firm, officesPath);
      if (offices === undefined || offices === null) return; // no offices observed → nothing to add
      if (!Array.isArray(offices)) {
        const op = [...firmPath, ...officesPath];
        items.push(fallback('sra.firm.office.raw', op, offices, 'offices container is not an array', anchor));
        discoveries.push({ type: 'unrecognised-offices-container', jsonPath: pathToString(op) });
        return;
      }
      offices.forEach((office, j) => {
        const op = [...firmPath, ...officesPath, j];
        if (!isObject(office)) {
          items.push(fallback('sra.firm.office.raw', op, office, 'office record is not an object', anchor));
          discoveries.push({ type: 'malformed-office', jsonPath: pathToString(op) });
          return;
        }
        items.push(item('sra.firm.office', op, office, null, anchor));
        for (const k of Object.keys(office)) {
          items.push(item('sra.firm.office.field', [...op, k], office[k], k, anchor));
        }
      });
    }
  });

  return { items, discoveries };
}

module.exports = { enumerate, pathToString, readAnchor };
