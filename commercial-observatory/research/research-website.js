'use strict';

// research-website — the first deterministic website-research vertical
// slice (execution architecture design, §F decision loop, applied once,
// deterministically, without an LLM). No autonomous looping: homepage plus
// a bounded, ranked set of internal pages, entity/relationship detection
// against explicit page content only, and a dossier update. Produces no
// Commercial Authority draft — that requires interpretation this
// deterministic pass does not perform.

const urlPolicy = require('../sources/url-policy');
const { fetchUrl: defaultFetchUrl } = require('../sources/web-fetch');
const { extractHtml: defaultExtractHtml } = require('../sources/html-extract');
const { selectResearchPages: defaultSelectResearchPages, CATEGORY_KEYWORDS } = require('./page-selection');
const { detectEntities: defaultDetectEntities } = require('./entity-detection');
const { contentHash, normaliseSourceUrl } = require('../domain/evidence');
const { normaliseName } = require('../../authority/lib/normalise');
const persistence = require('../persistence/db');
const logger = require('../../infra/utils/logger');

const CATEGORY_LIST = CATEGORY_KEYWORDS.map((c) => c.category);

const CATEGORY_QUESTIONS = Object.freeze({
  about: 'What does the organisation say about itself (About / Who We Are)?',
  services: 'What services/expertise does the organisation offer?',
  sectors: 'Which sectors/industries does the organisation serve?',
  people: 'Who leads the organisation (team/leadership)?',
  partners: 'Which organisations are named as partners?',
  clients: 'Which clients or client sectors does the organisation reference?',
  credentials: 'What memberships, accreditations or regulatory status does the organisation hold?',
  content: 'What thought-leadership content (insights/articles/news) has the organisation published?',
});

