'use strict';

// publicScanProtection.structural.test.js — T1.6 (ENG-010 §7, ENG-013 WP1).
//
// Static-analysis tests, not behavioural ones: they read the source of the
// new WP1 modules directly and assert forbidden patterns are structurally
// absent, mirroring the discipline ENG-007/ENG-009/ENG-010 all specify for
// their own equivalent guarantees ("asserted... as an explicit test... not
// just by absence of a call in the happy path").
//
// A deliberately "bad" import introduced temporarily into any of these files
// during development would fail this suite immediately — it is not a no-op
// check (verified manually while authoring this file).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIDDLEWARE_DIR = __dirname;
const WP1_FILES = [
  'publicScanRateLimit.js',
  'publicScanDomainCooldown.js',
  'publicScanConcurrencyGuard.js',
  'publicScanProtection.js',
];

function readSource(file) {
  return fs.readFileSync(path.join(MIDDLEWARE_DIR, file), 'utf8');
}

// ── Guarantee 1: cannot bypass the canonical ENG-007 orchestrator ───────────
// None of WP1's own modules calls into pipeline logic at all — they are a
// pure ingress-control layer, upstream of the (not-yet-built, ENG-009/WP2)
// route that will be the single call site into runOnDemandObservation.

test('no WP1 module imports the on-demand orchestrator, any collector, or any adapter', () => {
  const forbidden = [
    /on-demand-observation/,
    /observatory\/collection/,
    /collection\/runs/,
    /collection\/signals/,
    /organisation\/assemble/,
    /organisation\/resolve/,
  ];
  for (const file of WP1_FILES) {
    const src = readSource(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not reference ${pattern} — this layer is infrastructure only (ENG-010 §4)`);
    }
  }
});

// ── Guarantee 2: cannot reach scanService.js ─────────────────────────────────

test('no WP1 module imports scanService.js, legacy-scanner/*, or executeScan', () => {
  const forbidden = [
    /scanService/,
    /legacy-scanner/,
    /executeScan/,
    /deriveTrustScore/,
    /getRiskLevel/,
    /getRiskBand/,
  ];
  for (const file of WP1_FILES) {
    const src = readSource(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not reference ${pattern}`);
    }
  }
});

// ── Guarantee 3: cannot reach scan.js or gate.js ─────────────────────────────

test('no WP1 module requires routes/scan.js, routes/gate.js, or routes/report.js', () => {
  const forbidden = [/routes\/scan/, /routes\/gate/, /routes\/report/];
  for (const file of WP1_FILES) {
    const src = readSource(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not reference ${pattern}`);
    }
  }
});

// ── Guarantee 4: cannot reach score_object or the 206-point engine ──────────

test('no WP1 module references score_object, scoreObject, or MAX_POINTS', () => {
  const forbidden = [/score_object/, /scoreObject/, /MAX_POINTS/];
  for (const file of WP1_FILES) {
    const src = readSource(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not reference ${pattern}`);
    }
  }
});

// ── No duplicate state: only observation_sessions is touched, read-only ────

test('publicScanDomainCooldown.js and publicScanConcurrencyGuard.js only query observation_sessions, and never write', () => {
  for (const file of ['publicScanDomainCooldown.js', 'publicScanConcurrencyGuard.js']) {
    const src = readSource(file);
    const fromCalls = [...src.matchAll(/\.from\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.ok(fromCalls.length > 0, `${file} should query at least one table`);
    for (const table of fromCalls) {
      assert.strictEqual(table, 'observation_sessions', `${file} must only read observation_sessions — found a query against '${table}'`);
    }
    assert.ok(!/\.insert\(/.test(src), `${file} must never write (found .insert()) — this layer is read-only`);
    assert.ok(!/\.update\(/.test(src), `${file} must never write (found .update()) — this layer is read-only`);
    assert.ok(!/\.delete\(/.test(src), `${file} must never write (found .delete()) — this layer is read-only`);
  }
});

test('publicScanRateLimit.js touches no database at all — stateless, in-memory only (ENG-010 §2.4)', () => {
  const src = readSource('publicScanRateLimit.js');
  assert.ok(!/getClient|supabase|\.from\(/i.test(src), 'the rate-limit module must have no database dependency');
});

// ── Never mounted globally, even now that WP2 has shipped the route it
//    protects ──────────────────────────────────────────────────────────────
// (Updated for WP2, ENG-013: backend/api/routes/public-scan.js now mounts
// this layer — see publicScanExperience.structural.test.js for the WP2-side
// proof that it is scoped to that route's trigger handler only. This test's
// job stays the same as it was for WP1: prove server.js itself never
// references the middleware directly, i.e. never applies it via a bare
// top-level app.use() — only public-scan.js's own router may compose it.)

test('server.js does not require any WP1 middleware module directly — it is composed only inside public-scan.js\'s own router, never applied globally', () => {
  const serverSrc = fs.readFileSync(path.join(MIDDLEWARE_DIR, '..', '..', 'server.js'), 'utf8');
  for (const file of WP1_FILES) {
    const moduleName = file.replace(/\.js$/, '');
    assert.ok(!serverSrc.includes(moduleName), `server.js must not reference ${moduleName} directly — it is mounted only inside public-scan.js's own router (WP2)`);
  }
});

// ── Existing authenticated routes are untouched ─────────────────────────────

test('the existing authenticated on-demand route is untouched by this change', () => {
  const routeSrc = fs.readFileSync(
    path.join(MIDDLEWARE_DIR, '..', 'routes', 'observation-sessions.js'),
    'utf8'
  );
  for (const file of WP1_FILES) {
    const moduleName = file.replace(/\.js$/, '');
    assert.ok(!routeSrc.includes(moduleName), `observation-sessions.js must not reference ${moduleName} — this route's protection (requireAuth) is unrelated and unchanged (ENG-010 §6)`);
  }
  assert.ok(routeSrc.includes('requireAuth'), 'the authenticated route must still be requireAuth-gated');
});
