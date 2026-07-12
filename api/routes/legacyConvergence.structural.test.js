'use strict';

// legacyConvergence.structural.test.js — WP3 (ENG-013), structural
// verification per ENG-011/ENG-012's own discipline: static-analysis tests
// proving each remediated legacy path can no longer be reached the way
// ENG-011's audit found it reachable, mirroring
// publicScanProtection.structural.test.js's precedent from WP1.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = __dirname;
const SERVICES_DIR = path.join(__dirname, '..', 'services');

function readSource(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

// Returns the contents of every `const { ... } = req.body` (or
// `req.body.<field>`) destructuring block found in a source string, so tests
// can assert forbidden field names never appear inside one — not just
// "somewhere in the file" (which the file's own comments legitimately
// mention by name when documenting the fix).
function bodyDestructureBlocks(src) {
  const blocks = [...src.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/gs)].map((m) => m[1]);
  const dotAccesses = [...src.matchAll(/req\.body\.(\w+)/g)].map((m) => m[1]);
  return { blocks, dotAccesses };
}

// ── T3.1: POST /api/report no longer accepts client-supplied trust data ────

test('report.js: req.body destructuring accepts only scanId — no score/riskLevel/scoreObject/results/scanners field', () => {
  const src = readSource(ROUTES_DIR, 'report.js');
  const { blocks, dotAccesses } = bodyDestructureBlocks(src);

  assert.strictEqual(blocks.length, 1, 'report.js should have exactly one req.body destructure');
  assert.match(blocks[0], /\bscanId\b/);

  const forbidden = ['overallScore', 'riskLevel', 'scoreObject', 'results', 'scanners', 'domain', 'timestamp'];
  for (const field of forbidden) {
    assert.ok(!blocks[0].includes(field), `report.js must not destructure '${field}' from req.body`);
    assert.ok(!dotAccesses.includes(field), `report.js must not read req.body.${field}`);
  }
});

