'use strict';

// companieshouse-collector.test.js — CCS-COMPHOUSE-001 Part 8 validation suite.
//
// Every test uses an injected fake client; no live HTTP and no database.
// The suite is organised by the five CCS §8 validation dimensions:
//   8.1 Completeness   — every in-scope object is observed / observed-absent / non-observation
//   8.2 Reproducibility — deterministic hashing + deterministic pagination
//   8.3 Provenance     — every emission & non-observation carries its envelope
//   8.4 Object integrity — EO-06 byte-for-byte; single moment; append-only (idempotency)
//   8.5 Observation integrity — absence≠non-observation; no-traverse; no list wrapper
//
// Usage: node --test backend/signal-lab/sources/companies-house/companieshouse-collector.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const collector = require('./companieshouse-collector');
const prov = require('./provenance');
const { COVERAGE_STATUS, NON_OBSERVATION_REASON } = collector;

const N = '12345678';
const MOMENT = '2026-06-27T12:00:00.000Z';

// ── Fake client ─────────────────────────────────────────────────────────────────

const J  = (body, etag = 'etag-default') => ({ errorType: 'NONE', httpStatus: 200, requestUri: '', etag, body, headers: {} });
const NF = () => ({ errorType: 'NOT_FOUND', httpStatus: 404, requestUri: '', etag: null, body: null, headers: {} });
const ERR = (s = 500) => ({ errorType: 'HTTP_ERROR', httpStatus: s, requestUri: '', etag: null, body: null, headers: {} });
const RL = () => ({ errorType: 'RATE_LIMITED', httpStatus: 429, requestUri: '', etag: null, body: null, headers: {} });
const B = (buf, ct = 'application/pdf') => ({ errorType: 'NONE', httpStatus: 200, requestUri: '', contentType: ct, bytes: buf, headers: {} });
const BERR = () => ({ errorType: 'HTTP_ERROR', httpStatus: 500, requestUri: '', contentType: null, bytes: null, headers: {} });

function genOfficers(count, startIdx) {
  return Array.from({ length: count }, (_, i) => {
    const k = startIdx + i;
    return {
      name: `Officer ${k}`,
      officer_role: 'director',
      etag: `e-appt-${k}`,
      links: { self: `/company/${N}/appointments/APPT${k}`, officer: { appointments: `/officers/OFF${k}/appointments` } },
    };
  });
}

function defaultRoutes() {
  return {
    [`/company/${N}`]: () => J({ company_number: N, company_name: 'ACME LTD', type: 'ltd', registered_office_address: { locality: 'London' } }, 'etag-profile'),
    [`/company/${N}/registered-office-address`]: () => J({ locality: 'London', postal_code: 'EC1A 1BB' }, 'etag-roa'),
    [`/company/${N}/registers`]: () => NF(),     // absent attribute
    [`/company/${N}/exemptions`]: () => NF(),    // absent attribute
    [`/company/${N}/officers`]: (url) => {
      const si = Number(new URL(url).searchParams.get('start_index')) || 0;
      if (si === 0) return J({ total_results: 2, items: genOfficers(2, 0) }, 'etag-officers');
      return J({ total_results: 2, items: [] });
    },
    [`/company/${N}/persons-with-significant-control`]: () => NF(),                    // observed absence (404)
    [`/company/${N}/persons-with-significant-control-statements`]: () => J({ total_results: 0, items: [] }), // observed absence (empty)
    [`/company/${N}/filing-history`]: () => J({
      total_count: 1,
      items: [{ transaction_id: 'TX1', type: 'AA', category: 'accounts',
        links: { document_metadata: 'https://document-api.company-information.service.gov.uk/document/DOC1' } }],
    }, 'etag-filing'),
    [`/company/${N}/charges`]: () => J({ total_count: 0, items: [] }),                 // observed absence (empty)
    [`/company/${N}/insolvency`]: () => NF(),                                          // observed absence (404)
    [`/company/${N}/uk-establishments`]: () => J({ total_results: 0, items: [] }),     // observed absence (empty)
  };
}

function makeClient(routes, binaryRoutes = {}) {
  const calls = [];
  const defaultBinary = {
    '/document/DOC1/content': () => B(Buffer.from('%PDF-1.4 fake pdf bytes')),
  };
  const bin = { ...defaultBinary, ...binaryRoutes };
  const json = {
    '/document/DOC1': () => J({ links: { document: 'https://document-api.company-information.service.gov.uk/document/DOC1/content' }, resources: { 'application/pdf': {} } }, 'etag-doc'),
    ...routes,
  };
  return {
    calls,
    async getJson(url) {
      calls.push({ type: 'json', url });
      const path = new URL(url).pathname;
      const h = json[path];
      return h ? h(url) : NF();
    },
    async getBinary(url) {
      calls.push({ type: 'bin', url });
      const path = new URL(url).pathname;
      const h = bin[path];
      return h ? h(url) : BERR();
    },
  };
}

