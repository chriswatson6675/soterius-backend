'use strict';

// firm-commit.js — exactly-once firm commit into a run-level FCA Collection Package.
//
// Resolves architectural risk R1. The processing unit is one firm; the authoritative
// unit is the run-level Collection Package. Firms are collected firm-by-firm and
// folded into the in-progress package EXACTLY ONCE: a firm becomes a permanent part
// of the package only after its evidence is staged in isolation, integrity-verified,
// and atomically committed.
//
// Firm lifecycle (per the engineering spec):
//   collect → preserve raw → extract → provenance → verify integrity → commit once
//
// Layout inside a run-package root (pkgRoot):
//   firms/<FRN>/        committed per-firm evidence (raw/ structured/ provenance/ manifest.json)
//   .staging/<FRN>/     in-progress per-firm collection (isolated; never authoritative)
//   commit-log.ndjson   append-only commit ledger — one line per committed firm
//
// Exactly-once is achieved by making the SINGLE append to commit-log.ndjson the
// commit (linearisation) point, and making evidence appear as a unit via an atomic
// directory rename:
//   - A firm is committed IFF its FRN appears in the ledger.
//   - Evidence is collected into an isolated .staging/<FRN> dir, then moved into the
//     package with one atomic fs.rename — so a partially-written firm is never visible
//     inside firms/.
//   - Any firms/<FRN> directory NOT backed by a ledger entry is an orphan (a crash in
//     the tiny window between the rename and the ledger append). The ledger — not the
//     directory — is truth: an orphan is discarded and the firm is recollected.
// Result: authoritative evidence stays append-only and duplicate-free, and resume is
// deterministic (skip ledgered firms; recollect everything else).
//
// Reuses the existing collector modules UNCHANGED (engine → preserve → manifest →
// extract → provenance → integrity). Does NOT seal the package, generate run-level
// reports, drive a worker, or deploy — those are later commissioning steps.

const fs = require('node:fs');
const path = require('node:path');

const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage, verifyRun } = require('./provenance');
const { COLLECTOR_VERSION } = require('./collection-run');
const { endpointsFor } = require('./collection-profiles');
const ep = require('./evidence-path');

const CORE_SCOPE = endpointsFor('core');                       // ['firm', 'firm.address']
const RETRY = { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };

// ── package paths ────────────────────────────────────────────────────────────────
function firmsDir(pkgRoot) { return path.join(pkgRoot, 'firms'); }
function stagingDir(pkgRoot) { return path.join(pkgRoot, '.staging'); }
function committedFirmDir(pkgRoot, frn) { return path.join(firmsDir(pkgRoot), ep.safeName(frn)); }
function stagedFirmDir(pkgRoot, frn) { return path.join(stagingDir(pkgRoot), ep.safeName(frn)); }
function ledgerPath(pkgRoot) { return path.join(pkgRoot, 'commit-log.ndjson'); }

// ── commit ledger (append-only; the single source of truth) ─────────────────────
/** The set of FRNs already committed to the package (read from the ledger). */
function loadCommitted(pkgRoot) {
  const set = new Set();
  const p = ledgerPath(pkgRoot);
  if (!fs.existsSync(p)) return set;
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); if (r && r.frn != null) set.add(String(r.frn)); } catch { /* ignore malformed line */ }
  }
  return set;
}

/** True iff the firm is already a committed part of the package. */
function isCommitted(pkgRoot, frn) { return loadCommitted(pkgRoot).has(String(frn)); }

// ── per-firm collection into ISOLATED staging (existing pipeline; no reports) ────
/**
 * Run the firm lifecycle up to integrity into a clean, isolated staging directory.
 * Writes NOTHING into the authoritative firms/ area. Idempotent: a leftover staging
 * dir from a pre-commit crash is discarded first, so collection always starts fresh.
 *
 * @returns {{ sDir: string, pages: number, integrity: { verified: number, total: number, failures: Array } }}
 */
