'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('../persistence/fake-client');
const persistence = require('../persistence/db');
const { reviewExistingRelationshipObservations } = require('./relationship-correction');

const HMRC_SENTENCE = "From 18 August 2026, HMRC will not accept communications on a client's behalf from anyone not registered with an Agent Services Account.";

async function setupInvestigationWithObservation(client, { relationshipType = 'regulator', thirdPartyName = 'HMRC', contextExcerpt = HMRC_SENTENCE } = {}) {
  const created = await persistence.createInvestigation({ name: 'Compliance Office', domain: 'complianceoffice.co.uk', normalisedDomain: 'complianceoffice.co.uk' }, { client });
  const investigationId = created.investigation.id;
  await persistence.createInitialDossier(investigationId, { name: 'Compliance Office', domain: 'complianceoffice.co.uk' }, { client });

  const obsResult = await persistence.appendRelationshipObservation({
    investigationId, subjectOrganisation: 'Compliance Office', thirdPartyName,
    relationshipType, relationshipDirection: 'outbound', confidence: 'medium',
    relationshipConfidenceState: 'probable', contextExcerpt, evidenceReferences: [],
  }, { client });

  // Mirror what research-website.js would have done: add a dossier summary entry.
  const dossier = await persistence.getDossier(investigationId, { client });
  const updatedState = {
    ...dossier.workingState,
    relationshipObservations: [{ id: obsResult.relationshipObservation.id, thirdPartyName, relationshipType, relationshipDirection: 'outbound' }],
  };
  await persistence.updateDossier(investigationId, updatedState, { client });

  return { investigationId, observationId: obsResult.relationshipObservation.id };
}

describe('reviewExistingRelationshipObservations — corrects an unsupported observation', () => {
  test('the HMRC-style false positive is removed from the dossier summary, preserved as historical, marked rejected, and logged', async () => {
    const client = createFakeClient();
    const { investigationId, observationId } = await setupInvestigationWithObservation(client);

    const result = await reviewExistingRelationshipObservations(investigationId, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.corrected.length, 1);
    assert.strictEqual(result.corrected[0].id, observationId);

    const bundle = (await persistence.getInvestigationBundle(investigationId, { client })).bundle;

    // The original append-only row is untouched — still present, unmutated.
    const originalRow = bundle.relationshipObservations.find((r) => r.id === observationId);
    assert.ok(originalRow);
    assert.strictEqual(originalRow.thirdPartyName, 'HMRC');
    assert.strictEqual(originalRow.contextExcerpt, HMRC_SENTENCE);

    // The dossier's active summary no longer includes it.
    assert.ok(!bundle.dossier.workingState.relationshipObservations.some((r) => r.id === observationId));

    // It's recorded as rejected, with reason/classification.
    const rejection = bundle.dossier.workingState.rejectedRelationshipObservationIds.find((r) => r.id === observationId);
    assert.ok(rejection);
    assert.ok(rejection.reason);
    assert.ok(rejection.classification);

    // Preserved as a contextual observation.
    assert.ok(bundle.dossier.workingState.observations.some((o) => o.rawName === 'HMRC' && o.detectionMethod === 'precision_pass_correction'));

    // An agent event documents the correction.
    const correctionEvent = bundle.agentEvents.find((e) => e.eventType === 'contradiction_recorded');
    assert.ok(correctionEvent);
    assert.strictEqual(correctionEvent.payload.action, 'relationship_observation_rejected');
  });

  test('does not touch a genuinely supported relationship observation', async () => {
    const client = createFakeClient();
    const { investigationId, observationId } = await setupInvestigationWithObservation(client, {
      thirdPartyName: 'FCA', contextExcerpt: 'We are regulated by the FCA.',
    });

    const result = await reviewExistingRelationshipObservations(investigationId, { client });
    assert.strictEqual(result.corrected.length, 0);

    const bundle = (await persistence.getInvestigationBundle(investigationId, { client })).bundle;
    assert.ok(bundle.dossier.workingState.relationshipObservations.some((r) => r.id === observationId));
    assert.deepStrictEqual(bundle.dossier.workingState.rejectedRelationshipObservationIds, []);
  });

  test('is idempotent: running twice does not duplicate the rejection record or the agent event', async () => {
    const client = createFakeClient();
    const { investigationId } = await setupInvestigationWithObservation(client);

    await reviewExistingRelationshipObservations(investigationId, { client });
    const second = await reviewExistingRelationshipObservations(investigationId, { client });

    assert.strictEqual(second.corrected.length, 0);
    assert.strictEqual(second.alreadyCorrected.length, 1);

    const bundle = (await persistence.getInvestigationBundle(investigationId, { client })).bundle;
    assert.strictEqual(bundle.dossier.workingState.rejectedRelationshipObservationIds.length, 1);
    assert.strictEqual(bundle.agentEvents.filter((e) => e.eventType === 'contradiction_recorded').length, 1);
  });

  test('never attempts to UPDATE or DELETE the commercial_relationship_observations row directly', async () => {
    const client = createFakeClient();
    const { investigationId } = await setupInvestigationWithObservation(client);
    const before = JSON.stringify(client._tables.commercial_relationship_observations);

    await reviewExistingRelationshipObservations(investigationId, { client });

    const after = JSON.stringify(client._tables.commercial_relationship_observations);
    assert.strictEqual(before, after); // byte-for-byte unchanged
  });
});
