'use strict';

// package-seal.js — Collection Package sealing for the FCA Observatory.
//
// Reuses the EXISTING Collection Platform sealing mechanism (the SRA reference
// implementation, ../sra/collection-package.js) unchanged: the write-once SEALED
// marker, the immutability guarantee, and the isSealed/readSeal predicates. This
// module adds only the FCA Observatory's seal PRECONDITIONS and delegates the actual
// seal to the platform primitive — it does not reimplement sealing.
//
// A run-level Collection Package may be sealed only when ALL of:
//   1. every firm in the cohort has been processed (committed; no failures left);
//   2. package-level integrity verification succeeded;
//   3. all run-level reports have been generated.
// If any precondition fails, the package is left UNSEALED and therefore never becomes
// authoritative. The SEALED marker is write-once and immutable (enforced by the
// platform primitive: a sealed package cannot be resealed or modified).
//
// The platform primitive additionally requires a manifest.json at the package root
// (its own completeness check); the worker writes the run-level manifest before
// sealing, so a sealed FCA package is structurally identical to a sealed SRA package
// (manifest.json + reports/ + SEALED).

const fs = require('node:fs');
const path = require('node:path');

// The existing platform sealing mechanism (frozen SRA reference). Reused verbatim.
const platformPackage = require('../sra/collection-package');

const REQUIRED_REPORTS = Object.freeze(['collection-report.json', 'coverage-report.json', 'health-report.json']);

/** True iff every required run-level report is present in the package. */
function reportsPresent(pkgDir) {
  return REQUIRED_REPORTS.every((r) => fs.existsSync(path.join(pkgDir, 'reports', r)));
}

/**
 * Evaluate the FCA seal preconditions. Pure (reads only); never throws.
 * @param {string} pkgDir
 * @param {Object} state - { allFirmsProcessed: boolean, integrity: { ok: boolean, ... } }
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function evaluateSealable(pkgDir, state = {}) {
  const reasons = [];
  if (!state.allFirmsProcessed) reasons.push('not every firm has been processed');
  if (!(state.integrity && state.integrity.ok)) reasons.push('package-level integrity verification did not succeed');
  if (!reportsPresent(pkgDir)) reasons.push('run-level reports are not all present');
  return { ok: reasons.length === 0, reasons };
}

/** Reused platform predicates. */
function isSealed(pkgDir) { return platformPackage.isSealed(pkgDir); }
function readSeal(pkgDir) { return platformPackage.readSeal(pkgDir); }

/**
 * Seal a Collection Package iff its FCA preconditions hold. Idempotent: an
 * already-sealed package is never resealed (the existing seal is returned). On a
 * failed precondition the package is left unsealed.
 *
 * @param {string} pkgDir
 * @param {Object} opts - { packageId, collectorVersion, allFirmsProcessed, integrity, payload, now }
 * @returns {{ sealed: boolean, alreadySealed?: boolean, record?: Object, reasons?: string[] }}
 */
function sealPackage(pkgDir, opts = {}) {
  // Write-once: an already-sealed package is immutable — do NOT reseal.
  if (platformPackage.isSealed(pkgDir)) {
    return { sealed: true, alreadySealed: true, record: platformPackage.readSeal(pkgDir) };
  }

  const evalResult = evaluateSealable(pkgDir, opts);
  if (!evalResult.ok) return { sealed: false, reasons: evalResult.reasons };

  // Delegate the actual write-once SEAL to the platform primitive (frozen SRA impl).
  const record = platformPackage.seal(pkgDir, {
    runId: opts.packageId ?? null,
    collectorVersion: opts.collectorVersion ?? null,
    payload: opts.payload,
    now: opts.now,
  });
  return { sealed: true, record };
}

module.exports = { sealPackage, evaluateSealable, isSealed, readSeal, reportsPresent, REQUIRED_REPORTS };
