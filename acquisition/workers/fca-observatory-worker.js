'use strict';

// fca-observatory-worker.js — FCA Observatory Worker (orchestration only).
//
// Executes exactly ONE complete FCA Observatory collection cycle and then stops.
// It contains NO collection, preservation, extraction, provenance, integrity, commit,
// or reporting LOGIC — it only composes the already-implemented modules:
//
//   firm-commit.collectAndCommitFirm   collect + exactly-once commit per firm
//   firm-commit.loadCommitted          checkpoint/resume state (the commit ledger)
//   provenance.verifyRun               per-firm integrity (aggregated → package level)
//   report.* / coverage / health       run-level reports over a merged run model
//
// One cycle (this module's whole responsibility):
//   1. create (or resume) a run-level Collection Package
//   2. load the FCA cohort
//   3. iterate firms
//   4. skip firms already committed in the package (ledger-driven)
//   5. collect + commit each remaining firm (exactly once)
//   6. survive interruption and resume from the first uncommitted firm
//   7. once every firm is committed: package-level integrity verification + run-level reports
//   8. stop
//
// NOT in scope (later commissioning steps): package SEALING, Railway deployment,
// scheduling, continuous polling. A finished cycle leaves the package in status
// 'collected' (collection + integrity + reports done) — authoritative only once a
// later step SEALS it.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  collectAndCommitFirm, loadCommitted, committedFirmDir, firmsDir, CORE_SCOPE,
} = require('../../collection/sources/fca/firm-commit');
const { verifyRun } = require('../../collection/sources/fca/provenance');
const { loadRunModel, buildCollectionReport, scanDiscoveries } = require('../../collection/sources/fca/report');
const { buildCoverage } = require('../../collection/sources/fca/coverage');
const { buildHealth } = require('../../collection/sources/fca/health');
const { FCA_PROFILE } = require('../../collection/sources/fca/fca-report-profile');
const { COLLECTOR_VERSION } = require('../../collection/sources/fca/collection-run');
const { sealPackage, isSealed } = require('../../collection/sources/fca/package-seal');
const { endpointsFor } = require('../../collection/sources/fca/collection-profiles');

// ── package descriptor (orchestration metadata; NOT evidence, NOT a seal) ────────
function packageJsonPath(pkgDir) { return path.join(pkgDir, 'package.json'); }
function manifestPath(pkgDir) { return path.join(pkgDir, 'manifest.json'); }
function reportsDir(pkgDir) { return path.join(pkgDir, 'reports'); }
function readPackage(pkgDir) { return JSON.parse(fs.readFileSync(packageJsonPath(pkgDir), 'utf8')); }

function createPackage(runRoot, packageId, meta = {}) {
  const dir = path.join(runRoot, packageId);
  fs.mkdirSync(firmsDir(dir), { recursive: true });
  const now = (meta.now ? meta.now() : new Date()).toISOString();
  const profile = meta.profile || 'core';
  fs.writeFileSync(packageJsonPath(dir), JSON.stringify({
    packageId,
    observatory: 'fca',
    source: 'FCA Financial Services Register',
    profile,
    collectorVersion: COLLECTOR_VERSION,
    scope: endpointsFor(profile),
    status: 'collecting',                 // → 'collected' at cycle end; SEALING is a later step
    openedAt: now,
    cohortSize: meta.cohortSize ?? null,
  }, null, 2));
  return dir;
}

/** The most recently opened in-progress package (status 'collecting'), or null. */
function findOpenPackage(runRoot) {
  if (!fs.existsSync(runRoot)) return null;
  let latest = null;
  for (const e of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = packageJsonPath(path.join(runRoot, e.name));
    if (!fs.existsSync(pj)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (j.status === 'collecting' && (!latest || j.openedAt > latest.openedAt)) latest = { dir: path.join(runRoot, e.name), openedAt: j.openedAt };
    } catch { /* ignore unreadable descriptor */ }
  }
  return latest ? latest.dir : null;
}

/** Resolve the package to work on: explicit id → create/resume; else resume an open one, else create new. */
function resolvePackage(runRoot, packageId, meta) {
  fs.mkdirSync(runRoot, { recursive: true });
  if (packageId) {
    const dir = path.join(runRoot, packageId);
    return fs.existsSync(packageJsonPath(dir)) ? dir : createPackage(runRoot, packageId, meta);
  }
  return findOpenPackage(runRoot) || createPackage(runRoot, `fca-core-${randomUUID()}`, meta);
}

