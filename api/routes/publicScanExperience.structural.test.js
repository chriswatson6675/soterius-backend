'use strict';

// publicScanExperience.structural.test.js — WP2 (ENG-013), structural
// verification per this task's explicit requirements: prove the new public
// route is the only anonymous entry into the canonical observation
// pipeline, prove WP1's protection middleware is mounted only on that
// route, and prove no new path reaches legacy execution. Mirrors
// publicScanProtection.structural.test.js (WP1) and
// legacyConvergence.structural.test.js (WP3)'s own static-analysis style.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = __dirname;
const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');

function readSource(file) {
  return fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
}

function listRouteFiles() {
  return fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
}

// ── Requirement 1: the new public route is the ONLY anonymous entry into
//    the canonical observation pipeline ───────────────────────────────────

test('exactly three route files reference the on-demand orchestrator, and public-scan.js is the only one with no credential gate at all', () => {
  const referencing = listRouteFiles().filter((f) => /on-demand-observation/.test(readSource(f)));
  assert.deepStrictEqual(referencing.sort(), ['observation-sessions.js', 'prospects.js', 'public-scan.js']);

  // observation-sessions.js — authenticated user session (requireAuth).
  assert.match(readSource('observation-sessions.js'), /requireAuth/);
  // prospects.js — shared-secret admin token (requireAdmin), migrated in WP3
  // (ENG-013 T3.4) — gated, not anonymous, even though it has no user session.
  assert.match(readSource('prospects.js'), /requireAdmin/);
  // public-scan.js — the one genuinely anonymous entry point; it imports no
  // auth middleware at all (checked as an import, not a prose match — its
  // own header comments legitimately discuss /api/organisation's requireAuth
  // gate by name as context for why this route is deliberately separate).
  const publicScanSrc = readSource('public-scan.js');
  assert.ok(!/require\(['"].*middleware\/(requireAuth|requireAdmin|attachTenant)['"]\)/.test(publicScanSrc));
});

test('public-scan.js imports runOnDemandObservation exactly once — one call site, no duplicate orchestration', () => {
  const src = readSource('public-scan.js');
  const importCount = (src.match(/require\(['"]\.\.\/\.\.\/observatory\/on-demand\/on-demand-observation['"]\)/g) || []).length;
  assert.strictEqual(importCount, 1);
  const callSiteCount = (src.match(/runOnDemand\(/g) || []).length;
  assert.strictEqual(callSiteCount, 1, 'expected exactly one call site into the orchestrator');
});

test('public-scan.js\'s trigger route has no auth middleware in its chain — it is genuinely anonymous, not admin-token-gated like prospects.js', () => {
  const src = readSource('public-scan.js');
  const triggerLine = src.match(/router\.post\('\/',[\s\S]*?\);/);
  assert.ok(triggerLine, 'expected to find the POST / registration');
  assert.ok(!/requireAuth|requireAdmin|attachTenant/.test(triggerLine[0]), 'the trigger route must have no auth middleware');
});

test('public-scan.js does not call createSession/transition directly — session lifecycle stays exclusively inside runOnDemandObservation, never duplicated here', () => {
  const src = readSource('public-scan.js');
  assert.ok(!/\bcreateSession\(/.test(src), 'public-scan.js must not create sessions directly');
  assert.ok(!/\btransition\(/.test(src), 'public-scan.js must not transition sessions directly');
  assert.match(src, /sessionModule\.getSession/, 'reading a session is fine — only reuses the existing read function');
});

// ── Requirement 2: WP1 protection middleware is mounted ONLY on the trigger route ──

test('publicScanProtection is required by exactly one route file: public-scan.js', () => {
  const referencing = listRouteFiles().filter((f) => /publicScanProtection/.test(readSource(f)));
  assert.deepStrictEqual(referencing, ['public-scan.js']);
});

test('publicScanProtection() is invoked exactly once in public-scan.js, and only inside the POST / registration — never on the GET routes', () => {
  const src = readSource('public-scan.js');
  const invocationCount = (src.match(/publicScanProtection\(\)/g) || []).length;
  assert.strictEqual(invocationCount, 1);

  const triggerLine = src.match(/router\.post\('\/',[\s\S]*?\);/)[0];
  assert.match(triggerLine, /publicScanProtection\(\)/);

  const getSessionLine = src.match(/router\.get\('\/sessions\/:id',[\s\S]*?\);/)[0];
  const getTrustLine = src.match(/router\.get\('\/trust',[\s\S]*?\);/)[0];
  assert.ok(!/publicScanProtection/.test(getSessionLine), 'the session-poll route must not carry WP1 protection (explicit scope decision)');
  assert.ok(!/publicScanProtection/.test(getTrustLine), 'the trust-read route must not carry WP1 protection (explicit scope decision)');
});

test('server.js never applies publicScanProtection or any of its three middlewares globally — only public-scan.js references them', () => {
  const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
  for (const name of ['publicScanProtection', 'publicScanRateLimit', 'publicScanDomainCooldown', 'publicScanConcurrencyGuard']) {
    assert.ok(!serverSrc.includes(name), `server.js must not reference ${name} directly — it is mounted only inside public-scan.js's own router`);
  }
  assert.match(serverSrc, /require\(['"]\.\/api\/routes\/public-scan['"]\)/);
  assert.match(serverSrc, /app\.use\(['"]\/api\/public-scan['"],\s*publicScanRouter\)/);
});

// ── Requirement 3: no new path reaches legacy execution ─────────────────────

test('public-scan.js cannot reach scanService.js, legacy-scanner, scan.js/gate.js/report.js, score_object, or MAX_POINTS', () => {
  const src = readSource('public-scan.js');
  const forbidden = [
    /scanService/, /legacy-scanner/, /executeScan/, /deriveTrustScore/,
    /routes\/scan['"]/, /routes\/gate/, /routes\/report/,
    /score_object/, /scoreObject/, /MAX_POINTS/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(src), `public-scan.js must not reference ${pattern}`);
  }
});

test('public-scan.js does not touch Repository Authority or the Trust Score engine directly — only reads via the canonical, already-governed resolve/assemble/session functions', () => {
  const src = readSource('public-scan.js');
  assert.ok(!/authority\/build/.test(src), 'must not reference Repository Authority\'s write module');
  assert.ok(!/observatory\/baseline\/trust-score/.test(src), 'must not reference the Trust Score engine directly — that is invoked only inside the Quality Models/on-demand pipeline, never duplicated here');
});

test('public-scan.js reuses the canonical resolver and assembler — resolveOrganisationByDomain, assembleById, assembleFromDiscovery — imported once each, not re-implemented', () => {
  const src = readSource('public-scan.js');
  assert.match(src, /require\(['"]\.\.\/\.\.\/organisation\/resolve['"]\)/);
  assert.match(src, /require\(['"]\.\.\/\.\.\/organisation\/assemble['"]\)/);
  const resolveCount = (src.match(/require\(['"]\.\.\/\.\.\/organisation\/resolve['"]\)/g) || []).length;
  const assembleCount = (src.match(/require\(['"]\.\.\/\.\.\/organisation\/assemble['"]\)/g) || []).length;
  assert.strictEqual(resolveCount, 1);
  assert.strictEqual(assembleCount, 1);
});

test('the trust-read route never picks a candidate on AMBIGUOUS — no assembler call appears in that branch', () => {
  const src = readSource('public-scan.js');
  const ambiguousBranch = src.match(/if \(resolution\.outcome === 'AMBIGUOUS'\) \{([\s\S]*?)\n {6}\}/);
  assert.ok(ambiguousBranch, 'expected to find the AMBIGUOUS branch');
  assert.ok(!/assembleByIdFn|assembleFromDiscoveryFn/.test(ambiguousBranch[1]), 'AMBIGUOUS must never call an assembler — candidates are disclosed, never resolved silently');
});
