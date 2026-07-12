'use strict';

// report.test.js — T3.1 (ENG-013 WP3). DI/fake style, matching
// portfolio.test.js/observation-sessions.test.js (no HTTP server, no
// supertest, no real Puppeteer render).

const { test } = require('node:test');
const assert = require('node:assert');

const { createPostReport, riskLabelToPdfKey } = require('./report');
const { ValidationError } = require('../../infra/utils/errors');

// Fake PDF renderer — no real Puppeteer/Chrome launch in tests. Captures the
// exact args it was called with so tests can assert what actually reached it.
function fakeGeneratePDF(calls) {
  return async (args) => { calls.push(args); return Buffer.from('%PDF-fake'); };
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.send = (body) => { res.body = body; return res; };
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

test('riskLabelToPdfKey maps every canonical risk label to its PDF band key', () => {
  assert.strictEqual(riskLabelToPdfKey('Excellent'), 'excellent');
  assert.strictEqual(riskLabelToPdfKey('Good'), 'good');
  assert.strictEqual(riskLabelToPdfKey('Moderate Risk'), 'moderate');
  assert.strictEqual(riskLabelToPdfKey('High Risk'), 'high');
  assert.strictEqual(riskLabelToPdfKey('Critical Risk'), 'critical');
  assert.strictEqual(riskLabelToPdfKey('nonsense'), 'critical');
});

test('scanId is required — 400, no lookup attempted', async () => {
  let lookupCalled = false;
  const postReport = createPostReport(async () => { lookupCalled = true; return null; });
  const req = { body: {} };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await postReport(req, res, next);

  assert.strictEqual(lookupCalled, false);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(calls[0][0].statusCode, 400);
});

test('unknown scanId — 404, no PDF generated', async () => {
  const pdfCalls = [];
  const postReport = createPostReport(async () => null, fakeGeneratePDF(pdfCalls));
  const req = { body: { scanId: 'does-not-exist' } };
  const res = fakeRes();
  const { next } = fakeNext();

  await postReport(req, res, next);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(pdfCalls.length, 0);
});

test('a scan record with no scanner_results throws rather than fabricating a PDF', async () => {
  const pdfCalls = [];
  const postReport = createPostReport(
    async () => ({ id: 's1', domain: 'example.com', scanner_results: null }),
    fakeGeneratePDF(pdfCalls)
  );
  const req = { body: { scanId: 's1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await postReport(req, res, next);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0].statusCode, 500);
  assert.strictEqual(pdfCalls.length, 0);
});

test('client-supplied overallScore/riskLevel/scoreObject in the body are silently ignored — everything is re-derived from the stored scan', async () => {
  const storedScan = {
    id: 'scan-1',
    domain: 'example.com',
    scanned_at: '2026-01-01T00:00:00.000Z',
    scanner_results: SCANNER_RESULTS,
  };
  const pdfCalls = [];
  const postReport = createPostReport(
    async (id) => (id === 'scan-1' ? storedScan : null),
    fakeGeneratePDF(pdfCalls)
  );

  // The request tries to smuggle a fabricated Excellent/100 score, an
  // arbitrary scoreObject, and a different domain — none of this may reach
  // the PDF generator.
  const req = {
    body: {
      scanId: 'scan-1',
      overallScore: 100,
      riskLevel: 'Excellent',
      scoreObject: { achievedPoints: 999, totalMaximum: 1, percentage: 999, riskBand: 'Excellent' },
      domain: 'attacker-controlled.example',
      results: { fabricated: true },
    },
  };
  const res = fakeRes();
  const { next } = fakeNext();

  await postReport(req, res, next);

  assert.strictEqual(pdfCalls.length, 1);
  const passedToGenerator = pdfCalls[0];

  // Domain and score/riskLevel/scoreObject came from the STORED scan, not
  // the request body — the exact assertion this remediation exists to prove.
  assert.strictEqual(passedToGenerator.domain, 'example.com');
  assert.notStrictEqual(passedToGenerator.overallScore, 100);
  assert.notStrictEqual(passedToGenerator.riskLevel, 'excellent'); // real mix of PASS/WARN/FAIL never scores Excellent
  assert.notStrictEqual(passedToGenerator.scoreObject.achievedPoints, 999);
  assert.strictEqual(passedToGenerator.scoreObject.scoringVersion, 'v1.0');

  assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
  assert.ok(res.headers['Content-Disposition'].includes('example.com'));
  assert.ok(!res.headers['Content-Disposition'].includes('attacker-controlled'));
});
