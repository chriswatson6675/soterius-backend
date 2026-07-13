'use strict';

// population-imports.js — the Population Onboarding upload surface, ENG-024
// WP-3 ("Vertical slice: HMRC AML → Repository Authority → Import Report").
//
// Route per ENG-016 §4.1's indicative path, admin-token-gated exactly like
// /api/prospects and /api/gate today (reused unchanged — same requireAdmin
// pattern, not a new auth mechanism). Scope, per ENG-024 WP-3 exactly:
//   1. Accept an HMRC AML register file.
//   2. Run it through the WP-2 HMRC AML Batch Adapter (parse/validate/
//      normalise/emit) — reused unchanged, no adapter logic lives here.
//   3. Merge into Repository Authority via the existing, unmodified
//      build.js/loaders.js substrate: the adapter's emitted canonical
//      records are written to a fixed ndjson snapshot
//      (authority/inputs/hmrc-aml-import.ndjson), which the new
//      loaders.js loadHmrcAmlImport() reads back synchronously — build.js
//      itself needed no structural change to accommodate a source whose own
//      parsing is unavoidably async (ODS/jszip): the async step happens once,
//      here, before build.js ever runs, exactly as loadObservedDomains()
//      already reads a pre-materialised snapshot rather than parsing live.
//   4. A minimal Population Import Report: rows parsed/rejected, which
//      organisations were newly created vs. merged into an existing
//      organisation (by matching this import's `hmrcAml` values against the
//      rebuilt dataset), and the run's audit fields (uploader, file,
//      timestamp). Deliberately NOT the full population_imports /
//      population_import_items ledger ENG-016 §5 designs — that is WP-4's
//      scope; "created vs. merged" is this slice's entire granularity, not a
//      full per-field diff of what changed on an already-existing
//      organisation (WP-4 extends this into the full report).
//
// Explicitly out of scope, per ENG-024 WP-3: Domain Discovery, candidate
// validation / VERIFIED promotion, Observatory scanning, Trust Profile
// generation. HMRC AML asserts no domain (ACQ-014 §8), so none of those
// stages has anything to act on from this source yet regardless.
//
// Synchronous by design at this stage (no job id / async ledger — that
// infrastructure is ENG-016 §5/§7.4's scope, built in WP-4): the vertical
// slice runs at a scale where a synchronous full Repository Authority
// rebuild per import is still tolerable, per ENG-024's own WP-6 framing.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const hmrcAmlAdapter = require('../../pae/adapters/hmrc-aml');
const { runBatchAdapter } = require('../../pae/batch-adapter-contract');
const logger = require('../../infra/utils/logger');

const AUTHORITY_DIR = path.join(__dirname, '..', '..', 'authority');
const IMPORT_NDJSON_PATH = path.join(AUTHORITY_DIR, 'inputs', 'hmrc-aml-import.ndjson');
const DATASET_PATH = path.join(AUTHORITY_DIR, 'dataset', 'organisations.ndjson');
const BUILD_SUMMARY_PATH = path.join(AUTHORITY_DIR, 'dataset', 'build-summary.json');
const BUILD_SCRIPT_PATH = path.join(AUTHORITY_DIR, 'build.js');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // real HMRC AML register is ~4.8MB

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

function readOrganisationIds(datasetPath) {
  if (!fs.existsSync(datasetPath)) return new Set();
  const lines = fs.readFileSync(datasetPath, 'utf8').trim().split('\n').filter(Boolean);
  return new Set(lines.map((l) => JSON.parse(l).organisationId));
}

function readOrganisationIdsByHmrcAml(datasetPath) {
  const map = new Map(); // hmrcAml -> organisationId
  if (!fs.existsSync(datasetPath)) return map;
  const lines = fs.readFileSync(datasetPath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const o = JSON.parse(line);
    const hmrcAml = o.identifiers && o.identifiers.hmrcAml;
    if (hmrcAml) map.set(hmrcAml, o.organisationId);
  }
  return map;
}