function run(routes, opts = {}) {
  const client = makeClient(routes ?? defaultRoutes(), opts.binaryRoutes);
  const request = {
    anchor: { type: 'company', value: N },
    scope: { objects: ['EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-07', 'EO-08', 'EO-09'], includeDocuments: true },
    mode: 'targeted-snapshot',
  };
  return collector.observe(request, { apiKey: 'k', client, now: () => MOMENT, priorState: opts.priorState })
    .then((res) => ({ res, client }));
}

// ── 8.1 Completeness ─────────────────────────────────────────────────────────────

describe('8.1 Completeness — every in-scope object accounted for', () => {
  test('coverage classifies each object as observed / observed-absent / non-observation', async () => {
    const { res } = await run();
    const c = res.coverage.perObject;
    assert.equal(res.coverage.anchorObserved, true);
    assert.equal(c['EO-01'].status, COVERAGE_STATUS.OBSERVED);
    assert.equal(c['EO-02'].status, COVERAGE_STATUS.OBSERVED);   // 2 officers
    assert.equal(c['EO-02'].count, 2);
    assert.equal(c['EO-03'].status, COVERAGE_STATUS.OBSERVED_ABSENCE); // 404
    assert.equal(c['EO-04'].status, COVERAGE_STATUS.OBSERVED_ABSENCE); // empty
    assert.equal(c['EO-05'].status, COVERAGE_STATUS.OBSERVED);   // 1 filing
    assert.equal(c['EO-07'].status, COVERAGE_STATUS.OBSERVED_ABSENCE); // empty charges
    assert.equal(c['EO-08'].status, COVERAGE_STATUS.OBSERVED_ABSENCE); // 404 insolvency
    assert.equal(c['EO-09'].status, COVERAGE_STATUS.OBSERVED_ABSENCE); // empty establishments
    assert.equal(c['EO-06'].status, COVERAGE_STATUS.OBSERVED);   // one document retrieved
    // No in-scope object is unaccounted for.
    for (const eo of ['EO-01','EO-02','EO-03','EO-04','EO-05','EO-06','EO-07','EO-08','EO-09']) {
      assert.ok(c[eo], `missing coverage for ${eo}`);
    }
  });

  test('list coverage reconciles against the register total', async () => {
    const routes = defaultRoutes();
    routes[`/company/${N}/officers`] = (url) => {
      const si = Number(new URL(url).searchParams.get('start_index')) || 0;
      if (si === 0) return J({ total_results: 150, items: genOfficers(100, 0) }, 'e');
      if (si === 100) return J({ total_results: 150, items: genOfficers(50, 100) }, 'e');
      return J({ total_results: 150, items: [] });
    };
    const { res } = await run(routes);
    assert.equal(res.coverage.perObject['EO-02'].count, 150);
    assert.equal(res.coverage.perObject['EO-02'].declaredTotal, 150);
    assert.equal(res.coverage.perObject['EO-02'].complete, true);
  });

  test('anchor non-observation stops coverage (no anchor → no context)', async () => {
    const routes = defaultRoutes();
    routes[`/company/${N}`] = () => ERR(500);
    const { res } = await run(routes);
    assert.equal(res.coverage.anchorObserved, false);
    assert.equal(res.coverage.perObject['EO-01'].status, COVERAGE_STATUS.NON_OBSERVATION);
    assert.equal(res.emitted.length, 0);
    assert.equal(res.nonObservations.length, 1);
    assert.equal(res.nonObservations[0].objectType, 'EO-01');
  });
});

// ── 8.2 Reproducibility ──────────────────────────────────────────────────────────

