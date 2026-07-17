'use strict';

// Commercial Observatory — persistence module (MVP-0 foundation).
//
// Follows the existing backend/infra/database.js conventions exactly: the
// existing Supabase client mechanism is reused (imported, not duplicated),
// every function accepts an injectable trailing `deps.client` for tests,
// expected persistence failures are returned as {success:false, error}
// rather than thrown, and failures are logged through the existing logger.
// This module intentionally does NOT add Commercial Observatory functions
// to infra/database.js itself — it is its own, separately bounded
// persistence surface (see the founder's BOUNDARIES instruction).
//
// No function here writes into any canonical Organisation Authority or
// Commercial Authority table — every table this module touches is prefixed
// `commercial_` and defined in migration 050, isolated from `organisation`,
// `authority`, `collection`, and every canonical registry.

const { getClient } = require('../../infra/database');
const logger = require('../../infra/utils/logger');

const { validateNewInvestigationInput, buildNewInvestigationRecord, validateStatusTransition } = require('../domain/investigation');
const { createInitialDossier: buildInitialDossierState, validateDossierShape } = require('../domain/dossier');
const { buildClaimRecord } = require('../domain/claim');
const { buildEvidenceRecord } = require('../domain/evidence');
const { buildRelationshipObservationRecord } = require('../domain/relationship-observation');
const { buildDiscoveryRecord } = require('../domain/discovery');
const { buildAgentEventRecord } = require('../domain/agent-event');
const { buildDraftRecord, validateReviewDecision } = require('../domain/draft');

function client(deps) {
  return (deps && deps.client) || getClient();
}

// ── Investigations ────────────────────────────────────────────────────────