// Common social/profile platforms a link to which is not itself a
// candidate co-party organisation (it's the target's own public profile).
const SOCIAL_PLATFORM_DOMAINS = Object.freeze(['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'g.co', 'goo.gl']);

function isSocialPlatform(domain) {
  return !!domain && SOCIAL_PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * researchWebsite(investigationId, deps) -> Promise<Result>
 *
 * deps: { client, fetchUrl, extractHtml, selectResearchPages, detectEntities, now }
 * — every dependency is injectable so tests never touch the network.
 */
async function researchWebsite(investigationId, deps = {}) {
  const {
    client,
    fetchUrl = defaultFetchUrl,
    extractHtml = defaultExtractHtml,
    selectResearchPages = defaultSelectResearchPages,
    detectEntities = defaultDetectEntities,
    now = () => new Date().toISOString(),
  } = deps;
  const pDeps = client ? { client } : {};

  // 1. Load investigation + dossier (+ existing evidence/events for rerun dedup and step numbering)
  const bundleResult = await persistence.getInvestigationBundle(investigationId, pDeps);
  if (!bundleResult.success) return { success: false, error: bundleResult.error };

  const { investigation } = bundleResult.bundle;
  const dossierRow = bundleResult.bundle.dossier;
  if (!dossierRow) return { success: false, error: 'Dossier not found for investigation' };
  const workingState = dossierRow.workingState;
  const existingEvidence = [...bundleResult.bundle.evidence];
  const existingDiscoveries = [...bundleResult.bundle.discoveries];
  let stepNumber = bundleResult.bundle.agentEvents.length;

  // 2. Confirm the investigation has a target domain
  const domain = investigation.targetDomainNormalised || investigation.targetDomain;
  if (!domain) {
    await persistence.appendAgentEvent({ investigationId, eventType: 'tool_call_failed', stepNumber: stepNumber++, payload: { reason: 'no_target_domain' } }, pDeps);
    await persistence.updateInvestigationStatus(investigationId, investigation.status === 'pending' ? 'failed' : investigation.status, { failureReason: 'Investigation has no target domain to research', completedAt: now() }, pDeps);
    return { success: false, error: 'Investigation has no target domain to research' };
  }
  if (investigation.status === 'cancelled') {
    return { success: false, error: 'Investigation is cancelled and cannot be researched' };
  }

  // 3. Transition status to running
  const runTransition = await persistence.updateInvestigationStatus(investigationId, 'running', { startedAt: investigation.startedAt || now() }, pDeps);
  if (!runTransition.success) return { success: false, error: runTransition.error };

  // 4. research_started event — no 'research_started' value exists in the
  // agent_event_type enum (constants.js); mapped onto the closest existing
  // type ('session_started') with a `phase` payload field, to avoid
  // altering the migration 050 CHECK constraint for this task.
  await persistence.appendAgentEvent({ investigationId, eventType: 'session_started', stepNumber: stepNumber++, payload: { phase: 'research_started', domain } }, pDeps);

  const failures = [];
  let evidenceCreated = 0;
  const pagesVisited = [];
  const pagesRejected = [];
  const subjectName = investigation.targetName || investigation.targetDomain;

  function existingEvidenceMatch(sourceUrl, hash) {
    const normalised = normaliseSourceUrl(sourceUrl);
    return existingEvidence.find((e) => e.sourceUrlNormalised === normalised && e.contentHash === hash);
  }

  async function recordEvidence({ sourceUrl, retrievedAt, body, sourceTitle, contextExcerpt }) {
    const hash = contentHash(body);
    const dup = existingEvidenceMatch(sourceUrl, hash);
    if (dup) return { evidenceId: dup.id, isNew: false };
    const result = await persistence.appendEvidence({
      investigationId, sourceUrl, retrievedAt, evidenceClass: 'public',
      contextExcerpt: contextExcerpt || null, sourceTitle: sourceTitle || null, rawContent: body,
    }, pDeps);
    if (!result.success) return { evidenceId: null, isNew: false, error: result.error };
    existingEvidence.push(result.evidence);
    evidenceCreated += 1;
    return { evidenceId: result.evidence.id, isNew: true };
  }

  // 5/6. Build and fetch the homepage — HTTPS first
  const httpsUrl = `https://${domain}/`;
  let homepageFetch = await fetchUrl(httpsUrl, {});
  let homepageUrlUsed = httpsUrl;

  // 7. HTTP fallback, once, only if HTTPS failed safely
  if (!homepageFetch.success) {
    const httpUrl = `http://${domain}/`;
    const httpFallback = await fetchUrl(httpUrl, {});
    await persistence.appendAgentEvent({ investigationId, eventType: 'tool_call_failed', stepNumber: stepNumber++, payload: { url: httpsUrl, ...homepageFetch } }, pDeps);
    if (httpFallback.success) {
      homepageFetch = httpFallback;
      homepageUrlUsed = httpUrl;
    } else {
      await persistence.appendAgentEvent({ investigationId, eventType: 'tool_call_failed', stepNumber: stepNumber++, payload: { url: httpUrl, ...httpFallback } }, pDeps);
      await persistence.updateInvestigationStatus(investigationId, 'failed', { failureReason: `Homepage unreachable over HTTPS and HTTP: ${homepageFetch.error}`, completedAt: now(), stepCount: stepNumber }, pDeps);
      return {
        success: false, investigationId, status: 'failed',
        homepage: { url: httpsUrl, httpsResult: homepageFetch, httpFallbackResult: httpFallback },
        pagesSelected: [], pagesVisited: [], pagesRejected: [], evidenceCreated: 0,
        relationshipObservationsCreated: [], discoveriesCreated: [], unansweredQuestions: workingState.unansweredQuestions,
        completeness: workingState.completeness, failures: [{ stage: 'homepage_fetch', error: homepageFetch.error }, { stage: 'homepage_fetch_http_fallback', error: httpFallback.error }],
      };
    }
  }

  // 8. Extract the homepage
  const homepageExtracted = extractHtml(homepageFetch.body, homepageFetch.finalUrl);

  // 9. Append provenance-backed evidence for the homepage
  const homepageEvidence = await recordEvidence({
    sourceUrl: homepageFetch.finalUrl, retrievedAt: homepageFetch.retrievedAt, body: homepageFetch.body,
    sourceTitle: homepageExtracted.title, contextExcerpt: homepageExtracted.metaDescription || homepageExtracted.title || null,
  });
  if (homepageEvidence.error) failures.push({ stage: 'evidence', page: homepageFetch.finalUrl, error: homepageEvidence.error });
  await persistence.appendAgentEvent({ investigationId, eventType: 'evidence_stored', stepNumber: stepNumber++, payload: { url: homepageFetch.finalUrl, evidenceId: homepageEvidence.evidenceId, isNew: homepageEvidence.isNew } }, pDeps);

  // 10. Record the homepage in pagesVisited
  pagesVisited.push({ url: homepageFetch.finalUrl, category: 'homepage', evidenceId: homepageEvidence.evidenceId, retrievedAt: homepageFetch.retrievedAt });

  // 11. Select up to 8 high-value internal pages
  const { selected, rejected } = selectResearchPages(homepageFetch.finalUrl, homepageExtracted.internalLinks, { rootDomain: domain, maxAdditionalPages: urlPolicy.MAX_ADDITIONAL_PAGES });

  // 12. Record rejected pages and reasons
  pagesRejected.push(...rejected.map((r) => ({ url: r.url, label: r.label, reason: r.reason })));

  // 13-15. Fetch selected pages sequentially, extract, append evidence
  const pagesForDetection = [{ sourceUrl: homepageFetch.finalUrl, extracted: homepageExtracted, evidenceId: homepageEvidence.evidenceId }];

  for (const candidate of selected) {
    const pageFetch = await fetchUrl(candidate.url, {});
    if (!pageFetch.success) {
      failures.push({ stage: 'fetch', page: candidate.url, error: pageFetch.error, errorType: pageFetch.errorType });
      pagesRejected.push({ url: candidate.url, label: candidate.label, reason: `fetch_failed:${pageFetch.errorType}` });
      await persistence.appendAgentEvent({ investigationId, eventType: 'tool_call_failed', stepNumber: stepNumber++, payload: { url: candidate.url, ...pageFetch } }, pDeps);
      continue; // one secondary page failing does not stop the others
    }
    const extracted = extractHtml(pageFetch.body, pageFetch.finalUrl);
    const evidence = await recordEvidence({
      sourceUrl: pageFetch.finalUrl, retrievedAt: pageFetch.retrievedAt, body: pageFetch.body,
      sourceTitle: extracted.title, contextExcerpt: extracted.metaDescription || extracted.title || null,
    });
    if (evidence.error) failures.push({ stage: 'evidence', page: pageFetch.finalUrl, error: evidence.error });
    await persistence.appendAgentEvent({ investigationId, eventType: 'evidence_stored', stepNumber: stepNumber++, payload: { url: pageFetch.finalUrl, evidenceId: evidence.evidenceId, isNew: evidence.isNew } }, pDeps);

    pagesVisited.push({ url: pageFetch.finalUrl, category: candidate.category, evidenceId: evidence.evidenceId, retrievedAt: pageFetch.retrievedAt });
    pagesForDetection.push({ sourceUrl: pageFetch.finalUrl, extracted, evidenceId: evidence.evidenceId });
  }

  // 16. Detect explicit entities and co-parties, merged across all fetched pages
  const relationshipMap = new Map();
  const contextualObservations = [];
  const linkedOrgMap = new Map();

  for (const p of pagesForDetection) {
    const detection = detectEntities({ sourceUrl: p.sourceUrl, extracted: p.extracted }, { subjectName });

    for (const c of detection.relationshipCandidates) {
      const key = `${c.normalisedName}|${c.relationshipType}|${c.relationshipDirection}`;
      if (!relationshipMap.has(key)) {
        relationshipMap.set(key, { ...c, evidenceIds: p.evidenceId ? [p.evidenceId] : [] });
      } else {
        const existing = relationshipMap.get(key);
        if (p.evidenceId && !existing.evidenceIds.includes(p.evidenceId)) existing.evidenceIds.push(p.evidenceId);
        // Corroboration across independently-fetched pages raises confidence one step (hypothesis -> probable).
        if (existing.evidenceIds.length > 1 && existing.relationshipConfidenceState === 'hypothesis') {
          existing.relationshipConfidenceState = 'probable';
        }
      }
    }
    for (const m of detection.contextualMentions) {
      contextualObservations.push({ ...m, evidenceId: p.evidenceId });
    }
    for (const lo of detection.linkedOrganisations) {
      if (isSocialPlatform(lo.domain)) continue;
      const key = lo.domain || normaliseName(lo.rawName);
      if (!linkedOrgMap.has(key)) linkedOrgMap.set(key, { ...lo, sourceUrls: [lo.sourceUrl] });
      else if (!linkedOrgMap.get(key).sourceUrls.includes(lo.sourceUrl)) linkedOrgMap.get(key).sourceUrls.push(lo.sourceUrl);
    }
  }

  // 17. Append valid relationship observations — skip any candidate that
  // duplicates an already-persisted observation (same entity, type and
  // direction), so a rerun over unchanged pages never re-inserts what an
  // earlier session already recorded.
  const existingRelationshipKeys = new Set(
    bundleResult.bundle.relationshipObservations.map((r) => `${normaliseName(r.thirdPartyName)}|${r.relationshipType}|${r.relationshipDirection}`),
  );
  const relationshipObservationsCreated = [];
  for (const candidate of relationshipMap.values()) {
    const key = `${candidate.normalisedName}|${candidate.relationshipType}|${candidate.relationshipDirection}`;
    if (existingRelationshipKeys.has(key)) continue;
    const result = await persistence.appendRelationshipObservation({
      investigationId,
      subjectOrganisation: subjectName,
      thirdPartyName: candidate.rawName,
      thirdPartyDomain: candidate.domain || null,
      thirdPartyDomainNormalised: candidate.domain || null,
      relationshipType: candidate.relationshipType,
      relationshipDirection: candidate.relationshipDirection,
      confidence: candidate.confidence,
      relationshipConfidenceState: candidate.relationshipConfidenceState,
      contextExcerpt: candidate.contextExcerpt,
      evidenceReferences: candidate.evidenceIds,
    }, pDeps);
    if (result.success) {
      relationshipObservationsCreated.push(result.relationshipObservation);
      await persistence.appendAgentEvent({ investigationId, eventType: 'relationship_observed', stepNumber: stepNumber++, payload: { thirdPartyName: candidate.rawName, relationshipType: candidate.relationshipType, relationshipDirection: candidate.relationshipDirection } }, pDeps);
    } else {
      failures.push({ stage: 'relationship_observation', entity: candidate.rawName, error: result.error });
    }
  }

  // 18. Append eligible discoveries — linked organisations not already
  // captured as a relationship observation, excluding the target's own
  // social-media profile links, and not already discovered by an earlier
  // session (dedup by normalised domain, or normalised name where no
  // domain is known) so a rerun over unchanged pages never duplicates.
  const existingDiscoveryKeys = new Set(
    existingDiscoveries.map((d) => d.discoveredDomainNormalised || d.discoveredNameNormalised),
  );
  const discoveriesCreated = [];
  for (const lo of linkedOrgMap.values()) {
    const alreadyRelationship = [...relationshipMap.values()].some(
      (c) => (lo.domain && c.domain === lo.domain) || c.normalisedName === normaliseName(lo.rawName),
    );
    if (alreadyRelationship) continue;
    const discoveryKey = lo.domain || normaliseName(lo.rawName);
    if (existingDiscoveryKeys.has(discoveryKey)) continue;
    const result = await persistence.appendDiscovery({
      investigationId,
      discoveredName: lo.rawName,
      discoveredDomain: lo.domain || null,
      discoveryReason: `Linked from ${lo.sourceUrls[0]}`,
      proposedRelationshipType: 'unclassified',
      eligibleForFutureInvestigation: true,
    }, pDeps);
    if (result.success) {
      discoveriesCreated.push(result.discovery);
      await persistence.appendAgentEvent({ investigationId, eventType: 'discovery_emitted', stepNumber: stepNumber++, payload: { name: lo.rawName, domain: lo.domain || null } }, pDeps);
    } else {
      failures.push({ stage: 'discovery', entity: lo.rawName, error: result.error });
    }
  }

  // 19/20. Update the dossier: observations, pagesVisited/Rejected,
  // relationship/discovery summaries, unanswered questions, completeness.
  const coveredCategories = new Set(pagesVisited.map((p) => p.category).filter((c) => c && c !== 'homepage'));
  const missingCategories = CATEGORY_LIST.filter((c) => !coveredCategories.has(c));
  const completeness = CATEGORY_LIST.length ? Math.round(((CATEGORY_LIST.length - missingCategories.length) / CATEGORY_LIST.length) * 100) / 100 : 0;

  const newQuestions = missingCategories.map((c) => CATEGORY_QUESTIONS[c]).filter(Boolean);

  // Dedup contextual observations against what an earlier session already
  // recorded (same entity, same detection method, same source page) so a
  // rerun over unchanged pages does not keep growing this list forever.
  const existingObservationKeys = new Set(
    (workingState.observations || []).map((o) => `${o.normalisedName}|${o.detectionMethod}|${o.sourceUrl}`),
  );
  const newContextualObservations = contextualObservations
    .map((o) => ({
      type: 'contextual_reference', rawName: o.rawName, normalisedName: o.normalisedName,
      sourceUrl: o.sourceUrl, contextExcerpt: o.contextExcerpt, detectionMethod: o.detectionMethod, evidenceId: o.evidenceId || null,
    }))
    .filter((o) => !existingObservationKeys.has(`${o.normalisedName}|${o.detectionMethod}|${o.sourceUrl}`));

  const updatedWorkingState = {
    ...workingState,
    observations: [...workingState.observations, ...newContextualObservations],
    pagesVisited: [...workingState.pagesVisited, ...pagesVisited],
    pagesRejected: [...workingState.pagesRejected, ...pagesRejected],
    relationshipObservations: [
      ...workingState.relationshipObservations,
      ...relationshipObservationsCreated.map((r) => ({ id: r.id, thirdPartyName: r.thirdPartyName, relationshipType: r.relationshipType, relationshipDirection: r.relationshipDirection })),
    ],
    discoveredOrganisations: [
      ...workingState.discoveredOrganisations,
      ...discoveriesCreated.map((d) => ({ id: d.id, name: d.discoveredName, domain: d.discoveredDomain })),
    ],
    unansweredQuestions: Array.from(new Set([...workingState.unansweredQuestions, ...newQuestions])),
    overallConfidence: relationshipObservationsCreated.length > 0 ? (workingState.overallConfidence || 'low') : (workingState.overallConfidence ?? 'low'),
    completeness,
    completionNotes: failures.length
      ? `Deterministic website research completed with ${failures.length} page-level failure(s).`
      : 'Deterministic website research completed: homepage and selected internal pages inspected.',
  };

  const dossierUpdate = await persistence.updateDossier(investigationId, updatedWorkingState, pDeps);
  if (!dossierUpdate.success) failures.push({ stage: 'dossier_update', error: dossierUpdate.error });

  // 21/22. Final status and closing agent event
  const finalStatus = failures.length > 0 ? 'partial' : 'completed';
  await persistence.appendAgentEvent({
    investigationId, eventType: 'session_ended', stepNumber: stepNumber++,
    payload: { phase: finalStatus === 'completed' ? 'research_completed' : 'research_partial', evidenceCreated, relationshipObservations: relationshipObservationsCreated.length, discoveries: discoveriesCreated.length, failures: failures.length },
  }, pDeps);

  const statusTransition = await persistence.updateInvestigationStatus(investigationId, finalStatus, {
    completedAt: now(),
    stepCount: stepNumber,
    sourceCount: pagesVisited.length,
    failureReason: finalStatus === 'partial' ? failures.map((f) => `${f.stage}: ${f.error || f.errorType || 'failed'}`).join('; ') : null,
  }, pDeps);
  if (!statusTransition.success) {
    logger.error(`researchWebsite: final status transition failed for ${investigationId}: ${statusTransition.error}`);
  }

  return {
    success: true,
    investigationId,
    status: finalStatus,
    homepage: { url: homepageUrlUsed, result: { success: true, status: homepageFetch.status, finalUrl: homepageFetch.finalUrl } },
    pagesSelected: selected,
    pagesVisited,
    pagesRejected,
    evidenceCreated,
    relationshipObservationsCreated,
    discoveriesCreated,
    contextualMentions: contextualObservations,
    unansweredQuestions: updatedWorkingState.unansweredQuestions,
    completeness: updatedWorkingState.completeness,
    failures,
  };
}

module.exports = { researchWebsite, CATEGORY_LIST, CATEGORY_QUESTIONS };
