'use strict';

// population-imports.test.js — tests POST /population-imports in isolation
// (no HTTP server, no supertest; matches this codebase's DI + fake req/res
// style — observation-sessions.test.js, me.test.js). Every filesystem path
// (import ndjson / dataset / build-summary) and the build-runner itself are
// injected per test into a fresh temp directory — this suite never reads or
// writes any real repository path, and never spawns the real build.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUploadHandler, requireAdmin } = require('./population-imports');
const { buildOdsBuffer } = require('../../pae/adapters/hmrc-aml/test-fixtures/build-ods');

const HEADERS = ['MLR Registration Number', 'Business Name', 'Trading Name', 'Postcode', 'Status'];

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-imports-test-'));
  return {
    dir,
    importNdjsonPath: path.join(dir, 'hmrc-aml-import.ndjson'),
    datasetPath: path.join(dir, 'organisations.ndjson'),
    buildSummaryPath: path.join(dir, 'build-summary.json'),
  };
}

function writeDataset(datasetPath, orgs) {
  fs.writeFileSync(datasetPath, orgs.map((o) => JSON.stringify(o)).join('\n') + (orgs.length ? '\n' : ''));
}

// ── requireAdmin ─────────────────────────────────────────────────────────────

test('requireAdmin: 401 when the token header is missing or wrong', () => {
  const originalToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secret-token';
  try {
    let called = false;
    const res = fakeRes();
    requireAdmin({ headers: {} }, res, () => { called = true; });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(called, false);

    const res2 = fakeRes();
    requireAdmin({ headers: { 'x-admin-token': 'wrong' } }, res2, () => { called = true; });
    assert.strictEqual(res2.statusCode, 401);
    assert.strictEqual(called, false);
  } finally {
    process.env.ADMIN_TOKEN = originalToken;
  }
});

test('requireAdmin: calls next() when the token matches', () => {
  const originalToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secret-token';
  try {
    let called = false;
    const res = fakeRes();
    requireAdmin({ headers: { 'x-admin-token': 'secret-token' } }, res, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual(res.statusCode, null);
  } finally {
    process.env.ADMIN_TOKEN = originalToken;
  }
});

// ── Input validation — adapter and build never run ─────────────────────────

test('missing/empty body — 400, adapter and build never called', async () => {
  let adapterCalled = false;
  let buildCalled = false;
  const handler = createUploadHandler({
    adapter: { sourceId: 'x', parse: async () => { adapterCalled = true; return []; }, validateStructure: (r) => r, normalise: (r) => r },
    runBuild: async () => { buildCalled = true; },
  });

  const res = fakeRes();
  await handler({ headers: {}, body: undefined }, res, (err) => { throw err; });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(adapterCalled, false);
  assert.strictEqual(buildCalled, false);
});

// ── Adapter fatal error — 400, build never runs ────────────────────────────

test('malformed file (adapter fatalError) — 400 naming the stage, build never called', async () => {
  let buildCalled = false;
  const handler = createUploadHandler({ runBuild: async () => { buildCalled = true; } });

  const res = fakeRes();
  await handler({ headers: {}, body: Buffer.from('not an ods file') }, res, (err) => { throw err; });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.stage, 'parse');
  assert.strictEqual(buildCalled, false);
});

// ── Successful import — full report shape ──────────────────────────────────

test('successful import: report shows rows parsed/rejected, a newly-created organisation, and calls the real adapter + injected build', async () => {
  const { importNdjsonPath, datasetPath, buildSummaryPath } = tempPaths();
  writeDataset(datasetPath, []); // no pre-existing organisations

  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [
      ['12137104', 'POST OFFICE LIMITED', 'ABBERLEY', 'WR6', 'APPROVED'],
      ['', 'NO ANCHOR LTD', '', '', 'APPROVED'], // structurally valid, blank anchor
      ['999', '', '', '', ''], // rejected: blank Business Name
    ],
  });

  let buildCalled = false;
  const handler = createUploadHandler({
    importNdjsonPath,
    datasetPath,
    buildSummaryPath,
    runBuild: async () => {
      buildCalled = true;
      // Simulate build.js's effect: it would have read importNdjsonPath
      // (via loadHmrcAmlImport()) and merged it into the dataset. Assert the
      // route wrote exactly what the adapter emitted, then write the
      // "post-build" dataset the route reads back afterward.
      const written = fs.readFileSync(importNdjsonPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.strictEqual(written.length, 2); // 3 rows in, 1 rejected (blank name)
      writeDataset(datasetPath, written.map((rec, i) => ({
        organisationId: `ORG-TEST-${i}`,
        identifiers: { hmrcAml: rec.hmrcAml },
      })));
      fs.writeFileSync(buildSummaryPath, JSON.stringify({ totalOrganisations: written.length }));
    },
  });

  const res = fakeRes();
  await handler(
    { headers: { 'x-admin-uploader': 'tester@soterius.com', 'x-filename': 'register.ods' }, body: buf },
    res,
    (err) => { throw err; }
  );

  assert.strictEqual(buildCalled, true);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  const { report } = res.body;
  assert.strictEqual(report.source, 'hmrc-aml');
  assert.strictEqual(report.uploader, 'tester@soterius.com');
  assert.strictEqual(report.fileName, 'register.ods');
  assert.strictEqual(report.rowsParsed, 3);
  assert.strictEqual(report.rowsRejected, 1);
  assert.strictEqual(report.rejections.length, 1);
  // Only the row with a non-null hmrcAml can be attributed back to a created
  // organisation by this minimal report (matching by hmrcAml value) — the
  // blank-anchor row still gets merged into Repository Authority correctly
  // (build.js/identity.js keys it on its name+domain fallback), it just isn't
  // individually attributable in this slice's report, a known simplification
  // of "minimal" (ENG-024 WP-3) left for WP-4's fuller ledger.
  assert.strictEqual(report.organisationsCreated.length, 1);
  assert.strictEqual(report.organisationsMergedIntoExisting.length, 0);
  assert.strictEqual(report.totalOrganisationsTouched, 1);
  assert.deepStrictEqual(report.buildSummary, { totalOrganisations: 2 });
});

test('successful import: an hmrcAml value already present in the dataset is reported as merged, not created', async () => {
  const { importNdjsonPath, datasetPath, buildSummaryPath } = tempPaths();
  writeDataset(datasetPath, [{ organisationId: 'ORG-EXISTING', identifiers: { hmrcAml: '12137104' } }]);

  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [['12137104', 'POST OFFICE LIMITED', 'ABBEY LANE', 'S8', 'APPROVED']],
  });

  const handler = createUploadHandler({
    importNdjsonPath,
    datasetPath,
    buildSummaryPath,
    runBuild: async () => {
      // Simulated rebuild: the existing organisation is unchanged (already
      // matched by hmrcAml); dataset content stays the same as "before".
    },
  });

  const res = fakeRes();
  await handler({ headers: {}, body: buf }, res, (err) => { throw err; });

  assert.strictEqual(res.body.report.organisationsCreated.length, 0);
  assert.deepStrictEqual(res.body.report.organisationsMergedIntoExisting, ['ORG-EXISTING']);
});
