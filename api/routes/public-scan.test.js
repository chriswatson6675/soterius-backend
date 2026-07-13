'use strict';

// public-scan.test.js — WP2 (ENG-013). Tests each handler factory in
// isolation (no HTTP server, no supertest, no WP1 middleware in the chain —
// matches observation-sessions.test.js's convention of testing
// createOnDemandHandler directly without requireAuth in front of it).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createTriggerHandler, createGetSessionHandler, createGetTrustHandler,
} = require('./public-scan');

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  return res;
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── POST /api/public-scan (trigger) ─────────────────────────────────────────

test('trigger: missing domain — 400, orchestrator never invoked', () => {
  let called = false;
  const handler = createTriggerHandler(async () => { called = true; return { ok: true }; });
  const req = { body: {} };
  const res = fakeRes();

  handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(called, false);
});

test('trigger: SSRF-blocked domain (localhost) — 400, orchestrator never invoked', () => {
  let called = false;
  const handler = createTriggerHandler(async () => { called = true; return { ok: true }; });
  const req = { body: { domain: 'localhost' } };
  const res = fakeRes();

  handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(called, false);
});

test('trigger: domain is normalised before reaching the orchestrator', async () => {
  let receivedDomain = null;
  const gate = deferred();
  const handler = createTriggerHandler((domain, opts) => {
    receivedDomain = domain;
    opts.onSessionCreated({ id: 'session-1' });
    return gate.promise;
  });
  const req = { body: { domain: 'https://www.Example.com/path' } };
  const res = fakeRes();

  handler(req, res);
  await flush();
  gate.resolve({ ok: true });

  assert.strictEqual(receivedDomain, 'example.com');
});

test('trigger: returns 202 with sessionId as soon as onSessionCreated fires — anonymous, no requestedBy identity', async () => {
  const gate = deferred();
  const handler = createTriggerHandler((domain, opts) => {
    assert.strictEqual(opts.requestedBy, null);
    opts.onSessionCreated({ id: 'session-42' });
    return gate.promise;
  });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();

  handler(req, res);
  await flush();

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.sessionId, 'session-42');
  assert.strictEqual(res.body.domain, 'example.com');

  gate.resolve({ ok: true });
});

test('trigger: session creation failure — 502', async () => {
  const handler = createTriggerHandler(async () => ({ ok: false, error: 'db unreachable' }));
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();

  handler(req, res);
  await flush();
  await flush();

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.success, false);
});

test('trigger: a rejected orchestrator promise — 502, not an unhandled rejection', async () => {
  const handler = createTriggerHandler(async () => { throw new Error('unexpected'); });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();

  handler(req, res);
  await flush();
  await flush();

  assert.strictEqual(res.statusCode, 502);
});

// ── GET /api/public-scan/sessions/:id (poll) ────────────────────────────────

