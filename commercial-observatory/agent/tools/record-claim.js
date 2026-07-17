'use strict';

// record_claim — persists a single evidence-cited factual finding. Wraps
// persistence/db.js's appendClaim. The orchestrator is responsible for
// validating (per Part 9) that every claim cites evidence IDs that belong
// to THIS investigation before ever calling this tool — this tool itself
// re-checks that requirement defensively (never trust the caller alone).
//
// SCHEMA NOTE (no migration permitted this task): `commercial_claims`
// (migration 050) has no evidence-reference column — only
// commercial_relationship_observations does. The evidenceIds citation is
// therefore enforced HERE (a claim is rejected outright if it cites no
// evidence, or evidence from another investigation) and preserved in the
// orchestrator's `claim_recorded` agent-event payload, not as a column on
// the claim row itself. This is disclosed, not hidden — see the final
// response's schema-limitation section.

const persistence = require('../../persistence/db');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['claimType', 'field', 'confidence', 'investigationId'],
  properties: {
    claimType: { type: 'string' }, field: { type: 'string' }, value: { optional: true },
    confidence: { type: 'string' }, evidenceIds: { type: 'array', optional: true }, investigationId: { type: 'string' },
  },
};

function validate(input) {
  const result = validateInput(input, INPUT_SCHEMA);
  if (input?.value === undefined) result.errors.push('value is required (may be null, never undefined).');
  if (!input?.evidenceIds || input.evidenceIds.length === 0) result.errors.push('evidenceIds must cite at least one preserved evidence record — a claim based only on a search snippet is not admissible.');
  result.valid = result.errors.length === 0;
  return result;
}

function createRecordClaimTool(deps = {}) {
  const appendClaim = deps.appendClaim || persistence.appendClaim;
  const getInvestigationBundle = deps.getInvestigationBundle || persistence.getInvestigationBundle;

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('record_claim', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    // Defence-in-depth: every cited evidence id must belong to THIS investigation.
    const bundleResult = await getInvestigationBundle(input.investigationId, context.deps || {});
    if (!bundleResult.success) return failureResult('record_claim', { errorType: 'investigation_not_found', error: bundleResult.error, retryable: false });
    const knownEvidenceIds = new Set(bundleResult.bundle.evidence.map((e) => e.id));
    const foreignIds = (input.evidenceIds || []).filter((id) => !knownEvidenceIds.has(id));
    if (foreignIds.length > 0) {
      return failureResult('record_claim', { errorType: 'evidence_not_in_investigation', error: `Evidence id(s) not found in this investigation: ${foreignIds.join(', ')}`, retryable: false });
    }

    if (context.dryRun) {
      return successResult('record_claim', { wouldPersist: true, preview: { claimType: input.claimType, field: input.field, value: input.value, confidence: input.confidence, evidenceIds: input.evidenceIds } });
    }

    const result = await appendClaim({
      investigationId: input.investigationId, claimType: input.claimType, field: input.field,
      value: input.value, confidence: input.confidence,
    }, context.deps || {});

    if (!result.success) return failureResult('record_claim', { errorType: 'persistence_failed', error: result.error, retryable: false });
    return successResult('record_claim', { wouldPersist: false, claim: result.claim });
  }

  return {
    name: 'record_claim',
    description: 'Persists a single evidence-cited claim. Rejects claims with no cited evidence, or evidence from another investigation. Zero writes in dry-run.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 10000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createRecordClaimTool };
