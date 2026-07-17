'use strict';

// record_discovery — wraps persistence/db.js's appendDiscovery. A
// Discovery is never a relationship assertion and never a canonical
// admission — it is a candidate future investigation, exactly as the
// prior execution-architecture design established.

const persistence = require('../../persistence/db');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['discoveredName', 'discoveryReason', 'investigationId'],
  properties: {
    discoveredName: { type: 'string' }, discoveredDomain: { type: 'string', optional: true },
    discoveryReason: { type: 'string' }, proposedRelationshipType: { type: 'string', optional: true },
    investigationId: { type: 'string' },
  },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createRecordDiscoveryTool(deps = {}) {
  const appendDiscovery = deps.appendDiscovery || persistence.appendDiscovery;

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('record_discovery', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (context.dryRun) {
      return successResult('record_discovery', { wouldPersist: true, preview: { discoveredName: input.discoveredName, discoveredDomain: input.discoveredDomain || null, discoveryReason: input.discoveryReason } });
    }

    const result = await appendDiscovery({
      investigationId: input.investigationId, discoveredName: input.discoveredName,
      discoveredDomain: input.discoveredDomain || null, discoveryReason: input.discoveryReason,
      proposedRelationshipType: input.proposedRelationshipType || 'unclassified', eligibleForFutureInvestigation: true,
    }, context.deps || {});

    if (!result.success) return failureResult('record_discovery', { errorType: 'persistence_failed', error: result.error, retryable: false });
    return successResult('record_discovery', { wouldPersist: false, discovery: result.discovery });
  }

  return {
    name: 'record_discovery',
    description: 'Records a newly discovered organisation as a candidate for a future, separate investigation. Zero writes in dry-run.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 10000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createRecordDiscoveryTool };