test('session poll: unknown id — 404', async () => {
  const handler = createGetSessionHandler(async () => ({ ok: false, error: 'not found' }));
  const req = { params: { id: 'missing' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, 404);
});

test('session poll: returns a redacted shape — no internal events array exposed', async () => {
  const fullSession = {
    id: 's1',
    status: 'completed',
    scope: { domain: 'example.com', requestedBy: null },
    metadata: { resolutionOutcome: 'RESOLVED', organisationId: 'ORG-ABC123', signalsObserved: 10, signalsScored: 9, signalsFailed: 1, signalsTotal: 10 },
    events: [{ from: null, to: 'running', at: '2026-01-01T00:00:00Z' }, { from: 'running', to: 'completed', at: '2026-01-01T00:01:00Z' }],
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T00:01:00Z',
  };
  const handler = createGetSessionHandler(async () => ({ ok: true, session: fullSession }));
  const req = { params: { id: 's1' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.body.session.id, 's1');
  assert.strictEqual(res.body.session.status, 'completed');
  assert.strictEqual(res.body.session.domain, 'example.com');
  assert.strictEqual(res.body.session.resolutionOutcome, 'RESOLVED');
  assert.strictEqual(res.body.session.organisationId, 'ORG-ABC123');
  assert.strictEqual(res.body.session.signalsObserved, 10);
  assert.strictEqual(res.body.session.events, undefined); // never exposed publicly
  assert.strictEqual(res.body.session.requestedBy, undefined); // scope not exposed wholesale either
});

test('session poll: a session with no metadata yet (still queued) does not crash', async () => {
  const handler = createGetSessionHandler(async () => ({
    ok: true,
    session: { id: 's2', status: 'queued', scope: { domain: 'example.com' }, metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  }));
  const req = { params: { id: 's2' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.body.session.status, 'queued');
  assert.strictEqual(res.body.session.resolutionOutcome, null);
});

// ── GET /api/public-scan/trust?domain=... (read) ────────────────────────────

test('trust read: missing/invalid domain — 400, resolution never attempted', async () => {
  let resolveCalled = false;
  const handler = createGetTrustHandler({ resolveOrganisationByDomainFn: () => { resolveCalled = true; } });
  const req = { query: {} };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(resolveCalled, false);
});

test('trust read: RESOLVED — calls assembleById with the resolved id, never assembleFromDiscovery', async () => {
  let assembleByIdArg = null;
  let discoveryCalled = false;
  const handler = createGetTrustHandler({
    resolveOrganisationByDomainFn: () => ({ outcome: 'RESOLVED', organisationId: 'ORG-REAL0000001' }),
    assembleByIdFn: async (id) => { assembleByIdArg = id; return { ok: true, organisation: { id, displayName: 'Real Firm', domains: [], digitalTrust: null } }; },
    assembleFromDiscoveryFn: async () => { discoveryCalled = true; return { ok: true, organisation: {} }; },
  });
  const req = { query: { domain: 'example.com' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(assembleByIdArg, 'ORG-REAL0000001');
  assert.strictEqual(discoveryCalled, false);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.resolutionOutcome, 'RESOLVED');
  assert.strictEqual(res.body.organisation.displayName, 'Real Firm');
});

// ── Redaction (ENG-008 §9 canonical authority) ──────────────────────────────
// This endpoint must NEVER return the full Organisation shape the
// authenticated GET /api/organisation/:id route returns — only publicTrustView's
// redacted projection. These tests assert the shape directly, not just that a
// redaction function was called, so a future accidental `organisation.organisation`
// passthrough would fail loudly here.

test('trust read: RESOLVED — response is redacted (no history, no provenance, no legalEntities, no per-signal raw detail)', async () => {
  const fullOrganisation = {
    id: 'ORG-REAL0000001',
    displayName: 'Real Firm Ltd',
    domains: [{ domain: 'example.com', role: 'primary' }],
    identifiers: [{ scheme: 'companies-house', value: '12345678' }],
    legalEntities: [{ name: 'Real Firm Ltd', number: '12345678' }],
    regulators: [{ name: 'FCA' }],
    classification: [{ code: 'A' }],
    people: [{ name: 'A Director' }],
    history: [{ event: 'incorporated', at: '2020-01-01' }],
    provenance: [{ section: 'digitalTrust', source: 'soterius-observatory', confidence: 'verified' }],
    metadata: { sourcesConsulted: ['soterius-observatory'], sourcesUnavailable: [] },
    lifecycle: { status: 'active' },
    digitalTrust: {
      overallScore: 82,
      grade: 'B',
      signalsObserved: 9,
      signalsTotal: 10,
      categories: [
        { category: 'A', averageScore: 90, signals: [{ key: 'spf', score: 90, label: 'SPF', collectedAt: '2026-07-01T00:00:00Z' }] },
        // averageScore 55 deliberately sits in the band that changed grade
        // under ADR-SYS-011 §7's presentation convergence: letterGrade now
        // derives from the same 90/75/60/40 cutoffs getRiskBand uses
        // (previously an independent 90/75/55/35 ladder graded 55 as 'C';
        // the canonical table grades it 'D', consistent with getRiskBand
        // classifying 55 as "High Risk", not "Moderate Risk").
        { category: 'B', averageScore: 55, signals: [{ key: 'caa', score: 55, label: 'CAA', collectedAt: '2026-07-01T00:00:00Z' }] },
      ],
    },
  };
  const handler = createGetTrustHandler({
    resolveOrganisationByDomainFn: () => ({ outcome: 'RESOLVED', organisationId: 'ORG-REAL0000001' }),
    assembleByIdFn: async () => ({ ok: true, organisation: fullOrganisation }),
    assembleFromDiscoveryFn: async () => { throw new Error('should not be called'); },
  });
  const req = { query: { domain: 'example.com' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  const org = res.body.organisation;
  // Kept — headline score, band, small fixed per-category grade.
  assert.strictEqual(org.id, 'ORG-REAL0000001');
  assert.strictEqual(org.domain, 'example.com');
  assert.strictEqual(org.displayName, 'Real Firm Ltd');
  assert.strictEqual(org.digitalTrust.overallScore, 82);
  assert.strictEqual(org.digitalTrust.grade, 'B');
  assert.deepStrictEqual(org.digitalTrust.categories, [{ category: 'A', grade: 'A' }, { category: 'B', grade: 'D' }]);
  // Redacted — never present in the public response at all.
  assert.strictEqual(org.history, undefined);
  assert.strictEqual(org.provenance, undefined);
  assert.strictEqual(org.legalEntities, undefined);
  assert.strictEqual(org.identifiers, undefined);
  assert.strictEqual(org.regulators, undefined);
  assert.strictEqual(org.people, undefined);
  assert.strictEqual(org.metadata, undefined);
  assert.strictEqual(org.digitalTrust.categories[0].signals, undefined);
  assert.strictEqual(org.digitalTrust.categories[0].averageScore, undefined);
});

test('trust read: RESOLVED with no digitalTrust yet — redacted response carries null, not fabricated', async () => {
  const handler = createGetTrustHandler({
    resolveOrganisationByDomainFn: () => ({ outcome: 'RESOLVED', organisationId: 'ORG-REAL0000002' }),
    assembleByIdFn: async () => ({ ok: true, organisation: { id: 'ORG-REAL0000002', displayName: 'No Trust Yet', domains: [{ domain: 'notyet.example.com' }], digitalTrust: null } }),
    assembleFromDiscoveryFn: async () => { throw new Error('should not be called'); },
  });
  const req = { query: { domain: 'notyet.example.com' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.body.organisation.digitalTrust, null);
});

test('trust read: NOT_FOUND — calls assembleFromDiscovery with a deterministic ephemeral id, never assembleById', async () => {
  let assembleByIdCalled = false;
  let discoveryArgs = null;
  const handler = createGetTrustHandler({
    resolveOrganisationByDomainFn: () => ({ outcome: 'NOT_FOUND', organisationId: null }),
    assembleByIdFn: async () => { assembleByIdCalled = true; return { ok: true, organisation: {} }; },
    assembleFromDiscoveryFn: async (input, id) => { discoveryArgs = { input, id }; return { ok: true, organisation: { id, digitalTrust: null } }; },
  });
  const req = { query: { domain: 'never-seen-before.example.com' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(assembleByIdCalled, false);
  assert.strictEqual(discoveryArgs.input.domain, 'never-seen-before.example.com');
  assert.match(discoveryArgs.id, /^ORG-[0-9A-F]{12}$/);
  assert.strictEqual(res.body.resolutionOutcome, 'NOT_FOUND');

  // Calling again for the same domain must produce the SAME ephemeral id —
  // deterministic, not random, so polling/re-reading the same domain is stable.
  discoveryArgs = null;
  const req2 = { query: { domain: 'never-seen-before.example.com' } };
  const res2 = fakeRes();
  await handler(req2, res2, () => assert.fail('next() should not be called'));
  assert.strictEqual(discoveryArgs.id, res.body.organisation.id);
});

test('trust read: AMBIGUOUS — 200 (an honest resolution outcome, not an HTTP error) with candidates disclosed, no assembler ever called (never silently picks one)', async () => {
  let assembleByIdCalled = false;
  let discoveryCalled = false;
  const handler = createGetTrustHandler({
    resolveOrganisationByDomainFn: () => ({ outcome: 'AMBIGUOUS', organisationId: null, candidates: ['ORG-AAA000000001', 'ORG-BBB000000002'] }),
    assembleByIdFn: async () => { assembleByIdCalled = true; return { ok: true, organisation: {} }; },
    assembleFromDiscoveryFn: async () => { discoveryCalled = true; return { ok: true, organisation: {} }; },
  });
  const req = { query: { domain: 'contested.example.com' } };
  const res = fakeRes();
  await handler(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, null); // res.json() without .status() — Express default 200
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.resolutionOutcome, 'AMBIGUOUS');
  assert.deepStrictEqual(res.body.candidates, ['ORG-AAA000000001', 'ORG-BBB000000002']);
  assert.strictEqual(assembleByIdCalled, false);
  assert.strictEqual(discoveryCalled, false);
});
