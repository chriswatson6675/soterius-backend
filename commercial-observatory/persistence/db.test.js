'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('./fake-client');
const db = require('./db');

describe('createInvestigation', () => {
  test('creates a pending investigation from a domain only', async () => {
    const client = createFakeClient();
    const result = await db.createInvestigation({ domain: 'example.com', normalisedDomain: 'example.com' }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.investigation.status, 'pending');
    assert.strictEqual(result.investigation.targetDomain, 'example.com');
    assert.ok(result.investigation.id);
  });

  test('rejects when neither name nor domain supplied', async () => {
    const client = createFakeClient();
    const result = await db.createInvestigation({}, { client });
    assert.strictEqual(result.success, false);
  });

  test('rerun_of preserves the prior investigation untouched', async () => {
    const client = createFakeClient();
    const first = await db.createInvestigation({ domain: 'example.com', normalisedDomain: 'example.com' }, { client });
    const rerun = await db.createInvestigation({ domain: 'example.com', normalisedDomain: 'example.com', rerunOf: first.investigation.id }, { client });

    assert.strictEqual(rerun.investigation.rerunOf, first.investigation.id);
    assert.notStrictEqual(rerun.investigation.id, first.investigation.id);

    const priorStillThere = await db.getInvestigation(first.investigation.id, { client });
    assert.strictEqual(priorStillThere.id, first.investigation.id);
    assert.strictEqual(priorStillThere.rerunOf, null);
  });
});

describe('updateInvestigationStatus', () => {
  test('allows pending -> running', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.updateInvestigationStatus(investigation.id, 'running', { startedAt: '2026-07-14T00:00:00.000Z' }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.investigation.status, 'running');
    assert.strictEqual(result.investigation.startedAt, '2026-07-14T00:00:00.000Z');
  });

  test('allows a rerun: completed -> running is a valid transition', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.updateInvestigationStatus(investigation.id, 'running', {}, { client });
    await db.updateInvestigationStatus(investigation.id, 'completed', {}, { client });
    const result = await db.updateInvestigationStatus(investigation.id, 'running', {}, { client });
    assert.strictEqual(result.success, true);
  });

  test('rejects an invalid transition (cancelled -> running — genuinely terminal)', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.updateInvestigationStatus(investigation.id, 'cancelled', {}, { client });
    const result = await db.updateInvestigationStatus(investigation.id, 'running', {}, { client });
    assert.strictEqual(result.success, false);
  });

  test('returns a structured failure for an unknown investigation id, never throws', async () => {
    const client = createFakeClient();
    const result = await db.updateInvestigationStatus('missing-id', 'running', {}, { client });
    assert.strictEqual(result.success, false);
  });
});

describe('dossier persistence', () => {
  test('creates and retrieves the initial dossier', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const created = await db.createInitialDossier(investigation.id, { domain: 'example.com' }, { client });
    assert.strictEqual(created.success, true);
    assert.strictEqual(created.dossier.version, 1);

    const fetched = await db.getDossier(investigation.id, { client });
    assert.strictEqual(fetched.investigationId, investigation.id);
    assert.deepStrictEqual(fetched.workingState.target, { name: null, domain: 'example.com' });
  });

  test('updateDossier increments version and rejects a malformed working state', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.createInitialDossier(investigation.id, { domain: 'example.com' }, { client });

    const current = await db.getDossier(investigation.id, { client });
    current.workingState.overallConfidence = 'medium';
    const updated = await db.updateDossier(investigation.id, current.workingState, { client });
    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.dossier.version, 2);

    const malformed = await db.updateDossier(investigation.id, { not: 'a dossier' }, { client });
    assert.strictEqual(malformed.success, false);
  });
});

