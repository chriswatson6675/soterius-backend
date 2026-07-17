'use strict';

// Precision-pass correction — re-reviews an Investigation's ALREADY-
// PERSISTED relationship observations against the (now fixed) relationship
// assertion model, using only each row's own stored `contextExcerpt` — no
// refetch, no LLM.
//
// This is deliberately NOT a mutation of commercial_relationship_observations
// (append-only by database trigger — see migration 050 — and this module
// never attempts to UPDATE or DELETE it). Instead:
//   - the original row is preserved forever, exactly as the agent produced
//     it (historical agent output);
//   - the dossier's own (mutable, versioned JSONB) working state is what
//     changes: the rejected observation's id is removed from the dossier's
//     `relationshipObservations` summary and recorded in the new
//     `rejectedRelationshipObservationIds` list, and the mention is added
//     back to `observations` as an honest contextual reference;
//   - one `contradiction_recorded` agent event documents the correction and
//     its reason, per Investigation.
//
// This is the smallest backend-only correction mechanism consistent with
// the existing append-only architecture — no migration, no new table, no
// enum change, no weakening of the database's append-only protections.

const { assessRelationshipAssertion } = require('./relationship-assertion');
const persistence = require('../persistence/db');

/**
 * reviewExistingRelationshipObservations(investigationId, deps) -> Promise<{
 *   success, corrected: [{ id, thirdPartyName, relationshipType, classification, reason }],
 *   alreadyCorrected: [...ids previously corrected, skipped this run],
 * } | { success: false, error }>
 */
async function reviewExistingRelationshipObservations(investigationId, deps = {}) {
  const bundleResult = await persistence.getInvestigationBundle(investigationId, deps);
  if (!bundleResult.success) return { success: false, error: bundleResult.error };

  const { investigation, dossier: dossierRow, relationshipObservations } = bundleResult.bundle;
  if (!dossierRow) return { success: false, error: 'Dossier not found for investigation' };

  const workingState = dossierRow.workingState;
  const alreadyRejectedIds = new Set((workingState.rejectedRelationshipObservationIds || []).map((r) => r.id));

  const targetName = investigation.targetName || investigation.targetDomain;
  const corrected = [];
  const alreadyCorrected = [];

  for (const row of relationshipObservations) {
    if (alreadyRejectedIds.has(row.id)) { alreadyCorrected.push(row.id); continue; }

    const assessment = assessRelationshipAssertion({
      sentence: row.contextExcerpt || '',
      entityText: row.thirdPartyName,
      targetName,
      isTargetAuthored: true,
    });

    if (!assessment.supported) {
      corrected.push({
        id: row.id,
        thirdPartyName: row.thirdPartyName,
        relationshipType: row.relationshipType,
        relationshipDirection: row.relationshipDirection,
        classification: assessment.classification,
        reason: assessment.reason,
        contextExcerpt: row.contextExcerpt,
      });
    }
  }

  if (corrected.length === 0) {
    return { success: true, corrected: [], alreadyCorrected };
  }

  const correctedIds = new Set(corrected.map((c) => c.id));
  const updatedWorkingState = {
    ...workingState,
    // Remove the now-unsupported observations from the dossier's own
    // "current belief" summary — the append-only source row is untouched.
    relationshipObservations: (workingState.relationshipObservations || []).filter((r) => !correctedIds.has(r.id)),
    rejectedRelationshipObservationIds: [
      ...(workingState.rejectedRelationshipObservationIds || []),
      ...corrected.map((c) => ({
        id: c.id, thirdPartyName: c.thirdPartyName, relationshipType: c.relationshipType,
        classification: c.classification, reason: c.reason, rejectedAt: new Date().toISOString(),
      })),
    ],
    observations: [
      ...(workingState.observations || []),
      ...corrected.map((c) => ({
        type: 'contextual_reference', rawName: c.thirdPartyName, normalisedName: null,
        contextExcerpt: c.contextExcerpt, detectionMethod: 'precision_pass_correction',
        classification: c.classification, rejectionReason: c.reason,
      })),
    ],
  };

  const dossierUpdate = await persistence.updateDossier(investigationId, updatedWorkingState, deps);
  if (!dossierUpdate.success) return { success: false, error: dossierUpdate.error };

  const existingEventCount = bundleResult.bundle.agentEvents.length;
  await persistence.appendAgentEvent({
    investigationId,
    eventType: 'contradiction_recorded',
    stepNumber: existingEventCount,
    payload: {
      action: 'relationship_observation_rejected',
      reason: 'Deterministic precision-pass review (relationship-assertion.js) found these earlier relationship observations no longer supported.',
      corrections: corrected.map((c) => ({ id: c.id, thirdPartyName: c.thirdPartyName, relationshipType: c.relationshipType, classification: c.classification, reason: c.reason })),
    },
  }, deps);

  return { success: true, corrected, alreadyCorrected };
}

module.exports = { reviewExistingRelationshipObservations };
