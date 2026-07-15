'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runPrefilter } = require('./run-prefilter');

function resolveReturning(results) {
  return { search: () => ({ ok: true, results }) };
}

const candidate = { businessName: 'Acme Widgets Limited', tradingName: null, postcode: 'SW1A 1AA' };

test('behaviour table: NO_MATCH -> SEARCHED', async () => {
  const resolve = resolveReturning([]);
  const result = await runPrefilter(candidate, { resolve, orgIndex: new Map() });
  assert.equal(result.classification, 'NO_MATCH');
  assert.equal(result.finalBraveDecision, 'SEARCHED');
  assert.equal(result.decisionReason, 'NO_MATCH');
});

test('behaviour table: MULTIPLE_OR_AMBIGUOUS_MATCHES -> SEARCHED', async () => {
  const resolve = resolveReturning([
    { id: 'ORG-1', name: 'Acme Widgets Limited', domain: null },
    { id: 'ORG-2', name: 'Acme Widgets Group', domain: null },
  ]);
  const orgIndex = new Map([
    ['ORG-1', { organisationId: 'ORG-1', domainStatus: 'VERIFIED' }],
    ['ORG-2', { organisationId: 'ORG-2', domainStatus: 'VERIFIED' }],
  ]);
  const result = await runPrefilter(candidate, { resolve, orgIndex });
  assert.equal(result.classification, 'MULTIPLE_OR_AMBIGUOUS_MATCHES');
  assert.equal(result.finalBraveDecision, 'SEARCHED');
});

test('behaviour table: SINGLE_PROBABLE_MATCH + NO_DOMAIN -> SEARCHED', async () => {
  const resolve = resolveReturning([{ id: 'ORG-1', name: 'Acme Widgets Limited', domain: null }]);
  const orgIndex = new Map([['ORG-1', { organisationId: 'ORG-1', domainStatus: 'NO_DOMAIN' }]]);
  const result = await runPrefilter(candidate, { resolve, orgIndex });
  assert.equal(result.classification, 'SINGLE_PROBABLE_MATCH');
  assert.equal(result.finalBraveDecision, 'SEARCHED');
  assert.equal(result.decisionReason, 'SINGLE_PROBABLE_MATCH+NO_DOMAIN');
});

test('behaviour table: SINGLE_PROBABLE_MATCH + PENDING -> SEARCHED', async () => {
  const resolve = resolveReturning([{ id: 'ORG-1', name: 'Acme Widgets Limited', domain: null }]);
  const orgIndex = new Map([['ORG-1', { organisationId: 'ORG-1', domainStatus: 'PENDING' }]]);
  const result = await runPrefilter(candidate, { resolve, orgIndex });
  assert.equal(result.finalBraveDecision, 'SEARCHED');
  assert.equal(result.decisionReason, 'SINGLE_PROBABLE_MATCH+PENDING');
});

test('behaviour table: SINGLE_PROBABLE_MATCH + VERIFIED + CURRENT -> SKIPPED', async () => {
  const resolve = resolveReturning([{ id: 'ORG-1', name: 'Acme Widgets Limited', domain: 'acme-widgets.com' }]);
  const orgIndex = new Map([['ORG-1', { organisationId: 'ORG-1', domainStatus: 'VERIFIED' }]]);
  const fetchUrl = async () => ({ success: true, body: 'ACME WIDGETS LIMITED SW1A 1AA' });
  const result = await runPrefilter(candidate, { resolve, orgIndex, fetchUrl });
  assert.equal(result.finalBraveDecision, 'SKIPPED');
  assert.equal(result.decisionReason, 'SINGLE_PROBABLE_MATCH+VERIFIED+CURRENT');
});

test('behaviour table: SINGLE_PROBABLE_MATCH + VERIFIED + STALE/CONTRADICTORY/INCONCLUSIVE -> SEARCHED', async () => {
  const resolve = resolveReturning([{ id: 'ORG-1', name: 'Acme Widgets Limited', domain: 'acme-widgets.com' }]);
  const orgIndex = new Map([['ORG-1', { organisationId: 'ORG-1', domainStatus: 'VERIFIED' }]]);

  const staleFetch = async () => ({ success: false, errorType: 'connection_error' });
  const staleResult = await runPrefilter(candidate, { resolve, orgIndex, fetchUrl: staleFetch });
  assert.equal(staleResult.finalBraveDecision, 'SEARCHED');
  assert.equal(staleResult.decisionReason, 'SINGLE_PROBABLE_MATCH+VERIFIED+STALE');

  const contradictoryFetch = async () => ({ success: true, body: 'Unrelated business entirely, EH1 1AA' });
  const contradictoryResult = await runPrefilter(candidate, { resolve, orgIndex, fetchUrl: contradictoryFetch });
  assert.equal(contradictoryResult.finalBraveDecision, 'SEARCHED');
  assert.equal(contradictoryResult.decisionReason, 'SINGLE_PROBABLE_MATCH+VERIFIED+CONTRADICTORY');

  const inconclusiveFetch = async () => ({ success: true, body: '' });
  const inconclusiveResult = await runPrefilter(candidate, { resolve, orgIndex, fetchUrl: inconclusiveFetch });
  assert.equal(inconclusiveResult.finalBraveDecision, 'SEARCHED');
  assert.equal(inconclusiveResult.decisionReason, 'SINGLE_PROBABLE_MATCH+VERIFIED+INCONCLUSIVE');
});

// ── Safety: prefilter never calls any write-shaped RA function ────────────

test('safety: prefilter never calls a write-shaped Repository Authority function', async () => {
  const calledWriteFns = [];
  const resolve = {
    search: () => ({ ok: true, results: [] }),
    reload: () => { calledWriteFns.push('reload'); },
    resolveIdentity: () => { calledWriteFns.push('resolveIdentity'); },
  };
  await runPrefilter(candidate, { resolve, orgIndex: new Map() });
  assert.deepEqual(calledWriteFns, []);
});