// ── package-level integrity (aggregate the existing per-firm verifier) ──────────
function verifyPackage(pkgDir) {
  const frns = [...loadCommitted(pkgDir)];
  let total = 0; let verified = 0; let firmsOk = 0; const failures = [];
  for (const frn of frns) {
    const v = verifyRun(committedFirmDir(pkgDir, frn));
    total += v.total; verified += v.verified;
    if (v.total > 0 && v.verified === v.total) firmsOk++; else failures.push({ frn, failures: v.failures });
  }
  return { firms: frns.length, firmsOk, verified, total, ok: verified === total && firmsOk === frns.length, failures };
}

// ── run-level reports (merge per-firm run models; reuse the existing builders) ──
function buildMergedModel(pkgDir, packageId, frns, scope) {
  const merged = { manifest: null, rawByEndpoint: {}, structuredByEndpoint: {}, structuredCount: 0, structuredUnrecognised: [], provenanceCount: 0 };
  let start = null; let end = null;
  for (const frn of frns) {
    const m = loadRunModel(committedFirmDir(pkgDir, frn));
    for (const id of Object.keys(m.rawByEndpoint)) (merged.rawByEndpoint[id] = merged.rawByEndpoint[id] || []).push(...m.rawByEndpoint[id]);
    for (const id of Object.keys(m.structuredByEndpoint)) merged.structuredByEndpoint[id] = (merged.structuredByEndpoint[id] || 0) + m.structuredByEndpoint[id];
    merged.structuredCount += m.structuredCount;
    merged.structuredUnrecognised.push(...m.structuredUnrecognised);
    merged.provenanceCount += m.provenanceCount;
    if (m.manifest) {
      if (m.manifest.executionStart && (!start || m.manifest.executionStart < start)) start = m.manifest.executionStart;
      if (m.manifest.executionEnd && (!end || m.manifest.executionEnd > end)) end = m.manifest.executionEnd;
    }
  }
  const pages = Object.values(merged.rawByEndpoint).reduce((n, a) => n + a.length, 0);
  merged.manifest = {
    runId: packageId, collectorVersion: COLLECTOR_VERSION, apiVersion: 'V0.1',
    family: 'firm', anchor: null, scope,
    executionStart: start, executionEnd: end, pagesPreserved: pages, firmsCollected: frns.length,
  };
  return merged;
}

function writeRunReports(pkgDir, packageId, integrity, scope) {
  const frns = [...loadCommitted(pkgDir)];
  const model = buildMergedModel(pkgDir, packageId, frns, scope);

  const collection = buildCollectionReport(model, FCA_PROFILE);
  const coverage = buildCoverage(model, FCA_PROFILE, { family: 'firm', scope, notApplicable: [] });
  const discoveries = scanDiscoveries(model, FCA_PROFILE);
  const health = buildHealth(model, FCA_PROFILE, { integrity, discoveries });

  fs.mkdirSync(reportsDir(pkgDir), { recursive: true });
  fs.writeFileSync(path.join(reportsDir(pkgDir), 'collection-report.json'), JSON.stringify(collection, null, 2));
  fs.writeFileSync(path.join(reportsDir(pkgDir), 'coverage-report.json'), JSON.stringify(coverage, null, 2));
  fs.writeFileSync(path.join(reportsDir(pkgDir), 'health-report.json'), JSON.stringify(health, null, 2));
  if (discoveries.length) fs.writeFileSync(path.join(reportsDir(pkgDir), 'discoveries.json'), JSON.stringify(discoveries, null, 2));
  return { collection, coverage, health, discoveries };
}

// ── the cycle ────────────────────────────────────────────────────────────────────
/**
 * Run exactly one complete FCA Observatory collection cycle and stop.
 *
 * @param {Object} opts
 * @param {Object}   opts.config          fca-client.loadConfig() shape
 * @param {string}   opts.runRoot         directory holding Collection Packages (the future volume)
 * @param {Array<{frn:string,name?:string}>} opts.cohort   the FCA cohort to collect
 * @param {string}   [opts.packageId]     target a specific package (create/resume); else resume-open-or-create
 * @param {function} [opts._fetch]        injectable transport (tests)
 * @param {function} [opts.now]           injectable clock (tests)
 * @param {function} [opts.onProgress]    optional per-firm progress/health hook (operational observability)
 * @returns {Promise<Object>} cycle summary
 */
