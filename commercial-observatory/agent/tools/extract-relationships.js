'use strict';

// extract_relationships — thin wrapper around the ALREADY-EXISTING
// conservative entity-detection + relationship-assertion modules. Returns
// only relationship CANDIDATES that the deterministic assertion layer
// (research/relationship-assertion.js) already found structurally
// supported — this tool cannot itself relax that discipline; it is a pure
// read of entity-detection.js's own output.

const { detectEntities } = require('../../research/entity-detection');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['sourceUrl', 'extractedPage', 'investigationId'],
  properties: { sourceUrl: { type: 'string' }, extractedPage: {}, subjectName: { type: 'string', optional: true }, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createExtractRelationshipsTool(deps = {}) {
  const detect = deps.detectEntities || detectEntities;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('extract_relationships', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const detection = detect({ sourceUrl: input.sourceUrl, extracted: input.extractedPage }, { subjectName: input.subjectName });
    return successResult('extract_relationships', {
      relationshipCandidates: detection.relationshipCandidates,
    }, { provenance: { sourceUrl: input.sourceUrl } });
  }

  return {
    name: 'extract_relationships',
    description: 'Extracts deterministically-supported relationship candidates from an already-fetched page. Pure function, no I/O.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 5000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createExtractRelationshipsTool };
