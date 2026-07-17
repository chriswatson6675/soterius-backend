'use strict';

// extract_entities — thin wrapper around the ALREADY-EXISTING conservative
// entity-detection module (research/entity-detection.js). Returns entity
// mentions (contextual references + linked organisations, i.e. discovery
// candidates) from a page already fetched via fetch_web_page/
// inspect_target_website. Never fetches anything itself — pure function
// over already-retrieved content, so it is always safe to run in dry-run.

const { detectEntities } = require('../../research/entity-detection');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['sourceUrl', 'extractedPage', 'investigationId'],
  properties: { sourceUrl: { type: 'string' }, extractedPage: {}, subjectName: { type: 'string', optional: true }, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createExtractEntitiesTool(deps = {}) {
  const detect = deps.detectEntities || detectEntities;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('extract_entities', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const detection = detect({ sourceUrl: input.sourceUrl, extracted: input.extractedPage }, { subjectName: input.subjectName });
    return successResult('extract_entities', {
      contextualMentions: detection.contextualMentions,
      linkedOrganisations: detection.linkedOrganisations,
    }, { provenance: { sourceUrl: input.sourceUrl } });
  }

  return {
    name: 'extract_entities',
    description: 'Extracts explicit entity mentions and linked organisations from an already-fetched page. Pure function, no I/O.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 5000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createExtractEntitiesTool };
