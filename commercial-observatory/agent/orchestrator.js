'use strict';

// Research Orchestrator — the bounded, auditable execution loop (Part 7).
// The planner (agent/planner.js) only ever DECIDES; this module is the
// only thing that actually calls a tool, validates its result, and
// persists anything. Every tool call — success or failure — becomes an
// auditable agent event. `dryRun` is enforced HERE, uniformly, for every
// write this orchestrator itself would otherwise make (agent events,
// dossier updates, investigation status, relationship observations) in
// addition to the per-tool dry-run checks already built into
// record_evidence/record_claim/record_discovery/finish_investigation/
// inspect_target_website — belt and braces, so "zero database writes" in
// dry-run does not depend on remembering to check the flag in one place.

const persistence = require('../persistence/db');
const { createDefaultToolRegistry } = require('./tools');
const { decidePlannerAction: defaultDecidePlannerAction } = require('./planner');
const { createLlmClient } = require('./llm-client');
const { generateInitialQuestions, refreshQuestions, resolveQuestion, dropQuestion } = require('./research-questions');
const { normaliseName } = require('../../authority/lib/normalise');
const { canonicalCoPartyKey, mergeDiscoveriesByCanonicalKey, isSocialPlatform, registrableDomainOf } = require('./co-party-identity');
const { selectSearchResults } = require('./search-result-selection');
const { extractFindings } = require('./finding-extraction');
const { extractCompaniesHouseIdentity, extractLegalNameCorroboration } = require('./identity-extraction');
const { assessDiscoveryCandidate } = require('./discovery-quality');
const { normaliseQuery } = require('./search-queries');
const { assessSource } = require('./source-intelligence/source-assessment');
const { canonicaliseUrl, canonicaliseActionKey } = require('./action-key');

// Part 6 — maps a finding category to the research question(s) it can
// resolve. A finding only ever resolves a question when it was genuinely
// ACCEPTED and evidence-backed (this map is applied only after a page's
// findings have already passed every extraction safeguard) — never merely
// because a tool was attempted.
const QUESTION_RESOLUTION_MAP = Object.freeze({
  services: ['services-provided'],
  regulatoryExpertise: ['regulatory-regimes-advised', 'regulatory-specialist-expertise'],
  clientsSectors: ['clients-sectors-served'],
  clientsNamed: ['clients-named-evidence'],
  people: ['people-leadership'],
  thoughtLeadership: ['thought-leadership-published'],
});

const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 12,
  maxSearches: 5,
  maxSearchPhaseSearches: 4,
  maxSearchResultsPerQuery: 5,
  maxFetchedSearchResultPages: 6,
  maxFetchedPerQuery: 2,
  maxFetchedPages: 20,
  maxPdfs: 3,
  maxCoPartyFollowUps: 5,
  maxCoPartyActionsEach: 2,
  maxElapsedMs: 15 * 60 * 1000,
  maxRepeatedActions: 2,
});

// The canonical-key builder now lives in action-key.js, shared with the
// pre-execution duplicate guard below — this keeps the "what makes two
// actions the same" rule in exactly one place.
function actionKeyFor(toolName, toolInput) {
  return canonicaliseActionKey({ toolName, toolInput });
}

/**
 * runResearchAgent(investigationId, options) -> Promise<Report>
 *
 * options: { dryRun (required), limits (partial override), toolRegistry,
 *   decidePlannerAction, llmClient, deps (persistence client override) }
 */
