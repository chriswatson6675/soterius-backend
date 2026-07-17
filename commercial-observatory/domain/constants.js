'use strict';

// Commercial Observatory — shared domain vocabulary (MVP-0).
//
// Plain frozen arrays + membership checks, matching this codebase's existing
// convention of hand-rolled enum validation (e.g. migration CHECK constraints,
// api/utils/validators.js) rather than introducing a schema library. This is
// the single source of truth these enums are validated against everywhere
// else in this module — persistence, domain constructors, and the DB CHECK
// constraints in migration 050 are all derived from this list by hand and
// must be kept in sync.

const INVESTIGATION_STATUSES = Object.freeze([
  'pending', 'running', 'completed', 'partial', 'failed', 'cancelled',
]);

// Controlled status transitions (Investigation lifecycle, §B of the prior
// execution-architecture design). `cancelled` is reachable from any
// non-terminal state.
//
// Amended for the website-research task: `completed` and `failed` are
// re-enterable via `running` too, not just `partial` — reunning the same
// Investigation (e.g. to pick up newly-published pages, or retry after a
// homepage failure) is an explicit requirement of that task and was not
// anticipated when this table originally treated `completed`/`failed` as
// dead ends. `cancelled` remains genuinely terminal — a deliberate stop is
// not auto-resumed.
const INVESTIGATION_STATUS_TRANSITIONS = Object.freeze({
  pending:   ['running', 'cancelled'],
  running:   ['completed', 'partial', 'failed', 'cancelled'],
  completed: ['running'], // a rerun/resumed Research Session
  failed:    ['running'], // a retried Research Session
  partial:   ['running'], // a resumed Research Session (see execution design §C)
  failed:    [],
  cancelled: [],
});

const DRAFT_REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected']);

// Claim lifecycle status. Not enumerated in the founder's brief — added here
// because the commercial_claims table requires a status column and none was
// specified; see the deviations note in the final response for the reasoning.
const CLAIM_STATUSES = Object.freeze(['active', 'superseded', 'rejected']);

const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

const RELATIONSHIP_CONFIDENCE_STATES = Object.freeze(['hypothesis', 'probable', 'verified']);

const RELATIONSHIP_TYPES = Object.freeze([
  'regulator',
  'professional_body',
  'certification_body',
  'trade_association',
  'client',
  'client_sector',
  'software_vendor',
  'technology_partner',
  'referral_partner',
  'strategic_partner',
  'affiliated_organisation',
  'consultant',
  'training_provider',
  'conference_organiser',
  'thought_leader',
  'supplier',
  'competitor',
  'unclassified',
]);

// Direction is always explicit and never inferred from relationship type
// (per the founder's instruction). 'outbound' = the third party acts upon /
// serves / certifies the investigation's subject; 'inbound' = the subject
// acts upon / serves the third party; 'mutual' = reciprocal or undirected
// (e.g. affiliated_organisation, strategic_partner, competitor).
const RELATIONSHIP_DIRECTIONS = Object.freeze(['outbound', 'inbound', 'mutual']);

const EVIDENCE_CLASSES = Object.freeze(['public', 'published', 'third_party', 'manual']);

const AGENT_EVENT_TYPES = Object.freeze([
  'investigation_created',
  'session_started',
  'session_ended',
  'observation_recorded',
  'claim_recorded',
  'evidence_stored',
  'relationship_observed',
  'discovery_emitted',
  'question_generated',
  'contradiction_recorded',
  'tool_call_failed',
  'draft_created',
  'draft_reviewed',
]);

function isOneOf(value, allowedValues) {
  return allowedValues.includes(value);
}

function canTransitionInvestigationStatus(from, to) {
  const allowed = INVESTIGATION_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  INVESTIGATION_STATUSES,
  INVESTIGATION_STATUS_TRANSITIONS,
  DRAFT_REVIEW_STATES,
  CLAIM_STATUSES,
  CONFIDENCE_LEVELS,
  RELATIONSHIP_CONFIDENCE_STATES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_DIRECTIONS,
  EVIDENCE_CLASSES,
  AGENT_EVENT_TYPES,
  isOneOf,
  canTransitionInvestigationStatus,
};
