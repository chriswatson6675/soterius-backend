'use strict';

// Sprint 3 (ADR-SYS-009 programme) — shared DNS collection layer.
// Proves the layer truthfully distinguishes the six outcomes SLG-141 / the
// sprint brief require, using an injected resolver (no real network).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  queryTxt, presence, aggregatePresence, OUTCOME, QUERY,
} = require('./dns-collect');

// Resolver stubs: resolve with records, or reject with a coded resolver error.
const resolves = (raw) => async () => raw;
const rejectsWith = (code) => async () => { const e = new Error(code || 'err'); if (code) e.code = code; throw e; };

describe('queryTxt — maps resolver behaviour onto query outcomes', () => {
  test('records present → RESOLVED, chunks joined', async () => {
    const r = await queryTxt('x', resolves([['v=spf1 ', '-all']]));
    assert.equal(r.outcome, QUERY.RESOLVED);
    assert.deepEqual(r.records, ['v=spf1 -all']);
    assert.equal(r.errorCode, null);
  });

  test('empty answer (no throw) → NO_RECORDS (authoritative absence)', async () => {
    const r = await queryTxt('x', resolves([]));
    assert.equal(r.outcome, QUERY.NO_RECORDS);
    assert.deepEqual(r.records, []);
  });

  test('ENOTFOUND (NXDOMAIN) → NO_RECORDS', async () => {
    const r = await queryTxt('x', rejectsWith('ENOTFOUND'));
    assert.equal(r.outcome, QUERY.NO_RECORDS);
    assert.equal(r.errorCode, 'ENOTFOUND');
  });

  test('ENODATA → NO_RECORDS', async () => {
    const r = await queryTxt('x', rejectsWith('ENODATA'));
    assert.equal(r.outcome, QUERY.NO_RECORDS);
  });

  test('ETIMEOUT → NOT_OBSERVED', async () => {
    const r = await queryTxt('x', rejectsWith('ETIMEOUT'));
    assert.equal(r.outcome, QUERY.NOT_OBSERVED);
    assert.equal(r.errorCode, 'ETIMEOUT');
  });

  test('ETIMEDOUT → NOT_OBSERVED', async () => {
    const r = await queryTxt('x', rejectsWith('ETIMEDOUT'));
    assert.equal(r.outcome, QUERY.NOT_OBSERVED);
  });

  test('ESERVFAIL (resolver failure) → COLLECTION_ERROR', async () => {
    const r = await queryTxt('x', rejectsWith('ESERVFAIL'));
    assert.equal(r.outcome, QUERY.COLLECTION_ERROR);
    assert.equal(r.errorCode, 'ESERVFAIL');
  });

  test('EREFUSED → COLLECTION_ERROR', async () => {
    const r = await queryTxt('x', rejectsWith('EREFUSED'));
    assert.equal(r.outcome, QUERY.COLLECTION_ERROR);
  });

  test('unexpected exception with no code → COLLECTION_ERROR (code UNKNOWN)', async () => {
    const r = await queryTxt('x', async () => { throw new Error('boom'); });
    assert.equal(r.outcome, QUERY.COLLECTION_ERROR);
    assert.equal(r.errorCode, 'UNKNOWN');
  });
});

