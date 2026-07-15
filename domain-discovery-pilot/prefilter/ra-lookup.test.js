'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { lookupCandidates } = require('./ra-lookup');

function fakeResolve(byQuery) {
  return {
    search(query) {
      return { ok: true, results: byQuery[query] || [] };
    },
  };
}

test('lookupCandidates: unions name + tradingName results, deduped by id', () => {
  const resolve = fakeResolve({
    'Acme Ltd': [{ id: 'ORG-1', name: 'Acme Ltd', domain: null }, { id: 'ORG-2', name: 'Acme Group', domain: null }],
    'Acme Trading': [{ id: 'ORG-2', name: 'Acme Group', domain: null }, { id: 'ORG-3', name: 'Acme Trading Co', domain: null }],
  });
  const orgIndex = new Map();
  const result = lookupCandidates({ name: 'Acme Ltd', tradingName: 'Acme Trading' }, { resolve, orgIndex });
  assert.equal(result.ok, true);
  const ids = result.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ['ORG-1', 'ORG-2', 'ORG-3']);
});

test('lookupCandidates: skips tradingName search when identical to name', () => {
  let calls = 0;
  const resolve = { search(query) { calls += 1; return { ok: true, results: [] }; } };
  lookupCandidates({ name: 'Acme Ltd', tradingName: 'Acme Ltd' }, { resolve, orgIndex: new Map() });
  assert.equal(calls, 1);
});

test('lookupCandidates: enriches each candidate with domainStatus from the org index, postcode always null', () => {
  const resolve = fakeResolve({ 'Acme Ltd': [{ id: 'ORG-1', name: 'Acme Ltd', domain: null }] });
  const orgIndex = new Map([['ORG-1', { organisationId: 'ORG-1', domainStatus: 'VERIFIED' }]]);
  const result = lookupCandidates({ name: 'Acme Ltd', tradingName: null }, { resolve, orgIndex });
  assert.equal(result.candidates[0].domainStatus, 'VERIFIED');
  assert.equal(result.candidates[0].postcode, null);
});

test('lookupCandidates: never calls any write-shaped function on the resolve module', () => {
  const resolve = fakeResolve({ 'Acme Ltd': [] });
  assert.equal(typeof resolve.reload, 'undefined');
  const result = lookupCandidates({ name: 'Acme Ltd' }, { resolve, orgIndex: new Map() });
  assert.equal(result.ok, true);
});
