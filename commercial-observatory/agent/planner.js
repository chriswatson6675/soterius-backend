'use strict';

// Planner — decides the SINGLE next research action (execution
// architecture design, §F "Decide Next Action"). Chooses only among the
// research/lookup tools (search_web, fetch_web_page, companies_house_lookup,
// fca_lookup, sra_lookup, read_pdf) or 'finish'. It never itself extracts,
// records, or drafts anything — the orchestrator does that automatically
// as it processes whatever the chosen tool returns (Part 7's numbered
// loop steps 8-11 are the orchestrator's job, not a separate planner
// turn), and it never fabricates a tool result.
//
// Tries an LLM (agent/llm-client.js) first, if configured; ALWAYS
// validates whatever the LLM proposes against the registered tool set and
// the current open questions before accepting it. Falls back to a fully
// deterministic, rule-based decision when no LLM is configured, the LLM
// call fails, or its proposal doesn't validate — the agent works, and is
// fully testable, with zero LLM access.

const { prioritiseOpenQuestions } = require('./research-questions');
const { buildPlannerPrompt, PLANNER_SYSTEM_PROMPT } = require('./prompts');
const { pickNextSearchQuery } = require('./search-queries');

const PLANNABLE_TOOLS = Object.freeze(['search_web', 'fetch_web_page', 'companies_house_lookup', 'fca_lookup', 'sra_lookup', 'read_pdf']);

// Maps a `usage` counter key to its corresponding `limits` key — kept as
// an explicit table (rather than requiring identical key names on both
// objects) since "how many steps used" and "the max steps allowed" are
// naturally named differently.
const LIMIT_USAGE_MAP = Object.freeze([
  ['steps', 'maxSteps'],
  ['searches', 'maxSearches'],
  ['fetchedPages', 'maxFetchedPages'],
  ['pdfs', 'maxPdfs'],
  ['coPartyFollowUps', 'maxCoPartyFollowUps'],
  ['repeatedActions', 'maxRepeatedActions'],
]);

function useToolAction({ toolName, toolInput, questionId, reason, expectedInformationGain }) {
  return { action: 'use_tool', questionId: questionId || null, toolName, toolInput, reason, expectedInformationGain: expectedInformationGain || 'medium', stopReason: null };
}

function finishAction(stopReason, reason) {
  return { action: 'finish', questionId: null, toolName: null, toolInput: null, reason: reason || stopReason, expectedInformationGain: null, stopReason };
}

function limitReached(usage, limits) {
  for (const [usageKey, limitKey] of LIMIT_USAGE_MAP) {
    if (limits[limitKey] !== undefined && (usage[usageKey] ?? 0) >= limits[limitKey]) return limitKey;
  }
  return null;
}

function hasQuestion(openQuestions, id) {
  return openQuestions.some((q) => q.id === id);
}

/**
 * Deterministic decision — no LLM required. `context` is orchestrator-
 * maintained state describing what's already been tried this run:
 * { homepageUrl, homepageFetched, companiesHouseTried, fcaTried, sraTried,
 *   searchesTried, recentActionKeys: Set<string> }
 */
