'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickNextSearchQuery, normaliseQuery } = require('./search-queries');

describe('pickNextSearchQuery', () => {
  test('picks the first untried query for the highest-priority open question', () => {
    const questions = [{ id: 'identity-legal-entity', priority: 'high' }, { id: 'services-provided', priority: 'high' }];
    const result = pickNextSearchQuery(questions, 'Compliance Office', 'complianceoffice.co.uk', new Set());
    assert.strictEqual(result.questionId, 'identity-legal-entity');
    assert.match(result.query, /Compliance Office/);
  });

  test('skips already-issued (normalised) queries', () => {
    const questions = [{ id: 'identity-legal-entity', priority: 'high' }];
    const seen = new Set([normaliseQuery('"Compliance Office" company')]);
    const result = pickNextSearchQuery(questions, 'Compliance Office', 'complianceoffice.co.uk', seen);
    assert.notStrictEqual(result.query, '"Compliance Office" company');
  });

  test('moves to the next question once one question\'s templates are exhausted', () => {
    const questions = [{ id: 'identity-legal-entity', priority: 'high' }, { id: 'services-provided', priority: 'medium' }];
    const seen = new Set([
      normaliseQuery('"Compliance Office" company'),
      normaliseQuery('site:find-and-update.company-information.service.gov.uk "Compliance Office"'),
      normaliseQuery('"Compliance Office" "complianceoffice.co.uk"'),
    ]);
    const result = pickNextSearchQuery(questions, 'Compliance Office', 'complianceoffice.co.uk', seen);
    assert.strictEqual(result.questionId, 'services-provided');
  });

  test('returns null once every question is exhausted — never forces an irrelevant search', () => {
    const questions = [{ id: 'clients-named-evidence', priority: 'low' }]; // no template exists for this id
    const result = pickNextSearchQuery(questions, 'Compliance Office', 'complianceoffice.co.uk', new Set());
    assert.strictEqual(result, null);
  });
});