async function collectFirmIntoStaging(config, pkgRoot, frn, opts = {}) {
  const scope = opts.scope || CORE_SCOPE;               // caller-supplied collection scope; defaults to Core
  const sDir = stagedFirmDir(pkgRoot, frn);
  fs.rmSync(sDir, { recursive: true, force: true });   // discard any pre-crash partial → deterministic fresh staging
  fs.mkdirSync(sDir, { recursive: true });

  const t0 = new Date();
  const exec = await executeAnchor({ family: 'firm', anchor: frn, config, endpoints: scope, retry: RETRY, _fetch: opts._fetch });
  const tally = createPreserver(sDir, { runId: frn }).preserveExecution(exec);
  writeManifest(sDir, buildManifest({ runId: frn, collectorVersion: COLLECTOR_VERSION, apiVersion: 'V0.1', family: 'firm', anchor: frn, scope, executionStart: t0.toISOString(), executionEnd: new Date().toISOString() }, tally));
  extractRun(sDir);
  writeLineage(sDir, JSON.parse(fs.readFileSync(ep.manifestPath(sDir), 'utf8')));
  const integrity = verifyRun(sDir);

  return { sDir, pages: tally.pagesPreserved, integrity };
}

// ── atomic commit: fold staged firm into the package + record in the ledger ──────
/**
 * Commit an already-staged, integrity-verified firm. Atomic: the firm appears in
 * firms/ as a unit (rename), then the ledger append makes the commit durable. Any
 * orphan firms/<FRN> not backed by the ledger is discarded first (the ledger is truth).
 *
 * @returns {Object} the ledger record written
 */
function commitStagedFirm(pkgRoot, frn, meta = {}) {
  const sDir = stagedFirmDir(pkgRoot, frn);
  if (!fs.existsSync(sDir)) throw new Error(`cannot commit ${frn}: no staged evidence at ${sDir}`);
  fs.mkdirSync(firmsDir(pkgRoot), { recursive: true });

  const dest = committedFirmDir(pkgRoot, frn);
  // Discard an orphan committed dir (crash between a prior rename and its ledger
  // append). rename also requires the destination not to exist (cross-platform).
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });

  fs.renameSync(sDir, dest);                                   // atomic move of the whole firm dir into the package
  const record = { frn: String(frn), committedAt: new Date().toISOString(), ...meta };
  fs.appendFileSync(ledgerPath(pkgRoot), JSON.stringify(record) + '\n');   // single atomic append = the commit point
  return record;
}

// ── exactly-once entry point ─────────────────────────────────────────────────────
/**
 * Collect and commit one firm with exactly-once semantics.
 *   - already committed (in ledger)  → skipped, no collection, no duplicate.
 *   - integrity fails                → NOT committed; recollected on a later run.
 *   - integrity passes               → atomically committed; permanent in the package.
 *
 * @returns {Promise<{ frn: string, status: 'skipped'|'integrity-failed'|'committed', ... }>}
 */
async function collectAndCommitFirm(config, pkgRoot, frn, opts = {}) {
  const key = String(frn);
  if (loadCommitted(pkgRoot).has(key)) {
    return { frn: key, status: 'skipped', reason: 'already-committed' };   // post-commit: never recollect/append
  }

  const staged = await collectFirmIntoStaging(config, pkgRoot, frn, opts);
  const ok = staged.integrity.total > 0 && staged.integrity.verified === staged.integrity.total;
  if (!ok) {
    // Pre-commit failure: nothing enters the package or the ledger. The firm will be
    // recollected when the run resumes (deterministic).
    return { frn: key, status: 'integrity-failed', integrity: staged.integrity };
  }

  const record = commitStagedFirm(pkgRoot, frn, {
    pages: staged.pages,
    structuredRecords: staged.integrity.total,
    integrity: { verified: staged.integrity.verified, total: staged.integrity.total },
  });
  return { frn: key, status: 'committed', record, integrity: staged.integrity };
}

module.exports = {
  collectAndCommitFirm, collectFirmIntoStaging, commitStagedFirm,
  loadCommitted, isCommitted,
  firmsDir, stagingDir, committedFirmDir, stagedFirmDir, ledgerPath,
  CORE_SCOPE,
};
