'use strict';

// Search-query templates for the planner's search-first phase (Part 2).
// Each research-question id maps to an ORDERED list of candidate queries —
// the planner tries them in order, skipping any already issued this run
// (normalised), so the same question never repeats a query and a
// low-value question is never searched before a higher-priority one runs
// out of untried templates.

function buildQueryTemplates(targetName, targetDomain) {
  const name = targetName;
  return {
    'identity-legal-entity': [
      `"${name}" company`,
      `site:find-and-update.company-information.service.gov.uk "${name}"`,
      `"${name}" "${targetDomain}"`,
    ],
    'identity-companies-house': [
      `site:find-and-update.company-information.service.gov.uk "${name}"`,
      `"${name}" company`,
    ],
    'services-provided': [
      `"${name}" services`,
      `"${name}" compliance consultancy`,
    ],
    'services-regulated-relevance': [
      `"${name}" compliance consultancy`,
      `"${name}" services`,
    ],
    'regulatory-regimes-advised': [
      `"${name}" COLP COFA`,
      `"${name}" SRA compliance`,
      `"${name}" FCA compliance`,
      `"${name}" AML consultancy`,
    ],
    'regulatory-specialist-expertise': [
      `"${name}" SRA compliance`,
      `"${name}" FCA compliance`,
      `"${name}" AML consultancy`,
      `"${name}" COLP COFA`,
    ],
    'people-leadership': [
      `"${name}" team`,
      `"${name}" director`,
      `"${name}" founder`,
    ],
    'relationships-connected-bodies': [
      `"${name}" partner`,
      `"${name}" member`,
      `"${name}" accredited`,
    ],
    'relationships-contextual-vs-direct': [
      `"${name}" client`,
      `"${name}" case study`,
    ],
    'thought-leadership-published': [
      `"${name}" article`,
      `"${name}" webinar`,
      `"${name}" conference`,
      `"${name}" podcast`,
    ],
  };
}

function normaliseQuery(query) {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * pickNextSearchQuery(openQuestions, targetName, targetDomain, searchedQueries)
 *   -> { questionId, query } | null
 *
 * Iterates open questions in priority order (caller supplies them
 * pre-sorted); for the first question with an untried query template,
 * returns that query. Returns null once every question's templates are
 * exhausted — the planner then moves on to the next phase rather than
 * forcing an irrelevant search.
 */
function pickNextSearchQuery(openQuestions, targetName, targetDomain, searchedQueries) {
  const templates = buildQueryTemplates(targetName, targetDomain);
  const seen = searchedQueries || new Set();
  for (const q of openQuestions) {
    const candidates = templates[q.id];
    if (!candidates) continue;
    for (const query of candidates) {
      if (!seen.has(normaliseQuery(query))) {
        return { questionId: q.id, query };
      }
    }
  }
  return null;
}

module.exports = { buildQueryTemplates, normaliseQuery, pickNextSearchQuery };