describe('append-only logs', () => {
  test('appendClaim persists a claim with an honest null value for a not-found field', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.appendClaim({
      investigationId: investigation.id, claimType: 'identity', field: 'companyNumber', value: null, confidence: 'high',
    }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.claim.value, null);
    assert.strictEqual(result.claim.status, 'active');
  });

  test('appendClaim rejects invalid confidence without persisting anything', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.appendClaim({
      investigationId: investigation.id, claimType: 'identity', field: 'x', value: 'y', confidence: 'certain',
    }, { client });
    assert.strictEqual(result.success, false);
  });

  test('appendEvidence persists provenance fields', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.appendEvidence({
      investigationId: investigation.id,
      sourceUrl: 'https://example.com/about',
      retrievedAt: '2026-07-14T00:00:00.000Z',
      evidenceClass: 'public',
      contextExcerpt: 'Founded in 2014.',
    }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.evidence.evidenceClass, 'public');
    assert.strictEqual(result.evidence.sourceUrlNormalised, 'example.com/about');
  });

  test('appendRelationshipObservation requires explicit direction, never inferred from type', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const missingDirection = await db.appendRelationshipObservation({
      investigationId: investigation.id,
      subjectOrganisation: 'Example Ltd',
      thirdPartyName: 'FCA',
      relationshipType: 'regulator',
      confidence: 'high',
      relationshipConfidenceState: 'verified',
    }, { client });
    assert.strictEqual(missingDirection.success, false);

    const withDirection = await db.appendRelationshipObservation({
      investigationId: investigation.id,
      subjectOrganisation: 'Example Ltd',
      thirdPartyName: 'FCA',
      relationshipType: 'regulator',
      relationshipDirection: 'outbound',
      confidence: 'high',
      relationshipConfidenceState: 'verified',
    }, { client });
    assert.strictEqual(withDirection.success, true);
    assert.strictEqual(withDirection.relationshipObservation.relationshipDirection, 'outbound');
  });

  test('appendDiscovery records a candidate future investigation, never a canonical record', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.appendDiscovery({
      investigationId: investigation.id,
      discoveredName: 'GRC Consultants Ltd',
      discoveryReason: 'Named as certifying body on target\'s website',
    }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.discovery.eligibleForFutureInvestigation, true);
  });

  test('appendAgentEvent rejects an unknown event type', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const result = await db.appendAgentEvent({ investigationId: investigation.id, eventType: 'made_up', stepNumber: 0 }, { client });
    assert.strictEqual(result.success, false);
  });

  test('append-only tables reject an UPDATE (simulating the database trigger)', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.appendClaim({ investigationId: investigation.id, claimType: 'identity', field: 'legalName', value: 'Example Ltd', confidence: 'high' }, { client });

    const { error } = await client.from('commercial_claims').update({ value: 'Something else' }).eq('investigation_id', investigation.id).select('*').single();
    assert.ok(error);
    assert.match(error.message, /append-only/);
  });
});

describe('draft lifecycle', () => {
  test('a new draft starts pending and can be approved', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    const created = await db.createDraft({ investigationId: investigation.id, content: { target: { domain: 'example.com' } } }, { client });
    assert.strictEqual(created.draft.reviewState, 'pending');

    const reviewed = await db.reviewDraft(investigation.id, { reviewState: 'approved', reviewedBy: 'founder' }, { client });
    assert.strictEqual(reviewed.success, true);
    assert.strictEqual(reviewed.draft.reviewState, 'approved');
    assert.strictEqual(reviewed.draft.reviewedBy, 'founder');
  });

  test('rejecting without a reason is refused', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.createDraft({ investigationId: investigation.id, content: {} }, { client });
    const result = await db.reviewDraft(investigation.id, { reviewState: 'rejected' }, { client });
    assert.strictEqual(result.success, false);
  });

  test('approving a draft never touches any canonical table — only this module\'s own tables are used', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.createDraft({ investigationId: investigation.id, content: {} }, { client });
    await db.reviewDraft(investigation.id, { reviewState: 'approved', reviewedBy: 'founder' }, { client });
    const knownTables = Object.keys(client._tables);
    assert.ok(knownTables.every((t) => t.startsWith('commercial_')));
  });
});