async function createInvestigation({ name, domain, normalisedDomain, rerunOf = null } = {}, deps = {}) {
  const { valid, errors } = validateNewInvestigationInput({ name, domain });
  if (!valid) return { success: false, error: errors.join('; ') };

  const record = buildNewInvestigationRecord({ name, domain, normalisedDomain, rerunOf });
  try {
    const { data, error } = await client(deps)
      .from('commercial_investigations')
      .insert([{
        target_name: record.targetName,
        target_domain: record.targetDomain,
        target_domain_normalised: record.targetDomainNormalised,
        status: record.status,
        rerun_of: record.rerunOf,
        step_count: record.stepCount,
        source_count: record.sourceCount,
      }])
      .select('*')
      .single();

    if (error) {
      logger.error(`createInvestigation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true, investigation: toInvestigationShape(data) };
  } catch (err) {
    logger.error(`createInvestigation threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getInvestigation(investigationId, deps = {}) {
  try {
    const { data, error } = await client(deps)
      .from('commercial_investigations')
      .select('*')
      .eq('id', investigationId)
      .maybeSingle();

    if (error) { logger.error(`getInvestigation failed: ${error.message}`); return null; }
    return data ? toInvestigationShape(data) : null;
  } catch (err) {
    logger.error(`getInvestigation threw: ${err.message}`);
    return null;
  }
}

/**
 * listRecentInvestigations({limit}) -> Investigation[] newest-first.
 * Internal-observatory operator page only — a plain, bounded list, no
 * cross-investigation joins.
 */
async function listRecentInvestigations({ limit = 20 } = {}, deps = {}) {
  try {
    const { data, error } = await client(deps)
      .from('commercial_investigations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) { logger.error(`listRecentInvestigations failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, investigations: (data || []).map(toInvestigationShape) };
  } catch (err) {
    logger.error(`listRecentInvestigations threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * getObservatoryStats() -> { statusCounts, averages } across ALL
 * investigations — internal-observatory operator page only. Averages are
 * computed as total-rows-across-every-investigation ÷ completed-investigation-
 * count, an honest whole-population mean, not a per-investigation median.
 */
async function getObservatoryStats(deps = {}) {
  try {
    const c = client(deps);
    const [investigationsRes, evidenceRes, relationshipsRes, discoveriesRes] = await Promise.all([
      c.from('commercial_investigations').select('status, started_at, completed_at'),
      c.from('commercial_evidence').select('id', { count: 'exact', head: true }),
      c.from('commercial_relationship_observations').select('id', { count: 'exact', head: true }),
      c.from('commercial_discoveries').select('id', { count: 'exact', head: true }),
    ]);

    if (investigationsRes.error) { logger.error(`getObservatoryStats failed: ${investigationsRes.error.message}`); return { success: false, error: investigationsRes.error.message }; }

    const rows = investigationsRes.data || [];
    const statusCounts = {};
    for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;

    const completedRows = rows.filter((r) => r.status === 'completed' && r.started_at && r.completed_at);
    const completedCount = completedRows.length || null;
    const totalDurationMs = completedRows.reduce((sum, r) => sum + (new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()), 0);
    const averageDurationSeconds = completedCount ? Math.round((totalDurationMs / completedCount) / 100) / 10 : null;

    const averageOf = (res) => (completedCount && !res.error ? Math.round((res.count || 0) / completedCount) : null);

    return {
      success: true,
      statusCounts,
      averages: {
        durationSeconds: averageDurationSeconds,
        evidence: averageOf(evidenceRes),
        relationships: averageOf(relationshipsRes),
        discoveries: averageOf(discoveriesRes),
      },
    };
  } catch (err) {
    logger.error(`getObservatoryStats threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * getPortfolio({limit}) -> per-investigation detail rows for the internal
 * Investigation Portfolio page — evidence/claim/relationship/discovery
 * counts, draft state, and a deterministic completeness percentage derived
 * from the dossier's own research-question backlog (resolved ÷ total),
 * never invented. Internal-observatory operator page only.
 */
async function getPortfolio({ limit = 200 } = {}, deps = {}) {
  try {
    const c = client(deps);
    const { data: investigations, error } = await c
      .from('commercial_investigations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) { logger.error(`getPortfolio failed: ${error.message}`); return { success: false, error: error.message }; }

    const rows = await Promise.all((investigations || []).map(async (inv) => {
      const [evidenceRes, claimsRes, relationshipsRes, discoveriesRes, dossierRes, draftRes] = await Promise.all([
        c.from('commercial_evidence').select('id', { count: 'exact', head: true }).eq('investigation_id', inv.id),
        c.from('commercial_claims').select('id', { count: 'exact', head: true }).eq('investigation_id', inv.id),
        c.from('commercial_relationship_observations').select('id', { count: 'exact', head: true }).eq('investigation_id', inv.id),
        c.from('commercial_discoveries').select('id', { count: 'exact', head: true }).eq('investigation_id', inv.id),
        c.from('commercial_dossiers').select('working_state').eq('investigation_id', inv.id).maybeSingle(),
        c.from('commercial_authority_drafts').select('review_state').eq('investigation_id', inv.id).maybeSingle(),
      ]);

      const questions = (dossierRes.data && dossierRes.data.working_state && dossierRes.data.working_state.agentResearchQuestions) || [];
      const totalQuestions = questions.length;
      const openQuestionsRemaining = questions.filter((q) => q.status === 'open').length;
      const resolvedQuestions = questions.filter((q) => q.status === 'resolved').length;
      const completeness = totalQuestions > 0 ? Math.round((resolvedQuestions / totalQuestions) * 100) : null;

      const durationSeconds = inv.started_at && inv.completed_at
        ? Math.round((new Date(inv.completed_at).getTime() - new Date(inv.started_at).getTime()) / 100) / 10
        : null;

      return {
        id: inv.id,
        targetName: inv.target_name,
        targetDomain: inv.target_domain,
        createdAt: inv.created_at,
        status: inv.status,
        durationSeconds,
        evidenceCount: evidenceRes.count || 0,
        claimCount: claimsRes.count || 0,
        relationshipCount: relationshipsRes.count || 0,
        discoveryCount: discoveriesRes.count || 0,
        draftState: draftRes.data ? draftRes.data.review_state : 'none',
        completeness,
        openQuestionsRemaining,
      };
    }));

    return { success: true, investigations: rows };
  } catch (err) {
    logger.error(`getPortfolio threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function updateInvestigationStatus(investigationId, nextStatus, extra = {}, deps = {}) {
  try {
    const current = await getInvestigation(investigationId, deps);
    if (!current) return { success: false, error: 'Investigation not found' };

    const { valid, errors } = validateStatusTransition(current.status, nextStatus);
    if (!valid) return { success: false, error: errors.join('; ') };

    const update = { status: nextStatus };
    if (extra.startedAt !== undefined) update.started_at = extra.startedAt;
    if (extra.completedAt !== undefined) update.completed_at = extra.completedAt;
    if (extra.failureReason !== undefined) update.failure_reason = extra.failureReason;
    if (extra.stepCount !== undefined) update.step_count = extra.stepCount;
    if (extra.sourceCount !== undefined) update.source_count = extra.sourceCount;

    const { data, error } = await client(deps)
      .from('commercial_investigations')
      .update(update)
      .eq('id', investigationId)
      .select('*')
      .single();

    if (error) {
      logger.error(`updateInvestigationStatus failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true, investigation: toInvestigationShape(data) };
  } catch (err) {
    logger.error(`updateInvestigationStatus threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Dossier ───────────────────────────────────────────────────────────────

async function createInitialDossier(investigationId, target = {}, deps = {}) {
  const workingState = buildInitialDossierState(target);
  try {
    const { data, error } = await client(deps)
      .from('commercial_dossiers')
      .insert([{ investigation_id: investigationId, working_state: workingState, version: 1 }])
      .select('*')
      .single();

    if (error) {
      logger.error(`createInitialDossier failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true, dossier: toDossierShape(data) };
  } catch (err) {
    logger.error(`createInitialDossier threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getDossier(investigationId, deps = {}) {
  try {
    const { data, error } = await client(deps)
      .from('commercial_dossiers')
      .select('*')
      .eq('investigation_id', investigationId)
      .maybeSingle();

    if (error) { logger.error(`getDossier failed: ${error.message}`); return null; }
    return data ? toDossierShape(data) : null;
  } catch (err) {
    logger.error(`getDossier threw: ${err.message}`);
    return null;
  }
}

async function updateDossier(investigationId, newWorkingState, deps = {}) {
  const { valid, errors } = validateDossierShape(newWorkingState);
  if (!valid) return { success: false, error: errors.join('; ') };

  try {
    const { data: current, error: fetchError } = await client(deps)
      .from('commercial_dossiers')
      .select('id, version')
      .eq('investigation_id', investigationId)
      .maybeSingle();

    if (fetchError) { logger.error(`updateDossier fetch failed: ${fetchError.message}`); return { success: false, error: fetchError.message }; }
    if (!current) return { success: false, error: 'Dossier not found' };

    const { data, error } = await client(deps)
      .from('commercial_dossiers')
      .update({ working_state: newWorkingState, version: current.version + 1, updated_at: new Date().toISOString() })
      .eq('investigation_id', investigationId)
      .select('*')
      .single();

    if (error) {
      logger.error(`updateDossier failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true, dossier: toDossierShape(data) };
  } catch (err) {
    logger.error(`updateDossier threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Append-only logs: claims / evidence / relationship observations / ─────
// ── discoveries / agent events ─────────────────────────────────────────────

async function appendClaim(input, deps = {}) {
  let record;
  try {
    record = buildClaimRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_claims')
      .insert([{
        investigation_id: record.investigationId,
        claim_type: record.claimType,
        field: record.field,
        value: record.value,
        confidence: record.confidence,
        status: record.status,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`appendClaim failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, claim: toClaimShape(data) };
  } catch (err) {
    logger.error(`appendClaim threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function appendEvidence(input, deps = {}) {
  let record;
  try {
    record = buildEvidenceRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_evidence')
      .insert([{
        investigation_id: record.investigationId,
        source_url: record.sourceUrl,
        source_url_normalised: record.sourceUrlNormalised,
        retrieved_at: record.retrievedAt,
        content_hash: record.contentHash,
        evidence_class: record.evidenceClass,
        context_excerpt: record.contextExcerpt,
        source_title: record.sourceTitle,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`appendEvidence failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, evidence: toEvidenceShape(data) };
  } catch (err) {
    logger.error(`appendEvidence threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function appendRelationshipObservation(input, deps = {}) {
  let record;
  try {
    record = buildRelationshipObservationRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_relationship_observations')
      .insert([{
        investigation_id: record.investigationId,
        subject_organisation: record.subjectOrganisation,
        third_party_name: record.thirdPartyName,
        third_party_domain: record.thirdPartyDomain,
        third_party_domain_normalised: record.thirdPartyDomainNormalised,
        relationship_type: record.relationshipType,
        relationship_direction: record.relationshipDirection,
        confidence: record.confidence,
        relationship_confidence_state: record.relationshipConfidenceState,
        context_excerpt: record.contextExcerpt,
        evidence_references: record.evidenceReferences,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`appendRelationshipObservation failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, relationshipObservation: toRelationshipObservationShape(data) };
  } catch (err) {
    logger.error(`appendRelationshipObservation threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function appendDiscovery(input, deps = {}) {
  let record;
  try {
    record = buildDiscoveryRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_discoveries')
      .insert([{
        investigation_id: record.investigationId,
        discovered_name: record.discoveredName,
        discovered_domain: record.discoveredDomain,
        discovered_domain_normalised: record.discoveredDomainNormalised,
        discovered_name_normalised: record.discoveredNameNormalised,
        discovery_reason: record.discoveryReason,
        proposed_relationship_type: record.proposedRelationshipType,
        eligible_for_future_investigation: record.eligibleForFutureInvestigation,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`appendDiscovery failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, discovery: toDiscoveryShape(data) };
  } catch (err) {
    logger.error(`appendDiscovery threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function appendAgentEvent(input, deps = {}) {
  let record;
  try {
    record = buildAgentEventRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_agent_events')
      .insert([{
        investigation_id: record.investigationId,
        event_type: record.eventType,
        step_number: record.stepNumber,
        payload: record.payload,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`appendAgentEvent failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, agentEvent: toAgentEventShape(data) };
  } catch (err) {
    logger.error(`appendAgentEvent threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Draft ─────────────────────────────────────────────────────────────────

async function createDraft(input, deps = {}) {
  let record;
  try {
    record = buildDraftRecord(input);
  } catch (err) {
    return { success: false, error: err.message };
  }
  try {
    const { data, error } = await client(deps)
      .from('commercial_authority_drafts')
      .insert([{
        investigation_id: record.investigationId,
        content: record.content,
        review_state: record.reviewState,
      }])
      .select('*')
      .single();

    if (error) { logger.error(`createDraft failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, draft: toDraftShape(data) };
  } catch (err) {
    logger.error(`createDraft threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getDraft(investigationId, deps = {}) {
  try {
    const { data, error } = await client(deps)
      .from('commercial_authority_drafts')
      .select('*')
      .eq('investigation_id', investigationId)
      .maybeSingle();

    if (error) { logger.error(`getDraft failed: ${error.message}`); return null; }
    return data ? toDraftShape(data) : null;
  } catch (err) {
    logger.error(`getDraft threw: ${err.message}`);
    return null;
  }
}

/**
 * reviewDraft — the founder review action. Sets review_state/reviewed_by/
 * rejection_reason only; `content` is immutable and untouched (also
 * enforced at the database level by migration 050's protect-content
 * trigger). Never writes into any canonical Commercial Authority record.
 */
async function reviewDraft(investigationId, { reviewState, reviewedBy, rejectionReason } = {}, deps = {}) {
  const { valid, errors } = validateReviewDecision({ reviewState, rejectionReason });
  if (!valid) return { success: false, error: errors.join('; ') };

  try {
    const { data, error } = await client(deps)
      .from('commercial_authority_drafts')
      .update({
        review_state: reviewState,
        reviewed_by: reviewedBy ?? null,
        reviewed_at: new Date().toISOString(),
        rejection_reason: reviewState === 'rejected' ? rejectionReason : null,
      })
      .eq('investigation_id', investigationId)
      .select('*')
      .single();

    if (error) { logger.error(`reviewDraft failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, draft: toDraftShape(data) };
  } catch (err) {
    logger.error(`reviewDraft threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Investigation bundle (founder review view) ───────────────────────────────

async function getInvestigationBundle(investigationId, deps = {}) {
  try {
    const investigation = await getInvestigation(investigationId, deps);
    if (!investigation) return { success: false, error: 'Investigation not found' };

    const dossier = await getDossier(investigationId, deps);
    const draft = await getDraft(investigationId, deps);

    const [claimsRes, evidenceRes, relationshipsRes, discoveriesRes, eventsRes] = await Promise.all([
      client(deps).from('commercial_claims').select('*').eq('investigation_id', investigationId).order('created_at', { ascending: true }),
      client(deps).from('commercial_evidence').select('*').eq('investigation_id', investigationId).order('created_at', { ascending: true }),
      client(deps).from('commercial_relationship_observations').select('*').eq('investigation_id', investigationId).order('created_at', { ascending: true }),
      client(deps).from('commercial_discoveries').select('*').eq('investigation_id', investigationId).order('created_at', { ascending: true }),
      client(deps).from('commercial_agent_events').select('*').eq('investigation_id', investigationId).order('step_number', { ascending: true }),
    ]);

    for (const [label, res] of [['claims', claimsRes], ['evidence', evidenceRes], ['relationshipObservations', relationshipsRes], ['discoveries', discoveriesRes], ['agentEvents', eventsRes]]) {
      if (res.error) logger.error(`getInvestigationBundle: ${label} read failed: ${res.error.message}`);
    }

    return {
      success: true,
      bundle: {
        investigation,
        dossier,
        claims: (claimsRes.data ?? []).map(toClaimShape),
        evidence: (evidenceRes.data ?? []).map(toEvidenceShape),
        relationshipObservations: (relationshipsRes.data ?? []).map(toRelationshipObservationShape),
        discoveries: (discoveriesRes.data ?? []).map(toDiscoveryShape),
        agentEvents: (eventsRes.data ?? []).map(toAgentEventShape),
        draft,
      },
    };
  } catch (err) {
    logger.error(`getInvestigationBundle threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Row <-> domain shape mapping ──────────────────────────────────────────

function toInvestigationShape(row) {
  return {
    id: row.id,
    targetName: row.target_name,
    targetDomain: row.target_domain,
    targetDomainNormalised: row.target_domain_normalised,
    status: row.status,
    rerunOf: row.rerun_of,
    stepCount: row.step_count,
    sourceCount: row.source_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

function toDossierShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    workingState: row.working_state,
    version: row.version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function toClaimShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    claimType: row.claim_type,
    field: row.field,
    value: row.value,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toEvidenceShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    sourceUrl: row.source_url,
    sourceUrlNormalised: row.source_url_normalised,
    retrievedAt: row.retrieved_at,
    contentHash: row.content_hash,
    evidenceClass: row.evidence_class,
    contextExcerpt: row.context_excerpt,
    sourceTitle: row.source_title,
    createdAt: row.created_at,
  };
}

function toRelationshipObservationShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    subjectOrganisation: row.subject_organisation,
    thirdPartyName: row.third_party_name,
    thirdPartyDomain: row.third_party_domain,
    thirdPartyDomainNormalised: row.third_party_domain_normalised,
    relationshipType: row.relationship_type,
    relationshipDirection: row.relationship_direction,
    confidence: row.confidence,
    relationshipConfidenceState: row.relationship_confidence_state,
    contextExcerpt: row.context_excerpt,
    evidenceReferences: row.evidence_references,
    createdAt: row.created_at,
  };
}

function toDiscoveryShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    discoveredName: row.discovered_name,
    discoveredDomain: row.discovered_domain,
    discoveredDomainNormalised: row.discovered_domain_normalised,
    discoveredNameNormalised: row.discovered_name_normalised,
    discoveryReason: row.discovery_reason,
    proposedRelationshipType: row.proposed_relationship_type,
    eligibleForFutureInvestigation: row.eligible_for_future_investigation,
    createdAt: row.created_at,
  };
}

function toAgentEventShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    eventType: row.event_type,
    stepNumber: row.step_number,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function toDraftShape(row) {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    content: row.content,
    reviewState: row.review_state,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
  };
}

module.exports = {
  createInvestigation,
  getInvestigation,
  listRecentInvestigations,
  getObservatoryStats,
  getPortfolio,
  updateInvestigationStatus,
  createInitialDossier,
  getDossier,
  updateDossier,
  appendClaim,
  appendEvidence,
  appendRelationshipObservation,
  appendDiscovery,
  appendAgentEvent,
  createDraft,
  getDraft,
  reviewDraft,
  getInvestigationBundle,
};
