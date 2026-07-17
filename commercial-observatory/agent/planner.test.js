'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { decidePlannerAction } = require('./planner');
const { generateInitialQuestions } = require('./research-questions');
const { createDefaultToolRegistry } = require('./tools');

const LIMITS = { maxSteps: 12, maxSearches: 5, maxSearchPhaseSearches: 4, maxFetchedPages: 20, maxPdfs: 3, maxCoPartyFollowUps: 5, maxRepeatedActions: 2 };

function baseInput(overrides = {}) {
  return {
    dossier: { target: { name: 'Compliance Office', domain: 'complianceoffice.co.uk' }, completeness: 0 },
    questions: generateInitialQuestions(),
    toolRegistry: createDefaultToolRegistry(),
    recentEvents: [],
    limits: LIMITS,
    usage: { steps: 0, searches: 0, fetchedPages: 0, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 },
    context: { investigationId: 'inv-1', homepageUrl: 'https://complianceoffice.co.uk/', homepageFetched: false, companiesHouseTried: false, fcaTried: false, sraTried: false, searchesTried: 0, searchedQueries: new Set() },
    targetName: 'Compliance Office',
    targetDomain: 'complianceoffice.co.uk',
    llmClient: null,
    ...overrides,
  };
}

const HOMEPAGE_DONE_CONTEXT = { investigationId: 'inv-1', homepageUrl: 'https://complianceoffice.co.uk/', homepageFetched: true, companiesHouseTried: false, fcaTried: false, sraTried: false, searchesTried: 0, searchedQueries: new Set() };

describe('planner — target inspection comes first', () => {
  test('fetches the target homepage before anything else', async () => {
    const action = await decidePlannerAction(baseInput());
    assert.strictEqual(action.action, 'use_tool');
    assert.strictEqual(action.toolName, 'fetch_web_page');
    assert.strictEqual(action.toolInput.url, 'https://complianceoffice.co.uk/');
  });

  test('only ever chooses a registered tool', async () => {
    const action = await decidePlannerAction(baseInput());
    const registry = createDefaultToolRegistry();
    assert.ok(registry.has(action.toolName));
  });

  test('avoids repeating an already-attempted homepage fetch', async () => {
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, homepageFetched: false, recentActionKeys: new Set(['fetch_web_page:https://complianceoffice.co.uk/']) },
    }));
    assert.notStrictEqual(action.toolName, 'fetch_web_page');
  });
});

describe('planner — search-first phase (after homepage inspection)', () => {
  test('searches for an unresolved high-value question once the homepage has been inspected', async () => {
    const action = await decidePlannerAction(baseInput({ context: HOMEPAGE_DONE_CONTEXT }));
    assert.strictEqual(action.action, 'use_tool');
    assert.strictEqual(action.toolName, 'search_web');
    assert.ok(action.toolInput.query.includes('Compliance Office'));
  });

  test('search occurs before low-value repeated co-party follow-up', async () => {
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, pendingDiscoveries: [{ name: 'Some Co-Party', domain: 'coparty.example' }] },
    }));
    assert.strictEqual(action.toolName, 'search_web');
  });

  test('does not force an irrelevant search once every question\'s search templates are exhausted', async () => {
    // Every question that has search templates has already had every query tried.
    const { buildQueryTemplates } = require('./search-queries');
    const templates = buildQueryTemplates('Compliance Office', 'complianceoffice.co.uk');
    const allQueries = new Set();
    for (const list of Object.values(templates)) for (const q of list) allQueries.add(q.trim().toLowerCase().replace(/\s+/g, ' '));

    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, companiesHouseTried: true, fcaTried: true, sraTried: true, searchedQueries: allQueries },
    }));
    assert.notStrictEqual(action.toolName, 'search_web');
  });

  test('respects the search-phase limit — moves on to register lookups once maxSearchPhaseSearches is reached', async () => {
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, searchesTried: 4 }, // == maxSearchPhaseSearches
      usage: { steps: 1, searches: 4, fetchedPages: 1, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 },
    }));
    assert.strictEqual(action.toolName, 'companies_house_lookup');
  });

  test('duplicate (normalised) queries are never repeated', async () => {
    const { normaliseQuery } = require('./search-queries');
    const firstAction = await decidePlannerAction(baseInput({ context: HOMEPAGE_DONE_CONTEXT }));
    const searchedQueries = new Set([normaliseQuery(firstAction.toolInput.query)]);
    const secondAction = await decidePlannerAction(baseInput({ context: { ...HOMEPAGE_DONE_CONTEXT, searchedQueries } }));
    assert.notStrictEqual(secondAction.toolInput?.query, firstAction.toolInput.query);
  });
});