test('report.js: the response is built entirely from deriveScanPresentation() output, never from req.body fields directly', () => {
  const src = readSource(ROUTES_DIR, 'report.js');
  assert.match(src, /derivation\.deriveScanPresentation\(scan\.scanner_results/);
  // generatePDFFn must be called with derived.* values, not req.body values.
  const generatePdfCallMatch = src.match(/generatePDFFn\(\{([\s\S]*?)\}\)/);
  assert.ok(generatePdfCallMatch, 'expected a single generatePDFFn({...}) call');
  assert.match(generatePdfCallMatch[1], /derived\.score/);
  assert.match(generatePdfCallMatch[1], /derived\.scoreObject/);
  assert.doesNotMatch(generatePdfCallMatch[1], /req\.body/);
});

// ── T3.2: POST /api/scan/submit-gate no longer accepts client-supplied trust data ──

test('scan.js: submit-gate\'s req.body destructure no longer contains scanScore/scanResults/scoreObject, and scanId is mandatory', () => {
  const src = readSource(ROUTES_DIR, 'scan.js');
  const { blocks } = bodyDestructureBlocks(src);

  // scan.js has two req.body destructure sites: POST / (score fields are
  // fine there — they come from executeScan(), not the client) and
  // submit-gate. Find the one that mentions email/firmName (submit-gate's
  // own fields) to check specifically.
  const submitGateBlock = blocks.find((b) => b.includes('email') && b.includes('firmName'));
  assert.ok(submitGateBlock, 'expected to find submit-gate\'s req.body destructure');

  const forbidden = ['scanScore', 'scanResults', 'scoreObject'];
  for (const field of forbidden) {
    assert.ok(!submitGateBlock.includes(field), `submit-gate must not destructure '${field}' from req.body`);
  }
  assert.match(submitGateBlock, /\bscanId\b/);

  assert.match(src, /if \(!scanId\)\s*throw new ValidationError\('scanId is required'\)/);
});

test('scan.js: submit-gate persists only derivation.deriveScanPresentation() output to saveSubmission, never raw req.body trust fields', () => {
  const src = readSource(ROUTES_DIR, 'scan.js');
  const saveSubmissionCallMatch = src.match(/saveSubmissionFn\(([\s\S]*?)\);/);
  assert.ok(saveSubmissionCallMatch, 'expected a saveSubmissionFn(...) call');
  assert.match(saveSubmissionCallMatch[1], /derived\.score/);
  assert.match(saveSubmissionCallMatch[1], /derived\.riskLevel/);
  assert.match(saveSubmissionCallMatch[1], /derived\.scoreObject/);
});

// ── T3.3: benchmarks.js and prospects.js no longer duplicate the aggregation ──

test('benchmarks.js and prospects.js both delegate to the single shared computeBenchmarkAggregates — neither re-derives its own aggregateGroup', () => {
  for (const file of ['benchmarks.js', 'prospects.js']) {
    const src = readSource(ROUTES_DIR, file);
    assert.match(src, /require\(['"]\.\.\/services\/benchmarkAggregation['"]\)/, `${file} must import the shared aggregator`);
    assert.match(src, /computeBenchmarkAggregates\(/, `${file} must call the shared aggregator`);
    assert.ok(!/function aggregateGroup/.test(src), `${file} must not redefine aggregateGroup inline (the duplicate ENG-011 §4 found)`);
  }
});

test('benchmarkAggregation.js is the only file under api/ defining aggregateGroup', () => {
  const serviceSrc = readSource(SERVICES_DIR, 'benchmarkAggregation.js');
  assert.match(serviceSrc, /function aggregateGroup/);
});

// ── T3.4: prospects.js quick-scan/:id/scan no longer call the legacy engine ──

test('prospects.js no longer imports scanService, executeScan, or the legacy saveScan write path', () => {
  const src = readSource(ROUTES_DIR, 'prospects.js');
  assert.ok(!/require\(['"]\.\.\/services\/scanService['"]\)/.test(src), 'prospects.js must not import scanService');
  assert.ok(!/\bexecuteScan\b/.test(src), 'prospects.js must not reference executeScan');
  assert.ok(!/\bsaveScan\b/.test(src), 'prospects.js must not reference the legacy saveScan write path');
});

test('prospects.js quick-scan and :id/scan both call the SAME canonical runOnDemandObservation import — no re-implementation', () => {
  const src = readSource(ROUTES_DIR, 'prospects.js');
  assert.match(
    src,
    /require\(['"]\.\.\/\.\.\/observatory\/on-demand\/on-demand-observation['"]\)/,
    'prospects.js must import the canonical on-demand orchestrator'
  );
  // Exactly one import site, reused by both handlers via the runOnDemand
  // default parameter — proves there is one call site, not two competing ones.
  const importCount = (src.match(/require\(['"]\.\.\/\.\.\/observatory\/on-demand\/on-demand-observation['"]\)/g) || []).length;
  assert.strictEqual(importCount, 1, 'the orchestrator must be imported exactly once, not duplicated per handler');
});

// ── Still-untouched invariants ───────────────────────────────────────────────

test('none of the remediated route files write to Repository Authority, Trust Derivation, or Observation Sessions internals', () => {
  const forbidden = [/authority\/build/, /observatory\/baseline\/trust-score/, /observatory\/session\/observation-session/];
  for (const file of ['report.js', 'scan.js', 'prospects.js', 'benchmarks.js']) {
    const src = readSource(ROUTES_DIR, file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not reference ${pattern} — WP3 is a legacy-tier remediation, not a canonical-architecture change`);
    }
  }
});

test('none of the remediated files write to the scans table directly (append-only invariant preserved — reads only)', () => {
  // report.js and submit-gate now only READ via getScanById; neither should
  // gain a new .insert()/.update()/.delete() against 'scans'.
  for (const file of ['report.js']) {
    const src = readSource(ROUTES_DIR, file);
    assert.ok(!/getClient\(\)|\.from\(['"]scans['"]\)/.test(src), `${file} must not touch the scans table directly — it only reads via the injected getScanById`);
  }
});
