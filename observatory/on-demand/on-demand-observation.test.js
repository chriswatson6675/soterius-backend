'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runOnDemandObservation, RESILIENT_SESSION_SIGNALS } = require('./on-demand-observation');

const ADAPTERS = Object.fromEntries(
  RESILIENT_SESSION_SIGNALS.map((s) => [s, { tableName: `signal_facts_${s}`, key: s }]),
);

function fakeSessionModule() {
  const calls = [];
  let idCounter = 0;
  return {
    calls,
    createSession: async (input) => {
      calls.push(['createSession', input]);
      return { ok: true, session: { id: `session-${++idCounter}`, ...input } };
    },
    transitionSession: async (id, status, opts) => {
      calls.push(['transition', id, status, opts]);
      return { ok: true, session: { id, status } };
    },
  };
}

// A collection stub that succeeds for every signal by default, producing a
// distinct collection_runs id per call so read-back queries can be asserted.
function makeRunCollection({ failFor = new Set(), throwFor = new Set() } = {}) {
  let counter = 0;
  return async (input) => {
    if (throwFor.has(input.adapter.key)) throw new Error(`collector exploded (${input.adapter.key})`);
    const runId = `run-${input.adapter.key}-${++counter}`;
    if (failFor.has(input.adapter.key)) {
      return {
        run: { id: runId },
        observations: [{ domain: input.domains[0], error: 'collection failed' }],
        summary: { state: 'FAILED' },
      };
    }
    return {
      run: { id: runId },
      observations: [{ domain: input.domains[0], id: `obs-${runId}` }],
      summary: { state: 'COMPLETED' },
    };
  };
}

function makeRunTlsCertificate({ tlsFails = false, certFails = false, throws = false } = {}) {
  return async (input) => {
    if (throws) throw new Error('tls handshake exploded');
    return {
      tls: { run: { id: 'run-tls-1' } },
      certificate: { run: { id: 'run-certificate-1' } },
      counts: { total: 1 },
      results: [{
        domain: input.domains[0],
        tlsError: tlsFails ? 'handshake timeout' : null,
        certError: certFails ? 'cert parse error' : null,
      }],
    };
  };
}

function makeReadPersistedFacts() {
  return async ({ tableName, domain, collectionRunId }) => ({
    data: { domain, collection_run_id: collectionRunId, dns_caa_present: false, collected_at: '2026-07-12T00:00:00.000Z' },
    error: null,
  });
}

function makePersistQuality({ unscoredFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (input) => {
      calls.push(input);
      if (unscoredFor.has(input.signal)) {
        return { ok: true, persisted: false, result: { scored: false, reason: 'OBSERVATION_INCOMPLETE' } };
      }
      return { ok: true, persisted: true, result: { scored: true, score: 90 } };
    },
  };
}

function baseDeps(overrides = {}) {
  const session = fakeSessionModule();
  const persist = makePersistQuality();
  return {
    resolveOrganisation: () => ({ outcome: 'RESOLVED', organisationId: 'ORG-ABC123', provenance: {} }),
    createSession: session.createSession,
    transitionSession: session.transitionSession,
    runCollection: makeRunCollection(),
    runTlsCertificate: makeRunTlsCertificate(),
    persistQuality: persist.fn,
    collectCaaAncestors: async (domain, facts) => new Map([[domain, facts]]),
    readPersistedFacts: makeReadPersistedFacts(),
    adapters: ADAPTERS,
    client: {},
    now: () => '2026-07-12T00:00:00.000Z',
    _session: session,
    _persist: persist,
    ...overrides,
  };
}

// ── Happy path ───────────────────────────────────────────────────────────────

test('RESOLVED domain — all 10 signals observed and scored, session completes', async () => {
  const deps = baseDeps();

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.organisationId, 'ORG-ABC123');
  assert.strictEqual(r.resolutionOutcome, 'RESOLVED');
  assert.strictEqual(r.signals.length, 10, 'spf,dmarc,dnssec,mtasts,dkim,securityheaders,securitytxt,caa,tls,certificate');
  assert.ok(r.signals.every((s) => s.observed && s.scored));

  const [, createdInput] = deps._session.calls.find((c) => c[0] === 'createSession');
  assert.strictEqual(createdInput.trigger, 'on-demand');
  assert.strictEqual(createdInput.status, 'running');

  const transitionCall = deps._session.calls.find((c) => c[0] === 'transition');
  assert.strictEqual(transitionCall[2], 'completed');
  assert.strictEqual(transitionCall[3].metadata.signalsObserved, 10);
  assert.strictEqual(transitionCall[3].metadata.signalsScored, 10);
});