describe('getInvestigationBundle', () => {
  test('returns one object containing every part of the investigation', async () => {
    const client = createFakeClient();
    const { investigation } = await db.createInvestigation({ domain: 'example.com' }, { client });
    await db.createInitialDossier(investigation.id, { domain: 'example.com' }, { client });
    await db.appendClaim({ investigationId: investigation.id, claimType: 'identity', field: 'legalName', value: 'Example Ltd', confidence: 'high' }, { client });
    await db.appendEvidence({ investigationId: investigation.id, sourceUrl: 'https://example.com', retrievedAt: '2026-07-14T00:00:00.000Z', evidenceClass: 'public' }, { client });
    await db.appendRelationshipObservation({
      investigationId: investigation.id, subjectOrganisation: 'Example Ltd', thirdPartyName: 'FCA',
      relationshipType: 'regulator', relationshipDirection: 'outbound', confidence: 'high', relationshipConfidenceState: 'verified',
    }, { client });
    await db.appendDiscovery({ investigationId: investigation.id, discoveredName: 'GRC Consultants Ltd', discoveryReason: 'mentioned as certifier' }, { client });
    await db.appendAgentEvent({ investigationId: investigation.id, eventType: 'investigation_created', stepNumber: 0 }, { client });
    await db.createDraft({ investigationId: investigation.id, content: { target: { domain: 'example.com' } } }, { client });

    const result = await db.getInvestigationBundle(investigation.id, { client });
    assert.strictEqual(result.success, true);
    const { bundle } = result;
    assert.strictEqual(bundle.investigation.id, investigation.id);
    assert.ok(bundle.dossier);
    assert.strictEqual(bundle.claims.length, 1);
    assert.strictEqual(bundle.evidence.length, 1);
    assert.strictEqual(bundle.relationshipObservations.length, 1);
    assert.strictEqual(bundle.discoveries.length, 1);
    assert.strictEqual(bundle.agentEvents.length, 1);
    assert.strictEqual(bundle.draft.reviewState, 'pending');
  });

  test('returns a structured failure for an unknown investigation id', async () => {
    const client = createFakeClient();
    const result = await db.getInvestigationBundle('missing-id', { client });
    assert.strictEqual(result.success, false);
  });
});

describe('listRecentInvestigations', () => {
  test('returns investigations newest-first, bounded by limit', async () => {
    const client = createFakeClient();
    await db.createInvestigation({ domain: 'a.example.com' }, { client });
    await db.createInvestigation({ domain: 'b.example.com' }, { client });
    await db.createInvestigation({ domain: 'c.example.com' }, { client });

    const result = await db.listRecentInvestigations({ limit: 2 }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.investigations.length, 2);
  });

  test('returns an empty list, never throws, when there are no investigations', async () => {
    const client = createFakeClient();
    const result = await db.listRecentInvestigations({}, { client });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.investigations, []);
  });
});

