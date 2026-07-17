'use strict';

// record_evidence — the ONLY way a fetched page/PDF becomes preserved
// evidence. Wraps persistence/db.js's appendEvidence (append-only). In
// dry-run, performs zero writes and returns a "would persist" preview
// instead — this, plus the equivalent checks in record_claim/
// record_discovery/finish_investigation, is what makes dry-run's
// zero-write guarantee airtight regardless of what the planner decides.

const persistence = require('../../persistence/db');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['sourceUrl', 'retrievedAt', 'evidenceClass', 'investigationId'],
  properties: {
    sourceUrl: { type: 'string' }, retrievedAt: { type: 'string' }, evidenceClass: { type: 'string' },
    contextExcerpt: { type: 'string', optional: true }, sourceTitle: { type: 'string', optional: true },
    rawContent: { optional: true }, investigationId: { type: 'string' },
  },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createRecordEvidenceTool(deps = {}) {
  const appendEvidence = deps.appendEvidence || persistence.appendEvidence;

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('record_evidence', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (context.dryRun) {
      return successResult('record_evidence', {
        wouldPersist: true,
        preview: { sourceUrl: input.sourceUrl, evidenceClass: input.evidenceClass, sourceTitle: input.sourceTitle || null, contextExcerpt: input.contextExcerpt || null },
      });
    }

    const result = await appendEvidence({
      investigationId: input.investigationId, sourceUrl: input.sourceUrl, retrievedAt: input.retrievedAt,
      evidenceClass: input.evidenceClass, contextExcerpt: input.contextExcerpt || null,
      sourceTitle: input.sourceTitle || null, rawContent: input.rawContent,
    }, context.deps || {});

    if (!result.success) return failureResult('record_evidence', { errorType: 'persistence_failed', error: result.error, retryable: false });
    return successResult('record_evidence', { wouldPersist: false, evidence: result.evidence });
  }

  return {
    name: 'record_evidence',
    description: 'Persists a preserved source (page/PDF) as evidence. Zero writes in dry-run.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 10000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createRecordEvidenceTool };
