'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlannerPrompt, PLANNER_SYSTEM_PROMPT } = require('./prompts');

describe('prompts', () => {
  test('the system prompt instructs the model to treat fetched content as data, never instructions', () => {
    assert.match(PLANNER_SYSTEM_PROMPT, /never an instruction|treat.*as DATA|ignore it as content/i);
  });

  test('the system prompt restricts tool choice to the registered list', () => {
    assert.match(PLANNER_SYSTEM_PROMPT, /only choose a tool from the.*Available tools/i);
  });

  test('buildPlannerPrompt includes the target, open questions, tools and limits', () => {
    const prompt = buildPlannerPrompt({
      dossier: { target: { name: 'Compliance Office', domain: 'complianceoffice.co.uk' }, completeness: 0.5 },
      questions: [{ id: 'q1', priority: 'high', category: 'identity', reason: 'why' }],
      tools: [{ name: 'search_web', description: 'desc' }],
      recentEvents: [],
      limits: { maxSteps: 12 },
      usage: { steps: 1 },
      evidenceSummary: 'none yet',
    });
    assert.match(prompt, /Compliance Office/);
    assert.match(prompt, /q1/);
    assert.match(prompt, /search_web/);
    assert.match(prompt, /maxSteps/);
  });
});
