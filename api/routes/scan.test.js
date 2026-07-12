'use strict';

// scan.test.js — T3.2 (ENG-013 WP3). DI/fake style, testing only the
// remediated POST /submit-gate handler in isolation (no HTTP server, no
// supertest, no real Supabase/email calls). POST /, GET /history/:domain,
// and GET /download-pdf/:submissionId are untouched by this change and are
// not covered here.

const { test } = require('node:test');
const assert = require('node:assert');

const { createSubmitGateHandler } = require('./scan');
const { ValidationError, AppError } = require('../../infra/utils/errors');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function fakeNext() {
  const calls = [];
  return { next: (...args) => calls.push(args), calls };
}

const SCANNER_RESULTS = [
  { key: 'ssl', name: 'SSL/TLS Encryption', checks: [{ name: 'Valid SSL', status: 'PASS', details: '', timeToFix: '' }] },
  { key: 'email', name: 'Email Security', checks: [{ name: 'SPF', status: 'PASS', details: '', timeToFix: '' }] },
  { key: 'headers', name: 'Security Headers', checks: [{ name: 'CSP', status: 'FAIL', details: '', timeToFix: '' }] },
  { key: 'vulnComp', name: 'Vulnerable Components', checks: [{ name: 'Outdated lib', status: 'WARNING', details: '', timeToFix: '' }] },
  { key: 'gdpr', name: 'GDPR / Cookie Compliance', checks: [{ name: 'Cookie banner', status: 'PASS', details: '', timeToFix: '' }] },
];

const baseBody = () => ({
  domain: 'example.com',
  email: 'jane@example.com',
  scanId: 'scan-1',
});

function makeDeps({ scan } = {}) {
  const saveSubmissionCalls = [];
  const emailCalls = [];
  return {
    getScanByIdFn: async (id) => (id === 'scan-1' ? scan : null),
    saveSubmissionFn: async (...args) => { saveSubmissionCalls.push(args); return { success: true, id: 'sub-1' }; },
    sendConfirmationEmailFn: async (...args) => { emailCalls.push(args); },
    saveSubmissionCalls,
    emailCalls,
  };
}

const storedScan = { id: 'scan-1', domain: 'example.com', scanned_at: '2026-01-01T00:00:00.000Z', scanner_results: SCANNER_RESULTS };

test('scanId is now required — 400, no submission written', async () => {
  const deps = makeDeps({ scan: storedScan });
  const handler = createSubmitGateHandler(deps);
  const req = { body: { domain: 'example.com', email: 'jane@example.com' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(deps.saveSubmissionCalls.length, 0);
});

test('scanId that does not exist — 404, no submission written', async () => {
  const deps = makeDeps({ scan: null });
  const handler = createSubmitGateHandler(deps);
  const req = { body: baseBody() };
  const res = fakeRes();
  const { next } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(deps.saveSubmissionCalls.length, 0);
});

test('scanId belonging to a different domain is rejected — 400, no submission written', async () => {
  const deps = makeDeps({ scan: { ...storedScan, domain: 'other-domain.com' } });
  const handler = createSubmitGateHandler(deps);
  const req = { body: baseBody() }; // body says domain: 'example.com'
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(deps.saveSubmissionCalls.length, 0);
});

test('client-supplied scanScore/scanResults/scoreObject are no longer accepted — everything persisted is derived from the stored scan', async () => {
  const deps = makeDeps({ scan: storedScan });
  const handler = createSubmitGateHandler(deps);

  const req = {
    body: {
      ...baseBody(),
      // Attempts to smuggle a fabricated result — these fields no longer
      // exist in the accepted request shape at all.
      scanScore: 100,
      scanResults: [{ name: 'fabricated', score: 100 }],
      scoreObject: { achievedPoints: 999, totalMaximum: 1, percentage: 999, riskBand: 'Excellent' },
    },
  };
  const res = fakeRes();
  const { next } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(deps.saveSubmissionCalls.length, 1);

  const [, , persistedScore, persistedRiskLevel, , , persistedScanners, persistedScoreObject, persistedScanId] =
    deps.saveSubmissionCalls[0];

  // None of the fabricated values reached persistence.
  assert.notStrictEqual(persistedScore, 100);
  assert.notStrictEqual(persistedRiskLevel, 'Excellent');
  assert.notStrictEqual(persistedScoreObject.achievedPoints, 999);
  assert.strictEqual(persistedScoreObject.scoringVersion, 'v1.0');
  assert.ok(Array.isArray(persistedScanners));
  assert.ok(persistedScanners.every((s) => typeof s.name === 'string' && Array.isArray(s.checks)));
  assert.strictEqual(persistedScanId, 'scan-1');
});

test('a scan record with no scanner_results throws rather than fabricating a submission', async () => {
  const deps = makeDeps({ scan: { ...storedScan, scanner_results: null } });
  const handler = createSubmitGateHandler(deps);
  const req = { body: baseBody() };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof AppError);
  assert.strictEqual(deps.saveSubmissionCalls.length, 0);
});

test('invalid email is still rejected before any scan lookup', async () => {
  const deps = makeDeps({ scan: storedScan });
  const handler = createSubmitGateHandler(deps);
  const req = { body: { ...baseBody(), email: 'not-an-email' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await handler(req, res, next);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
});