// ── Observation is universal: unresolved domains are still fully observed. ──

test('NOT_FOUND domain — pipeline still observes and scores every signal; organisationId stays null', async () => {
  const deps = baseDeps({
    resolveOrganisation: () => ({ outcome: 'NOT_FOUND', organisationId: null, provenance: { reason: 'NO_VERIFIED_DOMAIN_CLAIM' } }),
  });

  const r = await runOnDemandObservation('unknown-domain.com', deps);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.organisationId, null);
  assert.strictEqual(r.resolutionOutcome, 'NOT_FOUND');
  assert.strictEqual(r.signals.length, 10);
  assert.ok(r.signals.every((s) => s.observed && s.scored), 'NOT_FOUND must not block observation or scoring');
});

test('AMBIGUOUS domain — same universal-observation guarantee as NOT_FOUND', async () => {
  const deps = baseDeps({
    resolveOrganisation: () => ({ outcome: 'AMBIGUOUS', organisationId: null, candidates: ['ORG-A', 'ORG-B'], provenance: {} }),
  });

  const r = await runOnDemandObservation('contested-domain.com', deps);

  assert.strictEqual(r.organisationId, null);
  assert.strictEqual(r.resolutionOutcome, 'AMBIGUOUS');
  assert.ok(r.signals.every((s) => s.observed && s.scored));
});

test('a resolver that throws is treated as NOT_FOUND, not a pipeline failure', async () => {
  const deps = baseDeps({
    resolveOrganisation: () => { throw new Error('authority dataset unreadable'); },
  });

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.organisationId, null);
  assert.strictEqual(r.resolutionOutcome, 'NOT_FOUND');
});

// ── Per-signal failure isolation ────────────────────────────────────────────

test('one signal collector throwing does not abort the other nine', async () => {
  const deps = baseDeps({ runCollection: makeRunCollection({ throwFor: new Set(['dnssec']) }) });

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
  const dnssec = r.signals.find((s) => s.signal === 'dnssec');
  assert.strictEqual(dnssec.observed, false);
  assert.match(dnssec.error, /collector exploded/);
  const others = r.signals.filter((s) => s.signal !== 'dnssec');
  assert.strictEqual(others.length, 9);
  assert.ok(others.every((s) => s.observed && s.scored));
});

test('a signal whose collection reports an observation error is recorded, not thrown', async () => {
  const deps = baseDeps({ runCollection: makeRunCollection({ failFor: new Set(['mtasts']) }) });

  const r = await runOnDemandObservation('example.com', deps);

  const mtasts = r.signals.find((s) => s.signal === 'mtasts');
  assert.strictEqual(mtasts.observed, false);
  assert.strictEqual(mtasts.error, 'collection failed');
  assert.strictEqual(mtasts.collectionState, 'FAILED');
});

test('a read-back failure is recorded as observed but not scored', async () => {
  const deps = baseDeps({
    readPersistedFacts: async () => ({ data: null, error: { message: 'row vanished' } }),
  });

  const r = await runOnDemandObservation('example.com', deps);

  assert.ok(r.signals.every((s) => s.observed === true && s.scored === false));
  assert.ok(r.signals.every((s) => /row vanished/.test(s.error)));
});

test('an unscored (Unknown ≠ Absent) signal is recorded with its reason, not treated as a failure', async () => {
  const persist = makePersistQuality({ unscoredFor: new Set(['dkim']) });
  const deps = baseDeps({ persistQuality: persist.fn });

  const r = await runOnDemandObservation('example.com', deps);

  const dkim = r.signals.find((s) => s.signal === 'dkim');
  assert.strictEqual(dkim.observed, true);
  assert.strictEqual(dkim.scored, false);
  assert.strictEqual(dkim.reason, 'OBSERVATION_INCOMPLETE');
});

// ── CAA — ancestor lookup is invoked with the read-back facts. ──────────────

