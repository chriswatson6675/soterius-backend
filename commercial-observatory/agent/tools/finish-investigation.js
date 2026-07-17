'use strict';

// finish_investigation — the terminal tool. Produces a PENDING Commercial
// Authority Draft from the agent's accumulated research — never approved,
// never a canonical admission (that remains a separate, later, human
// founder-review act, per the domain design). Wraps persistence/db.js's
// createDraft.

const persistence = require('../../persistence/db');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['draftContent', 'investigationId'],
  properties: { draftContent: {}, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createFinishInvestigationTool(deps = {}) {
  const createDraft = deps.createDraft || persistence.createDraft;

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('finish_investigation', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (context.dryRun) {
      return successResult('finish_investigation', { wouldPersist: true, preview: input.draftContent });
    }

    const result = await createDraft({ investigationId: input.investigationId, content: input.draftContent }, context.deps || {});
    if (!result.success) return failureResult('finish_investigation', { errorType: 'persistence_failed', error: result.error, retryable: false });
    return successResult('finish_investigation', { wouldPersist: false, draft: result.draft });
  }

  return {
    name: 'finish_investigation',
    description: 'Produces a pending Commercial Authority draft from the accumulated research. Never approves — that is a separate, later founder-review act. Zero writes in dry-run.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 10000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createFinishInvestigationTool };