describe('8.2 Reproducibility — deterministic hashing & pagination', () => {
  test('content hash is independent of JSON key order', () => {
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { a: 2, nested: { x: 2, y: 1 }, b: 1 };
    assert.equal(prov.contentHash(a), prov.contentHash(b));
  });

  test('pagination issues deterministic start_index sequence', async () => {
    const routes = defaultRoutes();
    routes[`/company/${N}/officers`] = (url) => {
      const si = Number(new URL(url).searchParams.get('start_index')) || 0;
      if (si === 0) return J({ total_results: 150, items: genOfficers(100, 0) });
      if (si === 100) return J({ total_results: 150, items: genOfficers(50, 100) });
      return J({ total_results: 150, items: [] });
    };
    const { client } = await run(routes);
    const officerCalls = client.calls.filter(c => c.url.includes('/officers')).map(c => new URL(c.url).searchParams.get('start_index'));
    assert.deepEqual(officerCalls, ['0', '100']);
  });

  test('re-running on the same fixture reproduces identical emitted content hashes', async () => {
    const { res: r1 } = await run();
    const { res: r2 } = await run();
    const h1 = r1.emitted.map(e => e.observationIdentity.contentHash).sort();
    const h2 = r2.emitted.map(e => e.observationIdentity.contentHash).sort();
    assert.deepEqual(h1, h2);
  });
});

// ── 8.3 Provenance ───────────────────────────────────────────────────────────────

describe('8.3 Provenance — envelopes present on every emission and non-observation', () => {
  test('every emitted object carries a complete provenance envelope', async () => {
    const { res } = await run();
    assert.ok(res.emitted.length > 0);
    for (const e of res.emitted) {
      assert.ok(prov.isCompleteProvenance(e.provenance), `incomplete provenance on ${e.objectType}`);
      assert.equal(e.provenance.observationTimestamp, MOMENT);
      assert.ok(Array.isArray(e.provenance.requestUris) && e.provenance.requestUris.length > 0);
      assert.ok(e.provenance.contentHash.startsWith('sha256:'));
    }
  });

  test('every non-observation carries attempt provenance', async () => {
    const routes = defaultRoutes();
    routes[`/company/${N}/charges`] = () => ERR(503);
    const { res } = await run(routes);
    const charge = res.nonObservations.find(x => x.objectType === 'EO-07');
    assert.ok(charge);
    assert.equal(charge.reason, NON_OBSERVATION_REASON.UNAVAILABLE);
    assert.ok(charge.attemptProvenance.observationTimestamp);
    assert.ok(charge.attemptProvenance.requestUris.length > 0);
    assert.equal(charge.attemptProvenance.httpStatus, 503);
  });

  test('EO-01 provenance lists all assembled resource URIs (multi-resource moment)', async () => {
    const { res } = await run();
    const eo01 = res.emitted.find(e => e.objectType === 'EO-01');
    // profile + registered-office + registers + exemptions = 4 request URIs
    assert.equal(eo01.provenance.requestUris.length, 4);
    assert.equal(eo01.provenance.etag, 'etag-profile');
  });
});

// ── 8.4 Object integrity (EO-06 byte-for-byte; append-only idempotency) ──────────

describe('8.4 Object integrity', () => {
  test('EO-06 binary is preserved byte-for-byte and hash matches the bytes', async () => {
    const pdf = Buffer.from('%PDF-1.4 the real bytes \x00\x01\x02');
    const { res } = await run(defaultRoutes(), {
      binaryRoutes: { '/document/DOC1/content': () => B(pdf, 'application/pdf') },
    });
    const eo06 = res.emitted.find(e => e.objectType === 'EO-06');
    assert.ok(eo06, 'EO-06 not emitted');
    assert.equal(eo06.representation.byteLength, pdf.length);
    assert.equal(eo06.provenance.representationObserved, 'application/pdf');
    const roundTrip = Buffer.from(eo06.representation.bytesBase64, 'base64');
    assert.ok(roundTrip.equals(pdf), 'byte-for-byte round trip failed');
    const expected = 'sha256:' + crypto.createHash('sha256').update(pdf).digest('hex');
    assert.equal(eo06.observationIdentity.contentHash, expected);
  });

  test('each emission carries a single observation moment', async () => {
    const { res } = await run();
    for (const e of res.emitted) assert.equal(e.observationIdentity.observationTimestamp, MOMENT);
  });

  test('idempotency — immutable emit-once, mutable emit-on-change, unchanged emits nothing', async () => {
    const { res: first } = await run();
    // Build prior state from the first emission (what a store would have preserved).
    const priorState = {};
    for (const e of first.emitted) {
      priorState[collector._idemKey(e.objectType, e.objectIdentity)] = {
        contentHash: e.observationIdentity.contentHash, etag: e.provenance.etag,
      };
    }
    const { res: second } = await run(defaultRoutes(), { priorState });
    assert.equal(second.emitted.length, 0, 'unchanged re-observation must emit nothing new');

    // Now change the mutable profile → it must re-emit; immutable EO-05 must not.
    const routes = defaultRoutes();
    routes[`/company/${N}`] = () => J({ company_number: N, company_name: 'ACME RENAMED LTD', type: 'ltd', registered_office_address: { locality: 'London' } }, 'etag-profile-2');
    const { res: third } = await run(routes, { priorState });
    const types = third.emitted.map(e => e.objectType);
    assert.ok(types.includes('EO-01'), 'changed mutable EO-01 must re-emit');
    assert.ok(!types.includes('EO-05'), 'immutable EO-05 must not re-emit (capture-once)');
  });
});