async function runResearchAgent(investigationId, options = {}) {
  if (typeof options.dryRun !== 'boolean') {
    throw new Error('runResearchAgent requires an explicit boolean options.dryRun');
  }
  const dryRun = options.dryRun;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const toolRegistry = options.toolRegistry || createDefaultToolRegistry();
  const decidePlannerAction = options.decidePlannerAction || defaultDecidePlannerAction;
  const llmClient = options.llmClient || createLlmClient();
  const pDeps = options.deps ? { client: options.deps } : {};
  const startedAt = Date.now();

  const bundleResult = await persistence.getInvestigationBundle(investigationId, pDeps);
  if (!bundleResult.success) return { success: false, error: bundleResult.error };

  const { investigation } = bundleResult.bundle;
  const dossierRow = bundleResult.bundle.dossier;
  if (!dossierRow) return { success: false, error: 'Dossier not found for investigation' };

  const domain = investigation.targetDomainNormalised || investigation.targetDomain;
  const targetName = investigation.targetName || domain;
  if (!domain) return { success: false, error: 'Investigation has no target domain to research' };

  let workingState = { ...dossierRow.workingState };
  let questions = workingState.agentResearchQuestions?.length ? workingState.agentResearchQuestions : generateInitialQuestions();
  questions = refreshQuestions(questions, workingState);

  const events = [];
  let stepNumber = bundleResult.bundle.agentEvents.length;
  const usage = { steps: 0, searches: 0, fetchedPages: 0, pdfs: 0, coPartyFollowUps: 0, repeatedActions: 0 };
  const recentActionKeys = new Set();
  const searchedQueries = new Set(); // normalised queries already issued this run — never repeated
  const fetchedDomains = new Set(); // registrable domains already fetched this run — never re-fetched via search
  const coPartyActionCounts = new Map(); // keyed by CANONICAL co-party key, not display name
  const existingEvidence = [...bundleResult.bundle.evidence];
  const existingDiscoveries = [...bundleResult.bundle.discoveries];
  const existingRelationshipKeys = new Set(bundleResult.bundle.relationshipObservations.map((r) => `${normaliseName(r.thirdPartyName)}|${r.relationshipType}|${r.relationshipDirection}`));

  const wouldPersistEvidence = [];
  const wouldPersistClaims = [];
  const wouldPersistRelationships = [];
  const wouldPersistDiscoveries = [];
  const toolCallLog = [];
  const externalSourcesFetched = [];
  const searchQueriesExecuted = [];
  const searchResultsSelected = [];
  const searchResultsRejected = [];
  const coPartiesInvestigated = [];
  const actionsSkippedDueToDedup = [];
  const sourcesAssessed = [];
  const sourcesSkippedBySourceIntelligence = [];
  // Duplicate-fetch guard (canonical-URL/redirect dedup) — in-memory only,
  // never persisted as an agent_event (no new DB enum value/migration).
  // `successfulFetchKeys`: canonical URLs (or, once redirect-merged, the
  // canonical FINAL URL) that have already been fetched successfully this
  // run. `finalUrlByCanonical`: requested-canonical -> final-canonical, so
  // a later action requesting a different URL that happens to redirect to
  // an already-fetched destination is recognised too.
  const successfulFetchKeys = new Set();
  const finalUrlByCanonical = new Map();
  const duplicateActionsSkipped = [];
  const findings = { identity: [], services: [], regulatoryExpertise: [], clientsSectors: [], clientsNamed: [], people: [], thoughtLeadership: [] };
  const rejectedFindings = [];
  // Full relationship objects (entity name, type, direction, and any
  // relationshipSubtype/identifierType/identifierValue metadata — e.g. the
  // ICO's registration number) — used for the DRAFT, which needs the
  // structure, not just the flat dedup-key strings existingRelationshipKeys
  // tracks for its own (unrelated) purpose.
  const activeRelationships = [];

  async function logEvent(eventType, payload) {
    const event = { eventType, payload, stepNumber: stepNumber++, createdAt: new Date().toISOString() };
    events.push(event);
    if (!dryRun) await persistence.appendAgentEvent({ investigationId, eventType, stepNumber: event.stepNumber, payload }, pDeps);
    return event;
  }

  if (!dryRun) {
    await persistence.updateInvestigationStatus(investigationId, investigation.status === 'cancelled' ? investigation.status : 'running', { startedAt: investigation.startedAt || new Date().toISOString() }, pDeps);
  }
  await logEvent('session_started', { phase: 'agent_research_started', dryRun });

  let stopReason = null;
  let fatalFailure = false;

  async function runTool(toolName, toolInput, questionId) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { success: false, toolName, errorType: 'unregistered_tool', error: `"${toolName}" is not a registered tool.` };
    }
    const { valid, errors } = tool.validateInput(toolInput);
    if (!valid) return { success: false, toolName, errorType: 'invalid_input', error: errors.join('; ') };

    const key = actionKeyFor(toolName, toolInput);
    const isRepeat = recentActionKeys.has(key);
    if (isRepeat) usage.repeatedActions += 1;
    recentActionKeys.add(key);

    await logEvent('question_generated', { decision: 'use_tool', toolName, toolInput, questionId });
    const result = await tool.execute(toolInput, { investigationId, dryRun, deps: pDeps });
    toolCallLog.push({ toolName, toolInput, questionId, success: result.success });

    if (result.success) {
      await logEvent('observation_recorded', { toolName, questionId, provenance: result.provenance || null });
    } else {
      await logEvent('tool_call_failed', { toolName, questionId, errorType: result.errorType, error: result.error });
    }
    return result;
  }

  /**
   * Resolves the canonical key a fetch/PDF-read action against `url` would
   * be checked/recorded under — the requested URL's own canonical form,
   * UNLESS it has already been redirect-merged onto a different final URL
   * (Part 3), in which case that final canonical form is used instead.
   */
  function resolveCanonicalFetchKey(url) {
    const canonical = canonicaliseUrl(url);
    if (!canonical) return null;
    return finalUrlByCanonical.get(canonical) || canonical;
  }

  /** True when an equivalent destination has already been fetched successfully this run. */
  function isDuplicateFetch(url) {
    const key = resolveCanonicalFetchKey(url);
    return !!key && successfulFetchKeys.has(key);
  }

  /**
   * Records a successful fetch/PDF-read so future actions against an
   * equivalent URL — including one that redirects to the SAME final
   * destination via a different requested URL — are recognised as
   * duplicates (Part 3's post-redirect merge).
   */
  function recordSuccessfulFetch(requestedUrl, finalUrl) {
    const requestedCanonical = canonicaliseUrl(requestedUrl);
    const finalCanonical = canonicaliseUrl(finalUrl) || requestedCanonical;
    if (!finalCanonical) return;
    successfulFetchKeys.add(finalCanonical);
    if (requestedCanonical && requestedCanonical !== finalCanonical) {
      finalUrlByCanonical.set(requestedCanonical, finalCanonical);
    }
  }

  /**
   * Records a skipped duplicate for reporting (Part 6) — in-memory only,
   * never an agent_event (no new DB enum value/migration needed). Callers
   * are responsible for NOT consuming fetch budget and NOT incrementing
   * repeatedActions for a safely-skipped duplicate (Part 2) — genuine
   * planner repetition that escapes this guard still counts there, via
   * runTool's own recentActionKeys/repeatedActions accounting, unchanged.
   */
  function recordSkippedDuplicate({ toolName, requestedUrl, questionId, reason }) {
    duplicateActionsSkipped.push({
      toolName, requestedUrl, canonicalUrl: resolveCanonicalFetchKey(requestedUrl),
      questionId: questionId || null, reason,
    });
  }

  async function preserveEvidence({ sourceUrl, retrievedAt, evidenceClass, sourceTitle, contextExcerpt, rawContent }) {
    const tool = toolRegistry.get('record_evidence');
    const result = await tool.execute({ investigationId, sourceUrl, retrievedAt, evidenceClass, sourceTitle, contextExcerpt, rawContent }, { investigationId, dryRun, deps: pDeps });
    if (result.success) {
      if (dryRun) { wouldPersistEvidence.push(result.output.preview); return { id: `dryrun-evidence-${wouldPersistEvidence.length}` }; }
      existingEvidence.push(result.output.evidence);
      return { id: result.output.evidence.id };
    }
    rejectedFindings.push({ stage: 'evidence', reason: result.error });
    return { id: null };
  }

  async function recordClaimSafely(input) {
    const tool = toolRegistry.get('record_claim');
    const result = await tool.execute({ ...input, investigationId }, { investigationId, dryRun, deps: pDeps });
    if (!result.success) { rejectedFindings.push({ stage: 'claim', field: input.field, reason: result.error }); return null; }
    if (dryRun) { wouldPersistClaims.push(result.output.preview); return result.output.preview; }
    await logEvent('claim_recorded', { field: input.field, evidenceIds: input.evidenceIds });
    return result.output.claim;
  }

  async function recordDiscoverySafely(input) {
    // Discovery Quality Gate (Part 5), belt-and-braces: entity-detection.js
    // already gates candidates at the point of extraction, but this is the
    // actual persistence choke point every discovery passes through
    // regardless of source, so it is re-checked here too.
    const gate = assessDiscoveryCandidate({ rawName: input.discoveredName, domain: input.discoveredDomain });
    if (!gate.accepted) {
      rejectedFindings.push({ stage: 'discovery_quality_gate', name: input.discoveredName, reason: gate.reason });
      return null;
    }
    const key = input.discoveredDomain || normaliseName(input.discoveredName);
    if (existingDiscoveries.some((d) => (d.discoveredDomainNormalised || d.discoveredNameNormalised) === key)) {
      // Same canonical entity already discovered under a different label —
      // never persist a duplicate discovery row, but still record this
      // label in-memory so mergeDiscoveriesByCanonicalKey can surface it as
      // an alias instead of silently losing it.
      existingDiscoveries.push({
        discoveredName: input.discoveredName, discoveredDomain: input.discoveredDomain || null,
        discoveredDomainNormalised: input.discoveredDomain || null, discoveredNameNormalised: normaliseName(input.discoveredName),
        eligibleForFutureInvestigation: true, aliasOnly: true,
      });
      return null;
    }
    const tool = toolRegistry.get('record_discovery');
    const result = await tool.execute({ ...input, investigationId }, { investigationId, dryRun, deps: pDeps });
    if (!result.success) { rejectedFindings.push({ stage: 'discovery', name: input.discoveredName, reason: result.error }); return null; }
    if (dryRun) {
      wouldPersistDiscoveries.push(result.output.preview);
      // A dry-run discovery must still be visible to THIS run's co-party
      // follow-up (mergeDiscoveriesByCanonicalKey reads existingDiscoveries)
      // — otherwise a newly-discovered co-party could never be followed up
      // in the same dry-run at all, only ones already persisted from an
      // earlier live run. No database write happens either way.
      const previewAsDiscoveryShape = {
        discoveredName: input.discoveredName, discoveredDomain: input.discoveredDomain || null,
        discoveredDomainNormalised: input.discoveredDomain || null, discoveredNameNormalised: normaliseName(input.discoveredName),
        eligibleForFutureInvestigation: true,
      };
      existingDiscoveries.push(previewAsDiscoveryShape);
      return result.output.preview;
    }
    existingDiscoveries.push(result.output.discovery);
    await logEvent('discovery_emitted', { name: input.discoveredName, domain: input.discoveredDomain || null });
    return result.output.discovery;
  }

  async function recordRelationshipSafely(candidate) {
    const key = `${candidate.normalisedName}|${candidate.relationshipType}|${candidate.relationshipDirection}`;
    if (existingRelationshipKeys.has(key)) return null;
    existingRelationshipKeys.add(key);
    if (dryRun) {
      wouldPersistRelationships.push(candidate);
      activeRelationships.push(candidate);
      return candidate;
    }
    const result = await persistence.appendRelationshipObservation({
      investigationId, subjectOrganisation: targetName, thirdPartyName: candidate.rawName,
      thirdPartyDomain: candidate.domain || null, thirdPartyDomainNormalised: candidate.domain || null,
      relationshipType: candidate.relationshipType, relationshipDirection: candidate.relationshipDirection,
      confidence: candidate.confidence, relationshipConfidenceState: candidate.relationshipConfidenceState,
      contextExcerpt: candidate.contextExcerpt, evidenceReferences: candidate.evidenceId ? [candidate.evidenceId] : [],
    }, pDeps);
    if (!result.success) { rejectedFindings.push({ stage: 'relationship_observation', entity: candidate.rawName, reason: result.error }); return null; }
    await logEvent('relationship_observed', { thirdPartyName: candidate.rawName, relationshipType: candidate.relationshipType, relationshipDirection: candidate.relationshipDirection });
    // Metadata fields (relationshipSubtype/identifierType/identifierValue)
    // live only on the in-memory candidate, not in the DB row (no
    // migration/enum change — Part 4) — preserved here for the draft.
    activeRelationships.push({
      ...result.relationshipObservation,
      relationshipSubtype: candidate.relationshipSubtype ?? null,
      identifierType: candidate.identifierType ?? null,
      identifierValue: candidate.identifierValue ?? null,
    });
    return result.relationshipObservation;
  }

  async function processFetchedPage(extractedPage, sourceUrl, retrievedAt, rawContent, isCoParty = false, coPartyName = null) {
    const evidence = await preserveEvidence({
      sourceUrl, retrievedAt, evidenceClass: 'public', sourceTitle: extractedPage.title,
      contextExcerpt: extractedPage.metaDescription || extractedPage.title || null, rawContent,
    });
    const fetchedDomain = registrableDomainOf(sourceUrl);
    if (fetchedDomain) fetchedDomains.add(fetchedDomain);

    if (!isCoParty && evidence.id) {
      // Deterministic finding extraction (Part 5) — only ever runs against
      // the TARGET's own content (homepage or a search result found while
      // researching the target); a co-party's page describes the
      // co-party, not the target, so it is never fed through this.
      const pageFindings = extractFindings(extractedPage, { sourceUrl, evidenceId: evidence.id });
      for (const f of pageFindings) {
        if (findings[f.category]) findings[f.category].push(f);
      }

      // Identity extraction (Part 1) — a first-party legal-name
      // corroboration signal (checked on EVERY target page, cheap, usually
      // absent) followed by a Companies House register-page parse (only
      // fires when this page genuinely is one), which uses whatever
      // corroboration has already accumulated to decide confidence.
      const corroboration = extractLegalNameCorroboration(extractedPage, { sourceUrl, evidenceId: evidence.id });
      if (corroboration) findings.identity.push(corroboration);
      const chIdentityFindings = extractCompaniesHouseIdentity(extractedPage, {
        sourceUrl, evidenceId: evidence.id, targetName, priorIdentityFindings: findings.identity,
      });
      findings.identity.push(...chIdentityFindings);

      // Part 6 — question resolution consumes ONLY findings this page
      // actually produced, never a bare tool attempt.
      if (chIdentityFindings.some((f) => f.field === 'legalName')) {
        questions = resolveQuestion(questions, 'identity-legal-entity', { evidenceIds: [evidence.id] });
      }
      if (chIdentityFindings.some((f) => f.field === 'companyNumber')) {
        questions = resolveQuestion(questions, 'identity-companies-house', { evidenceIds: [evidence.id] });
      }
      for (const [category, questionIds] of Object.entries(QUESTION_RESOLUTION_MAP)) {
        const newOnes = pageFindings.filter((f) => f.category === category);
        if (newOnes.length === 0) continue;
        for (const questionId of questionIds) {
          questions = resolveQuestion(questions, questionId, { evidenceIds: [evidence.id] });
        }
      }
    }

    const extractEntities = toolRegistry.get('extract_entities');
    const entityResult = await extractEntities.execute({ sourceUrl, extractedPage, subjectName: isCoParty ? coPartyName : targetName, investigationId }, { investigationId, dryRun });

    if (isCoParty) {
      // Co-party pages are researched for CONTEXT only — never treated as
      // asserting a relationship to the investigation's own target (that
      // would be a category error: the page describes the co-party, not
      // the target). Findings are preserved as dossier observations only.
      if (entityResult.success) {
        workingState.observations = [
          ...workingState.observations,
          ...entityResult.output.contextualMentions.map((m) => ({ type: 'co_party_research', coParty: coPartyName, rawName: m.rawName, sourceUrl, contextExcerpt: m.contextExcerpt, evidenceId: evidence.id })),
        ];
      }
      return { evidenceId: evidence.id };
    }

    const extractRelationships = toolRegistry.get('extract_relationships');
    const relResult = await extractRelationships.execute({ sourceUrl, extractedPage, subjectName: targetName, investigationId }, { investigationId, dryRun });

    if (relResult.success) {
      let recordedAny = false;
      for (const candidate of relResult.output.relationshipCandidates) {
        const recorded = await recordRelationshipSafely({ ...candidate, evidenceId: evidence.id });
        if (recorded) recordedAny = true;
      }
      // "Only where substantive" (Part 6) — a relationship question is
      // resolved only when a candidate actually passed the assertion
      // model AND was newly recorded (not a no-op duplicate).
      if (recordedAny) {
        questions = resolveQuestion(questions, 'relationships-connected-bodies', { evidenceIds: [evidence.id] });
      }
    }
    if (entityResult.success) {
      workingState.observations = [
        ...workingState.observations,
        ...entityResult.output.contextualMentions.map((m) => ({ type: 'contextual_reference', rawName: m.rawName, normalisedName: m.normalisedName, sourceUrl, contextExcerpt: m.contextExcerpt, detectionMethod: m.detectionMethod, classification: m.classification, rejectionReason: m.rejectionReason, evidenceId: evidence.id })),
      ];
      for (const lo of entityResult.output.linkedOrganisations) {
        if (isSocialPlatform(lo.domain)) continue;
        await recordDiscoverySafely({ discoveredName: lo.rawName, discoveredDomain: lo.domain, discoveryReason: `Linked from ${sourceUrl}` });
      }
    }
    return { evidenceId: evidence.id };
  }

  const homepageUrl = `https://${domain}/`;
  let homepageFetched = false;
  let companiesHouseTried = false;
  let fcaTried = false;
  let sraTried = false;
  const pendingDiscoveries = [];
  // Co-parties that have either been fully investigated OR whose fetch
  // failed at least once — a failing target must never be retried
  // indefinitely; one failed attempt consumes its bounded budget just as
  // a successful one does, so the loop always makes forward progress
  // instead of repeating a dead URL until the repeated-action limit
  // trips (that limit is a safety net, not the intended way to move on).
  // Keyed by CANONICAL co-party key (domain-based, see co-party-identity.js)
  // — never by display name, which is exactly what caused two differently
  // labelled gov.uk discoveries to be treated as separate co-parties and
  // trip the repeated-action stop in the previous real run.
  const exhaustedCoParties = new Set();
  const coPartyAliasesMerged = []; // { canonicalKey, primaryName, aliases } — reported, never lost

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= limits.maxElapsedMs) { stopReason = 'limit_reached:maxElapsedMs'; break; }
    if (usage.steps >= limits.maxSteps) { stopReason = 'limit_reached:maxSteps'; break; }
    if (usage.repeatedActions >= limits.maxRepeatedActions) { stopReason = 'limit_reached:maxRepeatedActions'; break; }

    const weakEvidenceEntity = null; // corroboration signal reserved for a future pass — see final response notes.

    const action = await decidePlannerAction({
      dossier: workingState, questions, toolRegistry, recentEvents: events, limits, usage,
      context: { investigationId, homepageUrl, homepageFetched, companiesHouseTried, fcaTried, sraTried, searchesTried: usage.searches, recentActionKeys, pendingDiscoveries, coPartyFollowUpsUsed: usage.coPartyFollowUps, weakEvidenceEntity, searchedQueries },
      targetName, targetDomain: domain, llmClient, evidenceSummary: `${existingEvidence.length} evidence record(s) preserved so far.`,
    });

    if (action.action === 'finish') { stopReason = action.stopReason; break; }

    usage.steps += 1;

    // Guard against a fatal/unregistered tool name slipping through
    // (defence-in-depth beyond the planner's own validation).
    if (!toolRegistry.has(action.toolName)) {
      await logEvent('tool_call_failed', { toolName: action.toolName, errorType: 'unregistered_tool', error: 'Planner named a tool that is not registered.' });
      stopReason = 'fatal_tool_failure';
      fatalFailure = true;
      break;
    }

    const isCoPartyAction = action.questionId === 'ecosystem-significant-organisations' && pendingDiscoveries.length > 0;
    const coPartyTarget = isCoPartyAction ? pendingDiscoveries[0] : null;
    const coPartyKey = coPartyTarget ? coPartyTarget.canonicalKey : null;

    // Pre-execution duplicate guard (Part 2) — only applies to
    // fetch_web_page, and only BEFORE calling runTool, so a skipped
    // duplicate never consumes fetch budget and never increments
    // repeatedActions (that counter is reserved for genuine planner
    // repetition that escapes this guard entirely).
    const isDuplicatePlannerFetch = action.toolName === 'fetch_web_page' && isDuplicateFetch(action.toolInput.url);
    if (isDuplicatePlannerFetch) {
      recordSkippedDuplicate({
        toolName: 'fetch_web_page', requestedUrl: action.toolInput.url, questionId: action.questionId,
        reason: 'Equivalent destination already fetched successfully this run — skipped, no fetch budget consumed.',
      });
      // Feed the planner forward (Part 5): a duplicate co-party root-page
      // re-fetch is exactly the real bug this task fixes (maxCoPartyActionsEach
      // otherwise permits fetching the SAME co-party root URL twice) — marking
      // it exhausted now means the NEXT loop iteration's pendingDiscoveries no
      // longer offers this same equivalent action.
      if (isCoPartyAction) exhaustedCoParties.add(coPartyKey);
    }

    const result = isDuplicatePlannerFetch
      ? { success: true, toolName: 'fetch_web_page', skippedDuplicate: true }
      : await runTool(action.toolName, action.toolInput, action.questionId);

    if (action.toolName === 'search_web') {
      usage.searches += 1;
      searchedQueries.add(normaliseQuery(action.toolInput.query));
      if (result.success) {
        searchQueriesExecuted.push({ query: result.output.query, resultCount: result.output.results.length, provider: result.output.provider ?? null });

        // Part 3/4: deterministically select which results are worth
        // fetching, then fetch them ourselves (mirrors how extract_*
        // already runs automatically after any fetch — the planner only
        // ever decides to SEARCH, the orchestrator handles the
        // select-then-fetch mechanics).
        const { selected, rejected } = selectSearchResults(result.output.results, {
          targetName, targetDomain: domain, alreadyFetchedCanonicalUrls: successfulFetchKeys, maxSelected: limits.maxFetchedPerQuery,
        });
        searchResultsSelected.push(...selected.map((r) => ({ ...r, query: result.output.query })));
        searchResultsRejected.push(...rejected.map((r) => ({ ...r, query: result.output.query })));

        const fetchWebPageTool = toolRegistry.get('fetch_web_page');
        const readPdfTool = toolRegistry.get('read_pdf');
        for (const searchResult of selected) {
          if (usage.fetchedPages >= limits.maxFetchedSearchResultPages + 1) break; // +1 allows the homepage fetch itself

          // Source Intelligence (second, more comprehensive gate on top of
          // selectSearchResults' simpler relevance scoring) — judges
          // authority, commercial/regulatory relevance, first/third-party,
          // UK/non-UK jurisdiction, and evidence likelihood BEFORE spending
          // a fetch on this URL. This is what stops e.g. a US occupational
          // handbook page or an unrelated same-named vendor from consuming
          // budget just because it surfaced in search results.
          const assessment = assessSource({ url: searchResult.url, title: searchResult.title, snippet: searchResult.snippet, targetName, targetDomain: domain });
          sourcesAssessed.push({ url: searchResult.url, classification: assessment.classification, compositeScore: assessment.compositeScore, recommendation: assessment.recommendation, context: 'search_result' });
          if (assessment.recommendation === 'skip') {
            sourcesSkippedBySourceIntelligence.push({ url: searchResult.url, classification: assessment.classification, compositeScore: assessment.compositeScore, reasons: assessment.reasons, context: 'search_result' });
            continue;
          }

          // Pre-execution duplicate guard (Part 2), same as the main
          // planner-driven fetch path above — a search result that
          // resolves to an already-fetched canonical/final URL (e.g. the
          // homepage or a page already reached via an earlier query) is
          // skipped before any budget is spent, not after.
          if (isDuplicateFetch(searchResult.url)) {
            recordSkippedDuplicate({
              toolName: 'fetch_web_page', requestedUrl: searchResult.url, questionId: action.questionId,
              reason: 'Equivalent destination already fetched successfully this run (surfaced again via search) — skipped, no fetch budget consumed.',
            });
            continue;
          }

          const isPdf = searchResult.url.toLowerCase().endsWith('.pdf');
          usage.fetchedPages += 1;
          if (isPdf) {
            usage.pdfs += 1;
            const pdfResult = await readPdfTool.execute({ url: searchResult.url, investigationId }, { investigationId, dryRun, deps: pDeps });
            toolCallLog.push({ toolName: 'read_pdf', toolInput: { url: searchResult.url }, questionId: action.questionId, success: pdfResult.success });
            if (pdfResult.success) {
              recordSuccessfulFetch(searchResult.url, pdfResult.output.sourceUrl);
              externalSourcesFetched.push({ url: pdfResult.output.sourceUrl, title: null, viaSearch: true });
              const evidence = await preserveEvidence({ sourceUrl: pdfResult.output.sourceUrl, retrievedAt: pdfResult.output.retrievedAt, evidenceClass: 'public', sourceTitle: null, contextExcerpt: pdfResult.output.text.slice(0, 300) });
              fetchedDomains.add(registrableDomainOf(pdfResult.output.sourceUrl));
              if (evidence.id) {
                const pdfFindings = extractFindings({ visibleText: pdfResult.output.text, headings: [] }, { sourceUrl: pdfResult.output.sourceUrl, evidenceId: evidence.id });
                for (const f of pdfFindings) if (findings[f.category]) findings[f.category].push(f);
              }
            }
          } else {
            const pageResult = await fetchWebPageTool.execute({ url: searchResult.url, investigationId }, { investigationId, dryRun, deps: pDeps });
            toolCallLog.push({ toolName: 'fetch_web_page', toolInput: { url: searchResult.url }, questionId: action.questionId, success: pageResult.success });
            if (pageResult.success) {
              recordSuccessfulFetch(searchResult.url, pageResult.output.finalUrl);
              externalSourcesFetched.push({ url: pageResult.output.finalUrl, title: pageResult.output.title, viaSearch: true });
              await processFetchedPage(pageResult.output, pageResult.output.finalUrl, pageResult.output.retrievedAt, pageResult.output.rawBody, false);
            }
          }
        }
      }
    }
    if (action.toolName === 'companies_house_lookup') companiesHouseTried = true;
    if (action.toolName === 'fca_lookup') fcaTried = true;
    if (action.toolName === 'sra_lookup') sraTried = true;

    if (action.toolName === 'fetch_web_page' && !isDuplicatePlannerFetch) {
      usage.fetchedPages += 1;
      if (result.success) {
        recordSuccessfulFetch(action.toolInput.url, result.output.finalUrl);
        externalSourcesFetched.push({ url: result.output.finalUrl, title: result.output.title });
        if (isCoPartyAction) {
          usage.coPartyFollowUps += 1;
          const count = (coPartyActionCounts.get(coPartyKey) || 0) + 1;
          coPartyActionCounts.set(coPartyKey, count);
          if (!coPartiesInvestigated.includes(coPartyTarget.name)) coPartiesInvestigated.push(coPartyTarget.name);
          await processFetchedPage(result.output, result.output.finalUrl, result.output.retrievedAt, result.output.rawBody, true, coPartyTarget.name);
          if (count >= limits.maxCoPartyActionsEach || coPartiesInvestigated.length >= limits.maxCoPartyFollowUps) exhaustedCoParties.add(coPartyKey);
        } else {
          if (result.output.finalUrl.replace(/\/$/, '') === homepageUrl.replace(/\/$/, '')) homepageFetched = true;
          await processFetchedPage(result.output, result.output.finalUrl, result.output.retrievedAt, result.output.rawBody, false);
        }
      } else if (isCoPartyAction) {
        // A failed co-party fetch still consumes that co-party's bounded
        // budget — it must never be retried indefinitely.
        exhaustedCoParties.add(coPartyKey);
      }
    }

    if (action.toolName === 'read_pdf') {
      usage.pdfs += 1;
      if (result.success) {
        await preserveEvidence({ sourceUrl: result.output.sourceUrl, retrievedAt: result.output.retrievedAt, evidenceClass: 'public', sourceTitle: null, contextExcerpt: result.output.text.slice(0, 300) });
      }
    }

    if (action.toolName === 'companies_house_lookup' && result.success && result.output.matched) {
      const c = result.output.company;
      const registerUrl = `https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}`;
      const evidence = await preserveEvidence({ sourceUrl: registerUrl, retrievedAt: new Date().toISOString(), evidenceClass: 'third_party', sourceTitle: c.name, contextExcerpt: `Companies House: ${c.name} (${c.companyNumber}), status: ${c.status}` });
      if (evidence.id) {
        await recordClaimSafely({ claimType: 'identity', field: 'companyNumber', value: c.companyNumber, confidence: 'high', evidenceIds: [evidence.id] });
        await recordClaimSafely({ claimType: 'identity', field: 'legalName', value: c.name, confidence: 'high', evidenceIds: [evidence.id] });
        findings.identity.push({ field: 'companyNumber', value: c.companyNumber, confidence: 'high' });
        findings.identity.push({ field: 'legalName', value: c.name, confidence: 'high' });
      }
      questions = resolveQuestion(questions, 'identity-companies-house', { evidenceIds: evidence.id ? [evidence.id] : [] });
      questions = resolveQuestion(questions, 'identity-legal-entity', { evidenceIds: evidence.id ? [evidence.id] : [] });
    } else if (action.toolName === 'companies_house_lookup' && result.success && result.output.matched === false) {
      // Genuinely investigated, honestly no match — resolution requires
      // either accepted evidence OR an explicit investigated-no-evidence
      // conclusion (Part 6); this is the latter, recorded honestly rather
      // than left open forever OR silently marked "resolved".
      questions = dropQuestion(questions, 'identity-companies-house', { reason: 'Investigated via companies_house_lookup — no matching register entry found; no evidence available from this tool.' });
    }

    if (action.toolName === 'fca_lookup' && result.success && result.output.matched) {
      const f = result.output.firm;
      const registerUrl = `https://register.fca.org.uk/s/firm?id=${f.frn}`;
      const evidence = await preserveEvidence({ sourceUrl: registerUrl, retrievedAt: new Date().toISOString(), evidenceClass: 'third_party', sourceTitle: f.name, contextExcerpt: `FCA Register: ${f.name} (FRN ${f.frn}), status: ${f.status}` });
      if (evidence.id) {
        await recordClaimSafely({ claimType: 'regulatory_expertise', field: 'fcaAuthorisation', value: f.status, confidence: 'high', evidenceIds: [evidence.id] });
        findings.regulatoryExpertise.push({ field: 'fcaAuthorisation', value: f.status, confidence: 'high' });
      }
      questions = resolveQuestion(questions, 'regulatory-specialist-expertise', { evidenceIds: evidence.id ? [evidence.id] : [] });
    }

    if (action.toolName === 'sra_lookup' && result.success && result.output.matched) {
      const s = result.output.firm;
      const evidence = await preserveEvidence({ sourceUrl: `https://www.sra.org.uk/`, retrievedAt: new Date().toISOString(), evidenceClass: 'third_party', sourceTitle: s.name, contextExcerpt: `SRA snapshot: ${s.name} (SRA ${s.sraNumber})` });
      if (evidence.id) {
        await recordClaimSafely({ claimType: 'relationships', field: 'sraConnection', value: s.sraNumber, confidence: 'medium', evidenceIds: [evidence.id] });
      }
      questions = resolveQuestion(questions, 'relationships-connected-bodies', { evidenceIds: evidence.id ? [evidence.id] : [] });
    }

    if (!result.success && result.errorType && ['ssrf_blocked', 'unsupported_protocol', 'not_configured'].includes(result.errorType)) {
      // Not fatal — just this one action didn't pan out; continue researching.
    }

    // Refresh pendingDiscoveries from the latest discoveries preserved so
    // far, merged by CANONICAL co-party identity (domain-first — see
    // co-party-identity.js) rather than by display name. This is what
    // prevents "here" and "published in June" (two different labels that
    // both resolved to gov.uk) from ever being treated as two co-parties.
    const merged = mergeDiscoveriesByCanonicalKey(existingDiscoveries.filter((d) => d.eligibleForFutureInvestigation !== false));
    for (const group of merged) {
      if (group.aliases.length > 0 && !coPartyAliasesMerged.some((m) => m.canonicalKey === group.canonicalKey)) {
        coPartyAliasesMerged.push({ canonicalKey: group.canonicalKey, primaryName: group.primaryName, aliases: group.aliases });
        actionsSkippedDueToDedup.push(`Merged ${group.aliases.length} alias(es) of "${group.primaryName}" (${group.canonicalKey}) into one co-party — follow-up performed once, not ${group.aliases.length + 1} times.`);
      }
    }
    // Source Intelligence, standalone mode: a co-party candidate discovered
    // via hyperlink extraction is judged on its own intrinsic quality (no
    // target to be "relevant to" — a co-party is, by definition, a
    // different organisation) before it is even queued for follow-up. This
    // is what stops a job-classification site or a generic government
    // handbook page — reached only because it happened to be hyperlinked
    // from somewhere already fetched — from consuming a co-party
    // follow-up slot. Candidates with no known domain (name-only fallback)
    // cannot be assessed and are left ungated, unchanged from prior behaviour.
    const scoredCandidates = merged
      .filter((g) => !exhaustedCoParties.has(g.canonicalKey))
      .map((g) => ({ group: g, assessment: g.domain ? assessSource({ url: `https://${g.domain}/` }) : null }));

    for (const { group, assessment } of scoredCandidates) {
      if (assessment && assessment.recommendation === 'skip') {
        const url = `https://${group.domain}/`;
        if (!sourcesSkippedBySourceIntelligence.some((s) => s.url === url && s.context === 'co_party_candidate')) {
          sourcesSkippedBySourceIntelligence.push({ url, classification: assessment.classification, compositeScore: assessment.compositeScore, reasons: assessment.reasons, context: 'co_party_candidate' });
        }
      }
    }

    pendingDiscoveries.length = 0;
    pendingDiscoveries.push(...scoredCandidates
      .filter(({ assessment }) => !assessment || assessment.recommendation !== 'skip')
      .sort((a, b) => (b.assessment ? b.assessment.compositeScore : 50) - (a.assessment ? a.assessment.compositeScore : 50))
      .slice(0, limits.maxCoPartyFollowUps)
      .map(({ group }) => ({ name: group.primaryName, domain: group.domain, canonicalKey: group.canonicalKey })));

    questions = refreshQuestions(questions, workingState);
  }

  // Persist the dossier's accumulated working state (once, at the end) —
  // skipped entirely in dry-run.
  workingState = { ...workingState, agentResearchQuestions: questions, completionNotes: fatalFailure ? 'Agent research ended on a fatal tool failure.' : `Agent research stopped: ${stopReason}.` };
  if (!dryRun) {
    await persistence.updateDossier(investigationId, workingState, pDeps);
  }

  // Produce a pending Commercial Authority draft from the accumulated research.
  const draftContent = {
    target: { name: targetName, domain },
    identity: findings.identity,
    services: findings.services,
    regulatoryExpertise: findings.regulatoryExpertise,
    clientsSectors: findings.clientsSectors,
    clientsNamed: findings.clientsNamed,
    people: findings.people,
    thoughtLeadership: findings.thoughtLeadership,
    // Full structured relationship objects (entity name/type/direction plus
    // any relationshipSubtype/identifierType/identifierValue metadata),
    // never just the flat dedup-key strings — Part 4's "retain a precise
    // relationship subtype or metadata in the dossier/draft".
    relationships: activeRelationships,
    // Alias-only in-memory placeholders (a duplicate label for an already-
    // discovered canonical entity — see recordDiscoverySafely) are excluded
    // from the active draft; they were never persisted as their own row
    // and exist only so mergeDiscoveriesByCanonicalKey can surface them as
    // an alias, not as a second discovery.
    discoveries: dryRun
      ? wouldPersistDiscoveries
      : existingDiscoveries.filter((d) => !d.aliasOnly && d.eligibleForFutureInvestigation !== false).map((d) => ({ name: d.discoveredName, domain: d.discoveredDomain })),
    evidenceCount: dryRun ? wouldPersistEvidence.length : existingEvidence.length,
    openQuestions: questions.filter((q) => q.status === 'open').map((q) => q.id),
    generatedAt: new Date().toISOString(),
  };
  const finishTool = toolRegistry.get('finish_investigation');
  const draftResult = await finishTool.execute({ draftContent, investigationId }, { investigationId, dryRun, deps: pDeps });

  const finalStatus = fatalFailure ? 'failed' : (rejectedFindings.length > 0 && toolCallLog.some((t) => !t.success) ? 'partial' : 'completed');
  if (!dryRun) {
    await persistence.updateInvestigationStatus(investigationId, finalStatus, { completedAt: new Date().toISOString(), stepCount: stepNumber, failureReason: finalStatus === 'partial' ? 'One or more tool calls failed; see agent events.' : null }, pDeps);
  }
  await logEvent('session_ended', { phase: 'agent_research_completed', stopReason, dryRun, status: finalStatus });

  return {
    success: true,
    investigationId,
    dryRun,
    status: finalStatus,
    stopReason,
    usage,
    limits,
    elapsedMs: Date.now() - startedAt,
    toolCallLog,
    searchQueriesExecuted,
    searchResultsSelected,
    searchResultsRejected,
    externalSourcesFetched,
    coPartiesInvestigated,
    coPartyAliasesMerged,
    actionsSkippedDueToDedup,
    duplicateActionsSkipped,
    sourcesAssessed,
    sourcesSkippedBySourceIntelligence,
    findings,
    rejectedFindings,
    wouldPersistEvidence,
    wouldPersistClaims,
    wouldPersistRelationships,
    wouldPersistDiscoveries,
    draft: draftResult.success ? draftResult.output : null,
    questions,
    events,
  };
}

module.exports = { runResearchAgent, DEFAULT_LIMITS };