describe('planner — register lookups still used where justified', () => {
  test('moves on to fca_lookup once Companies House has already been tried and the search phase is exhausted', async () => {
    const searchedQueries = new Set();
    const { buildQueryTemplates } = require('./search-queries');
    const templates = buildQueryTemplates('Compliance Office', 'complianceoffice.co.uk');
    for (const id of ['identity-legal-entity', 'identity-companies-house']) {
      for (const q of templates[id] || []) searchedQueries.add(q.trim().toLowerCase().replace(/\s+/g, ' '));
    }
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, companiesHouseTried: true, searchesTried: 4, searchedQueries },
      usage: { steps: 1, searches: 4, fetchedPages: 1, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 },
    }));
    assert.strictEqual(action.toolName, 'fca_lookup');
  });
});

describe('planner — corroboration and limits', () => {
  test('prefers corroborating weak (hypothesis-level) evidence when flagged, ahead of the search phase', async () => {
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, weakEvidenceEntity: 'Acme Compliance Software' },
    }));
    assert.strictEqual(action.toolName, 'search_web');
    assert.ok(action.toolInput.query.includes('Acme Compliance Software'));
  });

  test('finishes when no open high-priority question remains', async () => {
    const action = await decidePlannerAction(baseInput({ questions: [] }));
    assert.strictEqual(action.action, 'finish');
    assert.strictEqual(action.stopReason, 'no_high_value_question_remaining');
  });

  test('respects remaining limits — finishes when a limit is already reached', async () => {
    const action = await decidePlannerAction(baseInput({ usage: { steps: 12, searches: 0, fetchedPages: 0, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 } }));
    assert.strictEqual(action.action, 'finish');
    assert.match(action.stopReason, /limit_reached/);
  });

  test('never exceeds the overall maxSearches limit even in the remaining-gap phase', async () => {
    const action = await decidePlannerAction(baseInput({
      context: { ...HOMEPAGE_DONE_CONTEXT, companiesHouseTried: true, fcaTried: true, sraTried: true, searchesTried: 5 },
      usage: { steps: 1, searches: 5, fetchedPages: 1, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 },
    }));
    assert.notStrictEqual(action.toolName, 'search_web');
  });
});

describe('planner — LLM path validation (never trusts an unvalidated proposal)', () => {
  test('falls back to deterministic planning when the LLM proposes an unregistered tool', async () => {
    const fakeLlmClient = {
      isAvailable: () => true,
      complete: async () => ({ available: true, text: JSON.stringify({ action: 'use_tool', toolName: 'browse_anything_unrestricted', toolInput: {} }) }),
    };
    const action = await decidePlannerAction(baseInput({ llmClient: fakeLlmClient }));
    assert.strictEqual(action.action, 'use_tool');
    assert.strictEqual(action.toolName, 'fetch_web_page'); // deterministic fallback, not the LLM's invented tool
  });

  test('accepts a validated LLM proposal naming a real registered tool', async () => {
    const fakeLlmClient = {
      isAvailable: () => true,
      complete: async () => ({ available: true, text: JSON.stringify({ action: 'use_tool', toolName: 'companies_house_lookup', questionId: 'identity-companies-house', toolInput: { name: 'Compliance Office', investigationId: 'inv-1' }, reason: 'x', expectedInformationGain: 'high' }) }),
    };
    const action = await decidePlannerAction(baseInput({ llmClient: fakeLlmClient }));
    assert.strictEqual(action.toolName, 'companies_house_lookup');
  });

  test('falls back to deterministic planning when the LLM is unavailable', async () => {
    const fakeLlmClient = { isAvailable: () => false, complete: async () => ({ available: false, reason: 'no key' }) };
    const action = await decidePlannerAction(baseInput({ llmClient: fakeLlmClient }));
    assert.strictEqual(action.toolName, 'fetch_web_page');
  });
});