// Runs the real, unmodified build.js as a child process — exactly as an
// operator invokes it by hand (`node backend/authority/build.js`) — never
// re-implemented or required in-process, so this route depends on nothing
// about build.js's internals beyond "it rebuilds the dataset from disk".
function defaultRunBuild() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BUILD_SCRIPT_PATH], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`build.js failed: ${err.message}${stderr ? `\n${stderr}` : ''}`));
      resolve({ stdout, stderr });
    });
  });
}

function createUploadHandler(deps = {}) {
  const {
    runBuild = defaultRunBuild,
    adapter = hmrcAmlAdapter,
    importNdjsonPath = IMPORT_NDJSON_PATH,
    datasetPath = DATASET_PATH,
    buildSummaryPath = BUILD_SUMMARY_PATH,
  } = deps;

  return async function postHmrcAmlImport(req, res, next) {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'request body must be the raw HMRC AML register file bytes (Content-Type: application/octet-stream)',
        });
      }

      const uploadedAt = new Date().toISOString();
      const uploader = req.headers['x-admin-uploader'] || 'unknown';
      const fileName = req.headers['x-filename'] || 'upload.ods';

      const result = await runBatchAdapter(adapter, req.body, { sourceDate: uploadedAt.slice(0, 10) });

      if (result.fatalError) {
        return res.status(400).json({
          success: false,
          error: `HMRC AML file could not be parsed: ${result.fatalError.message}`,
          stage: result.fatalError.stage,
        });
      }

      const beforeIds = readOrganisationIds(datasetPath);

      fs.mkdirSync(path.dirname(importNdjsonPath), { recursive: true });
      fs.writeFileSync(
        importNdjsonPath,
        result.records.map((rec) => JSON.stringify(rec)).join('\n') + (result.records.length ? '\n' : '')
      );

      logger.info(`population-imports: hmrc-aml upload by ${uploader} — ${result.rowsParsed} rows parsed, ${result.rowsRejected} rejected, running Repository Authority rebuild…`);
      await runBuild();

      // Attribute each emitted record back to the organisation it merged
      // into by its hmrcAml value — the one attribution key this report can
      // use without a full per-org diff (WP-4's fuller ledger). A record
      // with a blank MLR registration number (CCS-HMRCAML-001 §7.3 — a null
      // anchor is preserved, not rejected) still merges into Repository
      // Authority correctly via its name+domain fallback, it just cannot be
      // individually attributed to a created/merged organisation in this
      // minimal report — a known simplification, not a data-loss bug: no
      // organisation or row is dropped, only this report's per-row
      // attribution granularity is incomplete for anchor-less rows.
      const afterOrgsByHmrcAml = readOrganisationIdsByHmrcAml(datasetPath);
      const touchedOrgIds = new Set();
      for (const rec of result.records) {
        if (!rec.hmrcAml) continue;
        const orgId = afterOrgsByHmrcAml.get(rec.hmrcAml);
        if (orgId) touchedOrgIds.add(orgId);
      }
      const organisationsCreated = [...touchedOrgIds].filter((id) => !beforeIds.has(id)).sort();
      const organisationsMergedIntoExisting = [...touchedOrgIds].filter((id) => beforeIds.has(id)).sort();

      const buildSummary = fs.existsSync(buildSummaryPath)
        ? JSON.parse(fs.readFileSync(buildSummaryPath, 'utf8'))
        : null;

      res.status(200).json({
        success: true,
        report: {
          source: 'hmrc-aml',
          uploader,
          fileName,
          uploadedAt,
          rowsParsed: result.rowsParsed,
          rowsRejected: result.rowsRejected,
          rejections: result.rejections.slice(0, 50),
          organisationsCreated,
          organisationsMergedIntoExisting,
          totalOrganisationsTouched: touchedOrgIds.size,
          buildSummary,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

const router = express.Router();
router.use(requireAdmin);
router.post('/population-imports', express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }), createUploadHandler());

module.exports = router;
module.exports.requireAdmin = requireAdmin;
module.exports.createUploadHandler = createUploadHandler;