function decideDeterministic({ openQuestions, context, targetName, targetDomain, usage, limits }) {
  const reachedLimit = limitReached(usage, limits);
  if (reachedLimit) return finishAction(`limit_reached:${reachedLimit}`, `Stopping — ${reachedLimit} limit reached.`);

  if (openQuestions.length === 0) {
    return finishAction('no_high_value_question_remaining', 'No open unanswered questions remain.');
  }

  const isRepeated = (key) => context.recentActionKeys && context.recentActionKeys.has(key);
  const searchedQueries = context.searchedQueries || new Set();

  // 1. Inspect the target's own website first — the cheapest, highest-
  // value single source (services/regulatory/relationships/people all in
  // one fetch).
  if (!context.homepageFetched && !isRepeated(`fetch_web_page:${context.homepageUrl}`)) {
    return useToolAction({ toolName: 'fetch_web_page', toolInput: { url: context.homepageUrl, investigationId: context.investigationId }, questionId: 'services-provided', reason: "Fetch the target's own homepage — the primary source for services, regulatory expertise, relationships and people.", expectedInformationGain: 'high' });
  }

  // 1b. Corroborate weak (hypothesis-level) evidence before anything else,
  // if flagged — this is always worth doing regardless of phase.
  if (context.weakEvidenceEntity && (context.searchesTried || 0) < limits.maxSearches && !isRepeated(`search_web:corroborate:${context.weakEvidenceEntity}`)) {
    return useToolAction({ toolName: 'search_web', toolInput: { query: `${targetName} ${context.weakEvidenceEntity} partnership OR membership confirmed`, investigationId: context.investigationId }, questionId: 'relationships-contextual-vs-direct', reason: `Corroborate weak (hypothesis-level) evidence for "${context.weakEvidenceEntity}" before treating it as established.`, expectedInformationGain: 'medium' });
  }

  // 2. Search-first phase: once the homepage has been inspected, generate
  // targeted queries for unresolved HIGH-VALUE questions (identity,
  // services, regulatory expertise, people, relationships) before
  // exhausting register lookups or co-party traversal — reserving
  // thought-leadership questions for the later catch-all phase (step 6).
  if ((context.searchesTried || 0) < (limits.maxSearchPhaseSearches ?? 4)) {
    const searchPhaseQuestions = openQuestions.filter((q) => q.id !== 'thought-leadership-published' && q.id !== 'ecosystem-coparty-candidates');
    const candidate = pickNextSearchQuery(searchPhaseQuestions, targetName, targetDomain, searchedQueries);
    if (candidate) {
      return useToolAction({ toolName: 'search_web', toolInput: { query: candidate.query, investigationId: context.investigationId }, questionId: candidate.questionId, reason: `Targeted search for unresolved question "${candidate.questionId}".`, expectedInformationGain: 'medium' });
    }
  }

  // 3. Fetching selected search results happens automatically in the
  // orchestrator right after a successful search_web call (mirrors how
  // extract_entities/extract_relationships already run automatically after
  // any fetch) — no separate planner turn is needed for it.

  // 4. Register lookups, where identity/regulatory verification remains useful.
  if (hasQuestion(openQuestions, 'identity-companies-house') && !context.companiesHouseTried) {
    return useToolAction({ toolName: 'companies_house_lookup', toolInput: { name: targetName, investigationId: context.investigationId }, questionId: 'identity-companies-house', reason: 'Establish legal identity via Companies House.', expectedInformationGain: 'high' });
  }
  if (hasQuestion(openQuestions, 'regulatory-specialist-expertise') && !context.fcaTried) {
    return useToolAction({ toolName: 'fca_lookup', toolInput: { name: targetName, investigationId: context.investigationId }, questionId: 'regulatory-specialist-expertise', reason: 'Check the FCA register for a direct authorisation relationship.', expectedInformationGain: 'medium' });
  }
  if (hasQuestion(openQuestions, 'relationships-connected-bodies') && !context.sraTried) {
    return useToolAction({ toolName: 'sra_lookup', toolInput: { name: targetName, investigationId: context.investigationId }, questionId: 'relationships-connected-bodies', reason: 'Check the SRA register for a direct connection.', expectedInformationGain: 'medium' });
  }

  // 5. Follow high-value canonical co-parties, bounded.
  if (hasQuestion(openQuestions, 'ecosystem-significant-organisations') && context.pendingDiscoveries?.length > 0 && (context.coPartyFollowUpsUsed || 0) < (limits.maxCoPartyFollowUps ?? 5)) {
    const target = context.pendingDiscoveries[0];
    return useToolAction({ toolName: 'fetch_web_page', toolInput: { url: target.domain ? `https://${target.domain}/` : target.url, investigationId: context.investigationId }, questionId: 'ecosystem-significant-organisations', reason: `Bounded follow-up on discovered organisation "${target.name}" to clarify its relevance.`, expectedInformationGain: 'medium' });
  }

  // 6. Thought leadership / remaining gaps, using whatever overall search
  // budget is left.
  if ((context.searchesTried || 0) < limits.maxSearches) {
    const candidate = pickNextSearchQuery(openQuestions, targetName, targetDomain, searchedQueries);
    if (candidate) {
      return useToolAction({ toolName: 'search_web', toolInput: { query: candidate.query, investigationId: context.investigationId }, questionId: candidate.questionId, reason: `Remaining-gap search for "${candidate.questionId}".`, expectedInformationGain: 'low' });
    }
  }

  return finishAction('no_actionable_tool_for_remaining_questions', 'Remaining open questions have no un-repeated, in-limit action available.');
}

function validateLlmAction(parsed, { toolRegistry, openQuestions }) {
  if (!parsed || typeof parsed !== 'object') return { valid: false };
  if (parsed.action === 'finish') return { valid: true };
  if (parsed.action !== 'use_tool') return { valid: false };
  if (!PLANNABLE_TOOLS.includes(parsed.toolName) || !toolRegistry.has(parsed.toolName)) return { valid: false };
  if (parsed.questionId && !openQuestions.some((q) => q.id === parsed.questionId)) return { valid: false };
  const tool = toolRegistry.get(parsed.toolName);
  const { valid } = tool.validateInput(parsed.toolInput || {});
  return { valid };
}

/**
 * decidePlannerAction(input) -> Promise<Action>
 * input: { dossier, questions, toolRegistry, recentEvents, limits, usage,
 *   context, targetName, targetDomain, llmClient, evidenceSummary }
 */
async function decidePlannerAction(input) {
  const {
    dossier, questions, toolRegistry, recentEvents = [], limits, usage,
    context = {}, targetName, targetDomain, llmClient, evidenceSummary,
  } = input;

  const openQuestions = prioritiseOpenQuestions(questions);
  const reachedLimit = limitReached(usage, limits);
  if (reachedLimit) return finishAction(`limit_reached:${reachedLimit}`, `Stopping — ${reachedLimit} limit reached.`);

  if (llmClient && llmClient.isAvailable && llmClient.isAvailable()) {
    const plannableTools = toolRegistry.list().filter((t) => PLANNABLE_TOOLS.includes(t.name));
    const prompt = buildPlannerPrompt({ dossier, questions: openQuestions, tools: plannableTools, recentEvents, limits, usage, evidenceSummary });
    const llmResult = await llmClient.complete({ system: PLANNER_SYSTEM_PROMPT, prompt });
    if (llmResult.available) {
      let parsed = null;
      try { parsed = JSON.parse(llmResult.text); } catch { parsed = null; }
      const { valid } = validateLlmAction(parsed, { toolRegistry, openQuestions });
      if (valid) {
        return parsed.action === 'finish'
          ? finishAction(parsed.stopReason || 'llm_finish', parsed.reason)
          : useToolAction(parsed);
      }
      // LLM proposed something invalid/unregistered — fall through to the
      // deterministic path rather than trusting it (planner must not
      // fabricate tool results).
    }
  }

  return decideDeterministic({ openQuestions, context, targetName, targetDomain, usage, limits });
}

module.exports = { decidePlannerAction, decideDeterministic, PLANNABLE_TOOLS };