describe('presence — record-match judgement, only on a completed observation', () => {
  const isSpf = r => r.toLowerCase().startsWith('v=spf1');

  test('RESOLVED + match → OBSERVED_PRESENT', async () => {
    const q = await queryTxt('x', resolves([['v=spf1 -all']]));
    const p = presence(q, isSpf);
    assert.equal(p.outcome, OUTCOME.OBSERVED_PRESENT);
    assert.deepEqual(p.matched, ['v=spf1 -all']);
  });

  test('RESOLVED but no match → OBSERVED_ABSENT (a real answer, just no SPF)', async () => {
    const q = await queryTxt('x', resolves([['google-site-verification=abc']]));
    assert.equal(presence(q, isSpf).outcome, OUTCOME.OBSERVED_ABSENT);
  });

  test('NO_RECORDS → OBSERVED_ABSENT', async () => {
    const q = await queryTxt('x', rejectsWith('ENOTFOUND'));
    assert.equal(presence(q, isSpf).outcome, OUTCOME.OBSERVED_ABSENT);
  });

  test('NOT_OBSERVED never becomes ABSENT — the core Unknown≠Absent guarantee', async () => {
    const q = await queryTxt('x', rejectsWith('ETIMEOUT'));
    const p = presence(q, isSpf);
    assert.equal(p.outcome, OUTCOME.NOT_OBSERVED);
    assert.notEqual(p.outcome, OUTCOME.OBSERVED_ABSENT);
  });

  test('COLLECTION_ERROR never becomes ABSENT', async () => {
    const q = await queryTxt('x', rejectsWith('ESERVFAIL'));
    assert.equal(presence(q, isSpf).outcome, OUTCOME.COLLECTION_ERROR);
  });
});

describe('aggregatePresence — DKIM multi-selector combination', () => {
  const P = o => ({ outcome: o });
  test('any PRESENT wins outright', () => {
    assert.equal(aggregatePresence([P(OUTCOME.OBSERVED_ABSENT), P(OUTCOME.OBSERVED_PRESENT), P(OUTCOME.NOT_OBSERVED)]), OUTCOME.OBSERVED_PRESENT);
  });
  test('all probes completed, none found → OBSERVED_ABSENT (bounded)', () => {
    assert.equal(aggregatePresence([P(OUTCOME.OBSERVED_ABSENT), P(OUTCOME.OBSERVED_ABSENT)]), OUTCOME.OBSERVED_ABSENT);
  });
  test('a failed probe blocks a clean absence claim → NOT_OBSERVED', () => {
    assert.equal(aggregatePresence([P(OUTCOME.OBSERVED_ABSENT), P(OUTCOME.NOT_OBSERVED)]), OUTCOME.NOT_OBSERVED);
  });
  test('resolver error among otherwise-absent probes → COLLECTION_ERROR', () => {
    assert.equal(aggregatePresence([P(OUTCOME.OBSERVED_ABSENT), P(OUTCOME.COLLECTION_ERROR)]), OUTCOME.COLLECTION_ERROR);
  });
  test('NOT_OBSERVED takes precedence over COLLECTION_ERROR (both non-absent)', () => {
    assert.equal(aggregatePresence([P(OUTCOME.NOT_OBSERVED), P(OUTCOME.COLLECTION_ERROR)]), OUTCOME.NOT_OBSERVED);
  });
});

describe('Six-way distinction required by the sprint brief', () => {
  const isSpf = r => r.toLowerCase().startsWith('v=spf1');
  const outcomeFor = async (resolver) => presence(await queryTxt('x', resolver), isSpf).outcome;

  test('record exists   → OBSERVED_PRESENT', async () => assert.equal(await outcomeFor(resolves([['v=spf1 -all']])), OUTCOME.OBSERVED_PRESENT));
  test('record absent   → OBSERVED_ABSENT',  async () => assert.equal(await outcomeFor(resolves([['unrelated']])), OUTCOME.OBSERVED_ABSENT));
  test('lookup failed   → COLLECTION_ERROR', async () => assert.equal(await outcomeFor(rejectsWith('EBADRESP')), OUTCOME.COLLECTION_ERROR));
  test('timeout         → NOT_OBSERVED',     async () => assert.equal(await outcomeFor(rejectsWith('ETIMEOUT')), OUTCOME.NOT_OBSERVED));
  test('resolver error  → COLLECTION_ERROR', async () => assert.equal(await outcomeFor(rejectsWith('ESERVFAIL')), OUTCOME.COLLECTION_ERROR));
  test('unexpected exc. → COLLECTION_ERROR', async () => assert.equal(await outcomeFor(async () => { throw new Error('x'); }), OUTCOME.COLLECTION_ERROR));
});
