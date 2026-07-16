'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeClient } = require('./fake-client');
const db = require('./db');

test('insertCandidate: success via fake client', async () => {
  const client = createFakeClient();
  const result = await db.insertCandidate({
    hmrcRegistrationNumber: '123', businessName: 'Acme Ltd', tradingName: null, postcode: 'SW1A 1AA',
    sampleRank: 1, derivedCategory: 'UNCLASSIFIED', nameAmbiguityClass: 'DISTINCTIVE',
    nameDivergenceClass: 'NAME_ALIGNED', entityFormClass: 'CORPORATE_FORM', postcodeCompletenessClass: 'POSTCODE_COMPLETE',
    regionClass: 'LONDON', urbanRuralClass: 'URBAN', floorPassSelected: true, samplingRuleVersion: 'DDP-SAMPLE-v1.0',
  }, { client });
  assert.equal(result.success, true);
  assert.equal(result.data.business_name, 'Acme Ltd');
});

test('insertPrefilterResult, insertQuery, insertSearchResult, insertPageFetch, insertEvidence, insertDecision all succeed via fake client', async () => {
  const client = createFakeClient();
  const candidateResult = await db.insertCandidate({ hmrcRegistrationNumber: '1', businessName: 'Acme', sampleRank: 1 }, { client });
  const candidateId = candidateResult.data.id;

  const prefilterResult = await db.insertPrefilterResult(candidateId, '1', { classification: 'NO_MATCH', finalBraveDecision: 'SEARCHED', decisionReason: 'NO_MATCH', prefilterRuleVersion: 'DDP-PREFILTER-v1.0' }, { client });
  assert.equal(prefilterResult.success, true);

  const queryResult = await db.insertQuery(candidateId, { queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme"', success: true, rawResponse: { web: { results: [] } } }, { client });
  assert.equal(queryResult.success, true);

  const searchResultResult = await db.insertSearchResult(queryResult.data.id, { rank: 1, title: 't', url: 'https://acme.com', source: 'brave' }, { client });
  assert.equal(searchResultResult.success, true);

  const pageFetchResult = await db.insertPageFetch(candidateId, searchResultResult.data.id, { requestedUrl: 'https://acme.com', pageRole: 'homepage', fetchResult: { success: true, finalUrl: 'https://acme.com', status: 200, body: '<html></html>' } }, { client });
  assert.equal(pageFetchResult.success, true);

  const evidenceResult = await db.insertEvidence(candidateId, pageFetchResult.data.id, { companyNumber: null, legalName: 'Acme', tradingNameFound: null, postcodeFound: null, addressFound: null, telephoneFound: null, principals: null, categoryConsistency: false, extractionRuleVersion: 'DDP-EXTRACT-v1.0' }, { client });
  assert.equal(evidenceResult.success, true);

  const decisionResult = await db.insertDecision(candidateId, { decisionState: 'UNRESOLVED', scoreTotal: 0, scoreBreakdown: {}, matchedDomain: null, disqualifierReason: null, scoringRuleVersion: 'DDP-SCORE-v1.0' }, { client });
  assert.equal(decisionResult.success, true);
});

test('insertSearchResult: passes through the provider\'s own retrievedAt when present', async () => {
  const client = createFakeClient();
  const result = await db.insertSearchResult('fake-query-id', {
    rank: 1, title: 't', url: 'https://acme.com', source: 'brave', retrievedAt: '2026-07-15T12:00:00.000Z',
  }, { client });
  assert.equal(result.success, true);
  assert.equal(result.data.retrieved_at, '2026-07-15T12:00:00.000Z');
});

test('insertSearchResult: omits retrieved_at entirely (letting the DB default apply) when the result has none', async () => {
  const client = createFakeClient();
  const result = await db.insertSearchResult('fake-query-id', {
    rank: 1, title: 't', url: 'https://acme.com', source: 'brave',
  }, { client });
  assert.equal(result.success, true);
  // fake-client stamps its own created_at, not retrieved_at — absence here
  // confirms we didn't force a null/undefined value into a NOT NULL column.
  assert.equal('retrieved_at' in result.data, false);
});

test('insertCandidate: error path returns {success:false, error} without throwing', async () => {
  const brokenClient = {
    from() {
      return { insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'db unavailable' } }) }) }) };
    },
  };
  const result = await db.insertCandidate({ hmrcRegistrationNumber: '1', businessName: 'Acme' }, { client: brokenClient });
  assert.equal(result.success, false);
  assert.equal(result.error, 'db unavailable');
});

test('insertCandidate: a thrown client error is caught, not propagated', async () => {
  const throwingClient = { from() { throw new Error('connection refused'); } };
  const result = await db.insertCandidate({ hmrcRegistrationNumber: '1', businessName: 'Acme' }, { client: throwingClient });
  assert.equal(result.success, false);
  assert.equal(result.error, 'connection refused');
});
