'use strict';

// collection-package.js — lifecycle of an SRA collection package on disk.
//
// SRA Snapshot Collector v0.1 — Collection Package foundation.
//
// A collection package is the unit a SUCCESSFUL snapshot collection produces. It
// becomes AUTHORITATIVE only when SEALED is written:
//
//   - A package "exists" (is consumable) ONLY if it is SEALED.
//   - A FAILED or INTERRUPTED collection leaves an UNSEALED package, which must be
//     treated as partial / non-existent and is safe to discard and re-acquire.
//   - Sealing is WRITE-ONCE: a sealed package is immutable; sealing requires a
//     complete package (manifest present), so a half-built package cannot be sealed.
//
// This module owns: package creation (the directory tree), sealing, the existence
// predicate, and recovery listing (sealed vs unsealed). It writes NO evidence and
// NO manifest — those belong to preserve-snapshot.js and manifest.js.
//
// Authority: SRA Snapshot Collector design §"Atomic, immutable, byte-faithful
//   snapshots" and §"Collection sealing".

const fs = require('node:fs');
const {
  runDir, rawDir, structuredDir, provenanceDir, reportsDir, sealPath, manifestPath, PACKAGE_DIRS,
} = require('./evidence-path');

/**
 * Create (or open) the package directory tree under `root` for `runId`. Idempotent.
 * Does NOT write manifest.json or SEALED. Returns the package directory.
 */
function createPackage(root, runId) {
  if (runId === undefined || runId === null || String(runId) === '') {
    throw new Error('createPackage requires a runId');
  }
  const dir = runDir(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of [rawDir(dir), structuredDir(dir), provenanceDir(dir), reportsDir(dir)]) {
    fs.mkdirSync(sub, { recursive: true });
  }
  return dir;
}

/** True iff the package has been sealed (and therefore "exists"). */
function isSealed(dir) { return fs.existsSync(sealPath(dir)); }

/** A package exists / is consumable ONLY when sealed. */
function packageExists(dir) { return isSealed(dir); }

/**
 * Seal a package: write the SEALED marker. WRITE-ONCE, and only over a COMPLETE
 * package (manifest.json must be present). Throws if the directory is missing, the
 * manifest is absent, or the package is already sealed.
 *
 * @param {string} dir
 * @param {Object} [opts] - { runId, collectorVersion, payload, now }
 * @returns {Object} the seal record written
 */
function seal(dir, opts = {}) {
  if (!fs.existsSync(dir)) throw new Error(`cannot seal: package directory does not exist: ${dir}`);
  if (!fs.existsSync(manifestPath(dir))) throw new Error('cannot seal: manifest.json is missing (package incomplete)');
  if (isSealed(dir)) throw new Error('cannot seal: package is already sealed (immutable)');

  const now = opts.now ?? (() => new Date().toISOString());
  const record = {
    runId: opts.runId ?? null,
    collectorVersion: opts.collectorVersion ?? null,
    sealedAt: now(),
    ...(opts.payload !== undefined ? { details: opts.payload } : {}),
  };
  fs.writeFileSync(sealPath(dir), JSON.stringify(record, null, 2));
  return record;
}

/** Read the seal record, or null if the package is unsealed. */
function readSeal(dir) {
  if (!isSealed(dir)) return null;
  try { return JSON.parse(fs.readFileSync(sealPath(dir), 'utf8')); } catch { return {}; }
}

/**
 * List packages under `root` with their seal state (recovery aid).
 * @returns {Array<{ runId: string, dir: string, sealed: boolean }>}
 */
function listPackages(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = runDir(root, e.name);
      return { runId: e.name, dir, sealed: isSealed(dir) };
    });
}

/** Unsealed (partial / interrupted) packages — recovery candidates to discard or re-run. */
function listUnsealed(root) { return listPackages(root).filter((p) => !p.sealed); }

/** Sealed (authoritative) packages. */
function listSealed(root) { return listPackages(root).filter((p) => p.sealed); }

module.exports = {
  createPackage, isSealed, packageExists, seal, readSeal,
  listPackages, listUnsealed, listSealed, PACKAGE_DIRS,
};