test('caa — collectCaaAncestors is called with the domain and its read-back facts', async () => {
  let calledWith = null;
  const deps = baseDeps({
    collectCaaAncestors: async (domain, facts) => { calledWith = { domain, facts }; return new Map([[domain, facts]]); },
  });

  await runOnDemandObservation('example.com', deps);

  assert.strictEqual(calledWith.domain, 'example.com');
  assert.strictEqual(calledWith.facts.domain, 'example.com');
});

// ── TLS + Certificate — one shared step, independent per-target failure. ───

test('tls + certificate — both succeed independently under the shared handshake step', async () => {
  const deps = baseDeps();
  const r = await runOnDemandObservation('example.com', deps);

  const tls = r.signals.find((s) => s.signal === 'tls');
  const cert = r.signals.find((s) => s.signal === 'certificate');
  assert.ok(tls.observed && tls.scored);
  assert.ok(cert.observed && cert.scored);
});

test('tls + certificate — a tls-only handshake failure does not block certificate scoring', async () => {
  const deps = baseDeps({ runTlsCertificate: makeRunTlsCertificate({ tlsFails: true }) });

  const r = await runOnDemandObservation('example.com', deps);

  const tls = r.signals.find((s) => s.signal === 'tls');
  const cert = r.signals.find((s) => s.signal === 'certificate');
  assert.strictEqual(tls.observed, false);
  assert.strictEqual(tls.error, 'handshake timeout');
  assert.ok(cert.observed && cert.scored, 'certificate is read from its own run and is unaffected by a tls-only error');
});

test('tls + certificate — a thrown handshake failure records both signals as unobserved, does not abort other signals', async () => {
  const deps = baseDeps({ runTlsCertificate: makeRunTlsCertificate({ throws: true }) });

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.signals.find((s) => s.signal === 'tls').observed, false);
  assert.strictEqual(r.signals.find((s) => s.signal === 'certificate').observed, false);
  assert.strictEqual(r.signals.find((s) => s.signal === 'spf').observed, true);
});

// ── onSessionCreated — the early-return hook the route handler relies on ────

test('onSessionCreated fires as soon as the session exists, before collection completes', async () => {
  let hookSession = null;
  let hookFiredBeforeCompletion = false;
  const deps = baseDeps();
  deps.onSessionCreated = (session) => {
    hookSession = session;
    hookFiredBeforeCompletion = true;
  };

  const r = await runOnDemandObservation('example.com', deps);

  assert.ok(hookFiredBeforeCompletion);
  assert.strictEqual(hookSession.id, r.sessionId);
});

test('onSessionCreated is never called when session creation itself fails', async () => {
  let called = false;
  const deps = baseDeps({ createSession: async () => ({ ok: false, error: 'db unreachable' }) });
  deps.onSessionCreated = () => { called = true; };

  await runOnDemandObservation('example.com', deps);

  assert.strictEqual(called, false);
});

test('a throwing onSessionCreated hook never breaks the pipeline', async () => {
  const deps = baseDeps();
  deps.onSessionCreated = () => { throw new Error('caller bug'); };

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.signals.length, 10);
});

test('omitting onSessionCreated behaves exactly as before (no hook is required)', async () => {
  const deps = baseDeps();
  delete deps.onSessionCreated;

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, true);
});

// ── Session lifecycle ────────────────────────────────────────────────────────

test('session creation failure short-circuits before any collection is attempted', async () => {
  let collectionCalled = false;
  const deps = baseDeps({
    createSession: async () => ({ ok: false, error: 'db unreachable' }),
    runCollection: async () => { collectionCalled = true; return {}; },
  });

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /session creation failed/);
  assert.strictEqual(collectionCalled, false);
});

test('a systemic exception transitions the session to failed and is surfaced, not swallowed', async () => {
  const deps = baseDeps({
    adapters: null, // forces a TypeError inside runOneSignal (adapters[signal] on null)
  });

  const r = await runOnDemandObservation('example.com', deps);

  assert.strictEqual(r.ok, false);
  assert.ok(r.sessionId);
  const transitionCall = deps._session.calls.find((c) => c[0] === 'transition');
  assert.strictEqual(transitionCall[2], 'failed');
});
