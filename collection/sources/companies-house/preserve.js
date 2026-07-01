'use strict';

// preserve.js — the Preserve sink for Companies House observed evidence.
//
// The collector stops at the Preserve boundary (CCS §0.2): observe() EMITS
// evidence objects; it does not store them. This module performs Preserve
// (ARCHITECTURE.md §2 "Preserve", §4): it writes emitted observations to a
// permanent, append-only, provenanced store, unchanged.
//
// Storage choice. The constitution mandates the PROPERTIES of preservation
// (immutable / provenanced / honest / re-derivable), not a particular technology
// (CCS §0.2: "defines what is emitted, not how it is stored"). The CH corpus is
// heterogeneous structured objects (EO-01…EO-10) plus binary documents — it does
// not fit the flat single-row Supabase signal tables used by signal-level
// collectors, and inventing a DB schema would be new architecture (out of scope).
// The minimal honest sink that satisfies every preservation property is an
// append-only, run-stamped directory on disk:
//
//   <runDir>/
//     manifest.json                 run identity, cohort, collector version, scope
//     resolution.ndjson             firm → anchor resolution ledger (anchor discovery, NOT evidence)
//     evidence/EO-01.ndjson … EO-10.ndjson   one JSON line per emitted object (append-only)
//     documents/<document_id>.<ext>          EO-06 binaries, byte-for-byte
//     documents/index.ndjson                 EO-06 document metadata + on-disk path + hash
//     coverage.ndjson               one coverage record per firm observed
//     observed-absences.ndjson      register-consulted-nothing-published records
//     non-observations.ndjson       could-not-consult records (Unknown ≠ Absent)
//
// Append-only is enforced by using append writes and never rewriting a line. Each
// line already carries the provenance envelope the collector built.

const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_TYPES = ['EO-01', 'EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-06', 'EO-07', 'EO-08', 'EO-09', 'EO-10'];

/**
 * Open a Preserve sink rooted at runDir. Creates the directory tree if absent.
 * Re-opening an existing runDir appends (resume-safe).
 *
 * @param {string} runDir
 * @param {Object} manifest - run identity written once if not already present
 * @returns {Preserver}
 */
function createPreserver(runDir, manifest) {
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'documents'), { recursive: true });

  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const counts = Object.fromEntries(EVIDENCE_TYPES.map((t) => [t, 0]));
  const tally = {
    emitted: 0,
    documentsBinary: 0,
    observedAbsences: 0,
    nonObservations: 0,
    resolutions: 0,
    byType: counts,
  };

  function appendLine(file, obj) {
    fs.appendFileSync(path.join(runDir, file), JSON.stringify(obj) + '\n');
  }

  return {
    runDir,

    /** Preserve the full output of one observe() call for one firm. */
    preserveObservation(firmRef, result) {
      // Emitted evidence objects → per-type append-only NDJSON.
      for (const e of result.emitted) {
        const type = e.objectType;
        if (type === 'EO-06') {
          this._preserveDocument(firmRef, e);
        } else {
          appendLine(`evidence/${type}.ndjson`, _withFirm(firmRef, e));
          tally.byType[type] = (tally.byType[type] ?? 0) + 1;
          tally.emitted++;
        }
      }
      // Observed absences, non-observations, coverage — each a first-class record.
      for (const a of result.observedAbsences) {
        appendLine('observed-absences.ndjson', _withFirm(firmRef, a));
        tally.observedAbsences++;
      }
      for (const no of result.nonObservations) {
        appendLine('non-observations.ndjson', _withFirm(firmRef, no));
        tally.nonObservations++;
      }
      appendLine('coverage.ndjson', _withFirm(firmRef, result.coverage));
    },

    /** EO-06 binary written byte-for-byte; metadata + path + hash indexed. */
    _preserveDocument(firmRef, e) {
      const rep = e.representation ?? {};
      const docId = e.objectIdentity?.document_id ?? 'unknown';
      const ext = _extFor(rep.contentType);
      const fileName = `${_safe(docId)}${ext}`;
      const diskPath = path.join('documents', fileName);
      if (rep.bytesBase64) {
        const bytes = Buffer.from(rep.bytesBase64, 'base64');
        const abs = path.join(runDir, diskPath);
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, bytes); // immutable: capture-once
        tally.documentsBinary++;
      }
      appendLine('documents/index.ndjson', _withFirm(firmRef, {
        document_id: docId,
        parent: e.relationships?.parent ?? null,
        contentType: rep.contentType ?? null,
        byteLength: rep.byteLength ?? null,
        contentHash: rep.contentHash ?? e.observationIdentity?.contentHash ?? null,
        metadata: rep.metadata ?? null,
        diskPath,
        provenance: e.provenance,
        observationIdentity: e.observationIdentity,
      }));
      tally.byType['EO-06'] = (tally.byType['EO-06'] ?? 0) + 1;
      tally.emitted++;
    },

    /** Preserve one firm → anchor resolution outcome (anchor-discovery ledger). */
    preserveResolution(record) {
      appendLine('resolution.ndjson', record);
      tally.resolutions++;
    },

    tally() { return JSON.parse(JSON.stringify(tally)); },
  };
}

function _withFirm(firmRef, obj) {
  return { firm: firmRef, ...obj };
}

function _safe(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

function _extFor(contentType) {
  if (!contentType) return '.bin';
  const ct = String(contentType).toLowerCase();
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('xhtml') || ct.includes('xml')) return '.xhtml';
  if (ct.includes('json')) return '.json';
  if (ct.includes('html')) return '.html';
  if (ct.includes('csv')) return '.csv';
  return '.bin';
}

module.exports = { createPreserver, EVIDENCE_TYPES };
