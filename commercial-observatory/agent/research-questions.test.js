'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateInitialQuestions, validateQuestion, resolveQuestion, dropQuestion, refreshQuestions, prioritiseOpenQuestions,
} = require('./research-questions');

describe('generateInitialQuestions', () => {
  test('produces one question per required category, each with all required fields', () => {
    const questions = generateInitialQuestions();
    const categories = new Set(questions.map((q) => q.category));
    for (const cat of ['identity', 'services', 'regulatory_expertise', 'clients_sectors', 'relationships', 'people', 'thought_leadership', 'ecosystem_discovery']) {
      assert.ok(categories.has(cat), `missing category: ${cat}`);
    }
    for (const q of questions) {
      assert.ok(q.id);
      assert.ok(q.category);
      assert.ok(q.priority);
      assert.strictEqual(q.status, 'open');
      assert.deepStrictEqual(q.supportingEvidenceIds, []);
      assert.ok(q.reason);
      assert.ok(Array.isArray(q.suggestedTools) && q.suggestedTools.length > 0);
      assert.ok(q.createdAt);
      assert.strictEqual(q.resolvedAt, null);
      assert.strictEqual(validateQuestion(q).valid, true);
    }
  });
});

describe('resolveQuestion / dropQuestion', () => {
  test('resolving a question sets status, resolvedAt, and appends evidence ids', () => {
    const questions = generateInitialQuestions();
    const updated = resolveQuestion(questions, 'identity-legal-entity', { evidenceIds: ['ev-1'] });
    const q = updated.find((x) => x.id === 'identity-legal-entity');
    assert.strictEqual(q.status, 'resolved');
    assert.ok(q.resolvedAt);
    assert.deepStrictEqual(q.supportingEvidenceIds, ['ev-1']);
  });

  test('dropping a question sets status to dropped, not resolved', () => {
    const questions = generateInitialQuestions();
    const updated = dropQuestion(questions, 'thought-leadership-published', { reason: 'no longer relevant' });
    const q = updated.find((x) => x.id === 'thought-leadership-published');
    assert.strictEqual(q.status, 'dropped');
  });
});

describe('refreshQuestions', () => {
  test('auto-resolves the identity question once the dossier already knows the legal name', () => {
    const questions = generateInitialQuestions();
    const dossier = { identity: { legalName: { value: 'Compliance Office Ltd' } }, relationshipObservations: [] };
    const updated = refreshQuestions(questions, dossier);
    assert.strictEqual(updated.find((q) => q.id === 'identity-legal-entity').status, 'resolved');
  });

  test('leaves questions open when the dossier has nothing relevant yet', () => {
    const questions = generateInitialQuestions();
    const dossier = { identity: {}, relationshipObservations: [] };
    const updated = refreshQuestions(questions, dossier);
    assert.strictEqual(updated.find((q) => q.id === 'identity-legal-entity').status, 'open');
  });
});

describe('prioritiseOpenQuestions', () => {
  test('returns only open questions, high priority first', () => {
    const questions = generateInitialQuestions();
    const resolved = resolveQuestion(questions, 'identity-legal-entity', {});
    const prioritised = prioritiseOpenQuestions(resolved);
    assert.ok(!prioritised.some((q) => q.id === 'identity-legal-entity'));
    assert.ok(prioritised.length > 0);
    for (let i = 1; i < prioritised.length; i += 1) {
      const order = { high: 0, medium: 1, low: 2 };
      assert.ok(order[prioritised[i - 1].priority] <= order[prioritised[i].priority]);
    }
  });
});