// ── 8.5 Observation integrity ────────────────────────────────────────────────────

describe('8.5 Observation integrity', () => {
  test('empty successful list is observed-absence, NOT non-observation', async () => {
    const { res } = await run();
    // charges empty + insolvency 404 → observed absence; none of these are non-observations
    const absenceTypes = res.observedAbsences.map(a => a.objectType);
    assert.ok(absenceTypes.includes('EO-07'));
    assert.ok(absenceTypes.includes('EO-08'));
    assert.equal(res.nonObservations.length, 0, 'absence must not be recorded as non-observation');
  });

  test('surface error that could-not-be-consulted is a non-observation, kept apart from absence', async () => {
    const routes = defaultRoutes();
    routes[`/company/${N}/charges`] = () => RL(); // rate limited → could not consult
    const { res } = await run(routes);
    const charge = res.nonObservations.find(x => x.objectType === 'EO-07');
    assert.ok(charge);
    assert.equal(charge.reason, NON_OBSERVATION_REASON.RATE_LIMITED);
    assert.ok(!res.observedAbsences.some(a => a.objectType === 'EO-07'));
  });

  test('cross-entity link is recorded but NOT traversed', async () => {
    const { res, client } = await run();
    assert.ok(res.crossLinks.some(x => x.link.type === 'officer_id' && x.link.value === 'OFF0'));
    // The collector must never fetch the officer appointments endpoint.
    assert.ok(!client.calls.some(c => c.url.includes('/officers/OFF0/appointments')),
      'collector must not traverse officer_id');
  });

  test('emitted list items are the object representation, NOT the list wrapper', async () => {
    const { res } = await run();
    const officer = res.emitted.find(e => e.objectType === 'EO-02');
    assert.ok(officer);
    assert.equal(officer.representation.name, 'Officer 0');
    assert.ok(!('items' in officer.representation), 'list wrapper leaked into emission');
    assert.ok(!('total_results' in officer.representation), 'list total leaked into emission');
  });

  test('EO-06 document failure is a non-observation; parent EO-05 stays observed', async () => {
    const { res } = await run(defaultRoutes(), {
      binaryRoutes: { '/document/DOC1/content': () => BERR() },
    });
    assert.equal(res.coverage.perObject['EO-05'].status, COVERAGE_STATUS.OBSERVED);
    assert.ok(res.emitted.some(e => e.objectType === 'EO-05'), 'EO-05 must remain emitted');
    assert.ok(res.nonObservations.some(x => x.objectType === 'EO-06' && x.reason === NON_OBSERVATION_REASON.DOCUMENT_UNAVAILABLE));
    assert.ok(!res.emitted.some(e => e.objectType === 'EO-06'), 'failed EO-06 must not be emitted');
  });
});

// ── Request validation (programming errors, not observation outcomes) ────────────

describe('Request validation', () => {
  test('rejects an unimplemented mode rather than faking coverage', async () => {
    await assert.rejects(
      () => collector.observe({ anchor: { type: 'company', value: N }, mode: 'streaming' }, { apiKey: 'k', client: makeClient(defaultRoutes()) }),
      /not implemented/,
    );
  });

  test('rejects a request with no anchor', async () => {
    await assert.rejects(
      () => collector.observe({ scope: {} }, { apiKey: 'k', client: makeClient(defaultRoutes()) }),
      /requires an anchor/,
    );
  });

  test('disqualification anchor: 404 is observed-absence', async () => {
    const client = makeClient({}); // all PDA paths 404 by default
    const res = await collector.observe(
      { anchor: { type: 'disqualified-officer', value: 'OFF1', officerType: 'natural' } },
      { apiKey: 'k', client, now: () => MOMENT },
    );
    assert.equal(res.coverage.perObject['EO-10'].status, COVERAGE_STATUS.OBSERVED_ABSENCE);
  });
});
