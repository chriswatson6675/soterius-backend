'use strict';

// Research Questions — the agent's explicit, auditable research backlog
// (execution architecture design, §D "unanswered questions" / §G
// curiosity). Every question the planner ever acts on traces back to one
// of these, with a category, priority, reason, and suggested tools — never
// an ad hoc, unrecorded impulse.

const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const STATUSES = Object.freeze(['open', 'resolved', 'dropped']);

const QUESTION_TEMPLATES = Object.freeze([
  // Identity
  { id: 'identity-legal-entity', category: 'identity', priority: 'high', reason: 'The legal entity anchors every other fact — without it, nothing else can be safely attributed.', suggestedTools: ['companies_house_lookup', 'fetch_web_page'] },
  { id: 'identity-domains-trading-names', category: 'identity', priority: 'medium', reason: 'Trading names and domain variants affect how the organisation is discovered elsewhere.', suggestedTools: ['fetch_web_page', 'search_web'] },
  { id: 'identity-companies-house', category: 'identity', priority: 'high', reason: 'A registered company number is the strongest available identity anchor.', suggestedTools: ['companies_house_lookup'] },
  // Services
  { id: 'services-provided', category: 'services', priority: 'high', reason: 'What the organisation actually does is central to any commercial assessment of it.', suggestedTools: ['inspect_target_website', 'fetch_web_page'] },
  { id: 'services-regulated-relevance', category: 'services', priority: 'medium', reason: 'Services relating directly to regulated organisations are what makes this organisation Commercial-Authority-relevant at all.', suggestedTools: ['fetch_web_page', 'extract_entities'] },
  // Regulatory expertise
  { id: 'regulatory-regimes-advised', category: 'regulatory_expertise', priority: 'high', reason: 'Which regulatory regimes the organisation advises on defines its market position.', suggestedTools: ['fetch_web_page', 'extract_entities'] },
  { id: 'regulatory-specialist-expertise', category: 'regulatory_expertise', priority: 'medium', reason: 'FCA/SRA/AML/COLP/COFA-specific expertise is a strong, checkable signal.', suggestedTools: ['fca_lookup', 'sra_lookup', 'fetch_web_page'] },
  // Clients and sectors
  { id: 'clients-sectors-served', category: 'clients_sectors', priority: 'medium', reason: 'The sectors served describe the organisation\'s market, even where no named client is evidenced.', suggestedTools: ['fetch_web_page', 'extract_entities'] },
  { id: 'clients-named-evidence', category: 'clients_sectors', priority: 'low', reason: 'Named clients require unusually strong evidence (COMM-002 §6) — checked, but held to a high bar.', suggestedTools: ['fetch_web_page', 'extract_relationships'] },
  // Relationships
  { id: 'relationships-connected-bodies', category: 'relationships', priority: 'high', reason: 'Regulators, professional bodies, partners, certifiers and associations are the core of the Commercial Authority ecosystem map.', suggestedTools: ['fetch_web_page', 'extract_relationships', 'fca_lookup', 'sra_lookup'] },
  { id: 'relationships-contextual-vs-direct', category: 'relationships', priority: 'medium', reason: 'Distinguishing a genuine relationship from a contextual mention is exactly what the deterministic assertion layer exists to protect.', suggestedTools: ['extract_relationships'] },
  // People
  { id: 'people-leadership', category: 'people', priority: 'medium', reason: 'Leadership identity and background inform credibility and standing.', suggestedTools: ['fetch_web_page', 'extract_entities'] },
  // Thought leadership
  { id: 'thought-leadership-published', category: 'thought_leadership', priority: 'low', reason: 'Published output is a fact of public record about the organisation\'s activity and focus.', suggestedTools: ['fetch_web_page', 'search_web'] },
  // Ecosystem discovery
  { id: 'ecosystem-significant-organisations', category: 'ecosystem_discovery', priority: 'medium', reason: 'Some discovered organisations recur or appear structurally central — worth a bounded follow-up now rather than only a future Discovery.', suggestedTools: ['fetch_web_page', 'extract_entities'] },
  { id: 'ecosystem-coparty-candidates', category: 'ecosystem_discovery', priority: 'low', reason: 'Co-parties that qualify for Commercial Authority scope in their own right deserve their own future investigation.', suggestedTools: ['record_discovery'] },
]);

function nowIso() {
  return new Date().toISOString();
}

/**
 * generateInitialQuestions() -> the full starting backlog, each question
 * carrying every field the brief requires: id, category, priority,
 * status, supportingEvidenceIds, reason, suggestedTools, createdAt,
 * resolvedAt.
 */
function generateInitialQuestions() {
  const createdAt = nowIso();
  return QUESTION_TEMPLATES.map((t) => ({
    id: t.id,
    category: t.category,
    priority: t.priority,
    status: 'open',
    supportingEvidenceIds: [],
    reason: t.reason,
    suggestedTools: [...t.suggestedTools],
    createdAt,
    resolvedAt: null,
  }));
}

function validateQuestion(question) {
  const errors = [];
  if (!question || typeof question !== 'object') return { valid: false, errors: ['Question must be an object.'] };
  if (!question.id) errors.push('id is required.');
  if (!PRIORITIES.includes(question.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}.`);
  if (!STATUSES.includes(question.status)) errors.push(`status must be one of ${STATUSES.join(', ')}.`);
  if (!Array.isArray(question.supportingEvidenceIds)) errors.push('supportingEvidenceIds must be an array.');
  return { valid: errors.length === 0, errors };
}

/** Marks a question resolved, citing the evidence that resolved it. */
function resolveQuestion(questions, questionId, { evidenceIds = [] } = {}) {
  return questions.map((q) => (q.id === questionId
    ? { ...q, status: 'resolved', supportingEvidenceIds: [...q.supportingEvidenceIds, ...evidenceIds], resolvedAt: nowIso() }
    : q));
}

/** Marks a question dropped (e.g. superseded, no longer relevant) without pretending it was answered. */
function dropQuestion(questions, questionId, { reason } = {}) {
  return questions.map((q) => (q.id === questionId ? { ...q, status: 'dropped', reason: reason || q.reason, resolvedAt: nowIso() } : q));
}

/**
 * refreshQuestions(questions, dossier) — a light, deterministic pass that
 * auto-resolves questions the dossier already honestly answers (e.g.
 * identity fields already known), so the planner never re-asks for
 * something already established.
 */
function refreshQuestions(questions, dossier) {
  let updated = questions;
  const identityKnown = (field) => dossier?.identity?.[field] && dossier.identity[field].value !== undefined;

  if (identityKnown('legalName') || identityKnown('companyNumber')) {
    updated = resolveQuestion(updated, 'identity-legal-entity', {});
  }
  if (identityKnown('companyNumber')) {
    updated = resolveQuestion(updated, 'identity-companies-house', {});
  }
  if ((dossier?.relationshipObservations || []).length > 0) {
    updated = resolveQuestion(updated, 'relationships-connected-bodies', {});
  }
  return updated;
}

/** Returns open questions sorted by priority (high first), for the planner. */
function prioritiseOpenQuestions(questions) {
  const order = { high: 0, medium: 1, low: 2 };
  return questions.filter((q) => q.status === 'open').sort((a, b) => order[a.priority] - order[b.priority]);
}

module.exports = {
  PRIORITIES,
  STATUSES,
  QUESTION_TEMPLATES,
  generateInitialQuestions,
  validateQuestion,
  resolveQuestion,
  dropQuestion,
  refreshQuestions,
  prioritiseOpenQuestions,
};