async function runCollectionCycle(opts) {
  const { config, runRoot, cohort, packageId, _fetch, now, onProgress } = opts;
  if (!config) throw new Error('runCollectionCycle requires a config');
  if (!runRoot) throw new Error('runCollectionCycle requires a runRoot');
  if (!Array.isArray(cohort)) throw new Error('runCollectionCycle requires a cohort array');

  // 1. create or resume the Collection Package
  const requestedProfile = opts.profile || 'core';
  const pkgDir = resolvePackage(runRoot, packageId, { cohortSize: cohort.length, now, profile: requestedProfile });

  // An already-SEALED package is authoritative and immutable: never reprocess, never
  // regenerate reports, never reseal. The cycle is already complete.
  if (isSealed(pkgDir)) {
    const sealedPkg = readPackage(pkgDir);
    return { packageId: sealedPkg.packageId, packageDir: pkgDir, status: 'sealed', sealed: true, alreadySealed: true, cohort: cohort.length, committed: 0, skipped: 0, failed: 0 };
  }

  const pkg = readPackage(pkgDir);
  // The package's own profile is authoritative (a resumed package keeps its profile);
  // the scope is derived from it and used for collection, reports, and the manifest.
  const profile = pkg.profile || requestedProfile;
  const scope = endpointsFor(profile);

  // 2–6. iterate the cohort; each firm is collected + committed exactly once. Firms
  // already in the ledger are skipped (resume). A per-firm failure is recorded and the
  // cycle continues (one firm never aborts the run); an onProgress hook that throws
  // models an external interruption (the partial package + ledger persist for resume).
  const summary = { packageId: pkg.packageId, packageDir: pkgDir, cohort: cohort.length, committed: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < cohort.length; i++) {
    const c = cohort[i];
    let res;
    try { res = await collectAndCommitFirm(config, pkgDir, c.frn, { _fetch, scope }); }
    catch (e) { res = { frn: String(c.frn), status: 'error', error: e.message }; }

    if (res.status === 'committed') summary.committed++;
    else if (res.status === 'skipped') summary.skipped++;
    else summary.failed++;

    if (onProgress) onProgress({ index: i, total: cohort.length, ...res });
  }

  // 7a. finalize — verify: package-level integrity verification (read-only).
  const integrity = verifyPackage(pkgDir);

  // 7b. finalize — reports: run-level reports. A failure here MUST prevent sealing,
  // so it is captured (not thrown) and the package is left unsealed = 'collected'.
  let reports = null; let reportsError = null;
  try { reports = writeRunReports(pkgDir, pkg.packageId, integrity, scope); }
  catch (e) { reportsError = e; }

  // Run-level manifest: completes the package to the platform shape and is the
  // completeness artefact the platform seal primitive requires.
  writeRunManifest(pkgDir, pkg, integrity, summary, now, scope);

  // Mark 'collected' (collection + integrity + reports done) — the pre-seal state.
  const collectedAt = (now ? now() : new Date()).toISOString();
  const collectedDescriptor = {
    ...pkg, status: 'collected', collectedAt,
    integrity: { firms: integrity.firms, firmsOk: integrity.firmsOk, verified: integrity.verified, total: integrity.total, ok: integrity.ok },
    summary,
  };
  fs.writeFileSync(packageJsonPath(pkgDir), JSON.stringify(collectedDescriptor, null, 2));

  // 7c. finalize — SEAL: only when every firm processed, integrity ok, reports done.
  const allFirmsProcessed = (summary.committed + summary.skipped) === cohort.length && summary.failed === 0;
  let sealResult = { sealed: false, reasons: [] };
  if (!reportsError) {
    sealResult = sealPackage(pkgDir, {
      packageId: pkg.packageId, collectorVersion: COLLECTOR_VERSION, now,
      allFirmsProcessed, integrity,
      payload: { firms: integrity.firms, firmsOk: integrity.firmsOk, structuredRecords: integrity.total, profile },
    });
  } else {
    sealResult.reasons = ['run-level report generation failed: ' + reportsError.message];
  }

  // On a successful seal, advance status → 'sealed' (authoritative). Otherwise the
  // package remains 'collected' and never becomes authoritative.
  if (sealResult.sealed) {
    fs.writeFileSync(packageJsonPath(pkgDir), JSON.stringify({ ...collectedDescriptor, status: 'sealed', sealedAt: sealResult.record ? sealResult.record.sealedAt : null }, null, 2));
  }

  // 8. stop.
  return {
    ...summary,
    status: sealResult.sealed ? 'sealed' : 'collected',
    sealed: !!sealResult.sealed,
    ...(sealResult.sealed ? {} : { sealReasons: sealResult.reasons }),
    integrity,
    reports: reports ? { collectionRecords: reports.collection.structuredRecords, coverageComplete: reports.coverage.coverageComplete, discoveries: reports.discoveries.length } : null,
  };
}