describe('getObservatoryStats', () => {
  test('counts investigations by status and computes averages across completed investigations only', async () => {
    const client = createFakeClient();

    const a = await db.createInvestigation({ domain: 'a.example.com' }, { client });
    await db.updateInvestigationStatus(a.investigation.id, 'running', { startedAt: '2026-07-15T00:00:00.000Z' }, { client });
    await db.updateInvestigationStatus(a.investigation.id, 'completed', { completedAt: '2026-07-15T00:00:10.000Z' }, { client });
    await db.appendEvidence({ investigationId: a.investigation.id, sourceUrl: 'https://a.example.com', retrievedAt: '2026-07-15T00:00:00.000Z', evidenceClass: 'public' }, { client });
    await db.appendEvidence({ investigationId: a.investigation.id, sourceUrl: 'https://a.example.com/2', retrievedAt: '2026-07-15T00:00:00.000Z', evidenceClass: 'public' }, { client });
    await db.appendDiscovery({ investigationId: a.investigation.id, discoveredName: 'Some Firm', discoveryReason: 'linked' }, { client });

    const b = await db.createInvestigation({ domain: 'b.example.com' }, { client });
    await db.updateInvestigationStatus(b.investigation.id, 'running', {}, { client });

    const c = await db.createInvestigation({ domain: 'c.example.com' }, { client });
    await db.updateInvestigationStatus(c.investigation.id, 'running', {}, { client });
    await db.updateInvestigationStatus(c.investigation.id, 'failed', {}, { client });

    const result = await db.getObservatoryStats({ client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.statusCounts.completed, 1);
    assert.strictEqual(result.statusCounts.running, 1);
    assert.strictEqual(result.statusCounts.failed, 1);
    assert.strictEqual(result.averages.durationSeconds, 10);
    assert.strictEqual(result.averages.evidence, 2);
    assert.strictEqual(result.averages.discoveries, 1);
  });

  test('returns null averages, never throws, when there are no completed investigations', async () => {
    const client = createFakeClient();
    await db.createInvestigation({ domain: 'a.example.com' }, { client });
    const result = await db.getObservatoryStats({ client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.averages.durationSeconds, null);
    assert.strictEqual(result.averages.evidence, null);
  });
});

describe('getPortfolio', () => {
  test('returns one row per investigation with counts, draft state, duration and completeness', async () => {
    const client = createFakeClient();
    const created = await db.createInvestigation({ name: 'Compliance Office', domain: 'complianceoffice.co.uk' }, { client });
    const investigationId = created.investigation.id;
    await db.createInitialDossier(investigationId, { name: 'Compliance Office', domain: 'complianceoffice.co.uk' }, { client });

    const dossier = await db.getDossier(investigationId, { client });
    await db.updateDossier(investigationId, {
      ...dossier.workingState,
      agentResearchQuestions: [
        { id: 'q1', status: 'resolved' },
        { id: 'q2', status: 'resolved' },
        { id: 'q3', status: 'open' },
        { id: 'q4', status: 'open' },
      ],
    }, { client });

    await db.updateInvestigationStatus(investigationId, 'running', { startedAt: '2026-07-15T00:00:00.000Z' }, { client });
    await db.updateInvestigationStatus(investigationId, 'completed', { completedAt: '2026-07-15T00:00:20.000Z' }, { client });

    await db.appendEvidence({ investigationId, sourceUrl: 'https://complianceoffice.co.uk', retrievedAt: '2026-07-15T00:00:00.000Z', evidenceClass: 'public' }, { client });
    await db.appendClaim({ investigationId, claimType: 'identity', field: 'legalName', value: 'Compliance Office Ltd', confidence: 'high', evidenceIds: [] }, { client });
    await db.appendRelationshipObservation({ investigationId, subjectOrganisation: 'Compliance Office', thirdPartyName: 'SRA', relationshipType: 'regulator', relationshipDirection: 'outbound', confidence: 'high', relationshipConfidenceState: 'verified' }, { client });
    await db.appendDiscovery({ investigationId, discoveredName: 'Some Firm', discoveryReason: 'linked' }, { client });
    await db.createDraft({ investigationId, content: { target: { name: 'Compliance Office' } } }, { client });

    const result = await db.getPortfolio({}, { client });
    assert.strictEqual(result.success, true);
    const row = result.investigations.find((r) => r.id === investigationId);
    assert.ok(row);
    assert.strictEqual(row.targetName, 'Compliance Office');
    assert.strictEqual(row.evidenceCount, 1);
    assert.strictEqual(row.claimCount, 1);
    assert.strictEqual(row.relationshipCount, 1);
    assert.strictEqual(row.discoveryCount, 1);
    assert.strictEqual(row.draftState, 'pending');
    assert.strictEqual(row.completeness, 50);
    assert.strictEqual(row.openQuestionsRemaining, 2);
    assert.strictEqual(row.durationSeconds, 20);
  });

  test('handles an investigation with no dossier/draft/evidence yet — never throws, no fabricated completeness', async () => {
    const client = createFakeClient();
    const created = await db.createInvestigation({ domain: 'bare.example.com' }, { client });
    const result = await db.getPortfolio({}, { client });
    assert.strictEqual(result.success, true);
    const row = result.investigations.find((r) => r.id === created.investigation.id);
    assert.ok(row);
    assert.strictEqual(row.evidenceCount, 0);
    assert.strictEqual(row.draftState, 'none');
    assert.strictEqual(row.completeness, null);
    assert.strictEqual(row.durationSeconds, null);
  });
});