// Run-level manifest — describes the run/package (collection metadata only). Also the
// completeness artefact the platform seal primitive requires at the package root.
function writeRunManifest(pkgDir, pkg, integrity, summary, now, scope) {
  const frns = [...loadCommitted(pkgDir)];
  fs.writeFileSync(manifestPath(pkgDir), JSON.stringify({
    artefactType: 'fca-run-manifest',
    note: 'Describes the FCA Observatory collection run. Does NOT summarise or interpret evidence.',
    packageId: pkg.packageId,
    observatory: 'fca',
    source: pkg.source,
    profile: pkg.profile,
    collectorVersion: COLLECTOR_VERSION,
    scope: scope || endpointsFor(pkg.profile || 'core'),
    family: 'firm',
    builtAt: (now ? now() : new Date()).toISOString(),
    cohortSize: pkg.cohortSize ?? null,
    firmsCommitted: frns.length,
    firms: frns,
    summary,
    integrity: { firms: integrity.firms, firmsOk: integrity.firmsOk, verified: integrity.verified, total: integrity.total, ok: integrity.ok },
  }, null, 2));
}

module.exports = {
  runCollectionCycle, resolvePackage, createPackage, findOpenPackage,
  verifyPackage, writeRunReports, buildMergedModel, readPackage,
  packageJsonPath, reportsDir,
};

// ── single-cycle CLI entry (one cycle then exit; NO scheduling / NO polling) ──────
// Production startup is FAIL-FAST: RUN_ROOT must be set to the mounted Railway volume
// (the Collection Package + commit ledger live there and MUST survive restarts for
// resume/exactly-once to hold). On any startup precondition failure the worker exits 2
// BEFORE contacting the source.
if (require.main === module) {
  (async () => {
    try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch { /* optional */ }

    const runRoot = process.env.RUN_ROOT;
    if (!runRoot) { console.error('RUN_ROOT is not set — point it at the mounted Railway volume (e.g. /data/fca-runs)'); process.exit(2); }
    fs.mkdirSync(runRoot, { recursive: true });

    const { loadConfig, validateConfig } = require('../../collection/sources/fca/fca-client');
    const { readCohort } = require('../../collection/sources/fca/run-core');
    const config = loadConfig();
    const v = validateConfig(config);
    if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }

    const cohort = readCohort();
    if (!cohort.length) { console.error('cohort is empty — confirm the cohort source of record'); process.exit(2); }

    const profile = process.env.FCA_PROFILE || 'core';   // 'registry' for the Organisation Registry run
    process.stdout.write(`FCA Observatory worker starting: RUN_ROOT=${runRoot} | cohort ${cohort.length} firms | profile ${profile}\n`);
    const summary = await runCollectionCycle({ config, runRoot, cohort, profile, onProgress: (p) => { if (p.status !== 'skipped') process.stdout.write(`[${p.index + 1}/${p.total}] ${p.frn} ${p.status}\n`); } });
    process.stdout.write(`\nFCA Observatory cycle complete: package ${summary.packageId} | status ${summary.status} | committed ${summary.committed} skipped ${summary.skipped} failed ${summary.failed} | integrity ${summary.integrity.verified}/${summary.integrity.total} ok=${summary.integrity.ok}\n`);
    process.exit(0);
  })().catch((e) => { console.error('observatory cycle failed:', e.message); process.exit(1); });
}
