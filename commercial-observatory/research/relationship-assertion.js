'use strict';

// Relationship Assertion Model — the precision pass that decides whether a
// sentence genuinely supports a relationship between the investigation's
// TARGET organisation and a detected third-party ENTITY, rather than
// merely containing both somewhere in the same sentence (the bug this
// module exists to fix — see the HMRC false positive this was built for).
//
// Deterministic, rule-based, no LLM/NLP service. The governing discipline:
// require a defensible syntactic connection — target reference, entity
// reference, and relationship phrase must actually relate to one another,
// not just co-occur — and default to the conservative outcome (contextual,
// not a relationship) whenever that connection cannot be demonstrated.

const {
  RELATIONSHIP_TYPES,
  RELATIONSHIP_DIRECTIONS,
  RELATIONSHIP_CONFIDENCE_STATES,
} = require('../domain/constants');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Relationship phrases ──────────────────────────────────────────────────
//
// subjectCheck governs how the phrase's structural connection to the
// target is validated:
//   'before'     — the word/phrase immediately preceding the match (after
//                  stripping copulas/fillers) must be a target reference
//                  (or, for reversible phrases, may instead be the entity
//                  itself — see 'reversible').
//   'either'     — a target reference OR the entity may sit immediately
//                  before the phrase (partnership language is inherently
//                  reciprocal — direction stays 'mutual' either way).
//   'reversible' — subject-before may be the target (forward mapping) OR
//                  the entity (reverse mapping, using reverseType/
//                  reverseDirection) — the OTHER party must then be found
//                  as the object, immediately after the phrase.
//   'embedded'   — the phrase regex itself already contains an explicit
//                  target reference (e.g. "our technology partner"), so no
//                  separate subject check is needed; only entity co-
//                  occurrence in the sentence is required.
const RELATIONSHIP_PHRASE_DEFINITIONS = Object.freeze([
  { key: 'authorised_and_regulated_by', regex: /authorised and regulated by/i, relationshipType: 'regulator', relationshipDirection: 'outbound', relationshipConfidenceState: 'verified', subjectCheck: 'before' },
  { key: 'authorised_by', regex: /\bauthorised by\b/i, relationshipType: 'regulator', relationshipDirection: 'outbound', relationshipConfidenceState: 'verified', subjectCheck: 'before' },
  { key: 'regulated_by', regex: /\bregulated by\b/i, relationshipType: 'regulator', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'registered_with', regex: /\bregistered with\b/i, relationshipType: 'regulator', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'member_of', regex: /\bmember of\b/i, relationshipType: 'professional_body', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'certified_by', regex: /\bcertified by\b/i, relationshipType: 'certification_body', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'accredited_by', regex: /\baccredited by\b/i, relationshipType: 'certification_body', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'accreditation_from', regex: /\baccreditation from\b/i, relationshipType: 'certification_body', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },

  { key: 'in_partnership_with', regex: /\bin partnership with\b/i, relationshipType: 'strategic_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'partnered_with', regex: /\bpartnered with\b/i, relationshipType: 'strategic_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'partner_with', regex: /\bpartner with\b/i, relationshipType: 'strategic_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'official_partner_of', regex: /\bofficial partner of\b/i, relationshipType: 'strategic_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'affiliated_with', regex: /\baffiliated with\b/i, relationshipType: 'affiliated_organisation', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'technology_partner', regex: /\btechnology partner\b/i, relationshipType: 'technology_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'integrates_with', regex: /\bintegrates? with\b/i, relationshipType: 'technology_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },
  { key: 'referral_partner', regex: /\breferral partner\b/i, relationshipType: 'referral_partner', relationshipDirection: 'mutual', relationshipConfidenceState: 'probable', subjectCheck: 'either' },

  {
    key: 'provides_services_to', regex: /\bprovides?\s+[a-z\s]{0,40}?(services?|consultancy|advice|support)\s+to\b/i,
    relationshipType: 'client', relationshipDirection: 'inbound', relationshipConfidenceState: 'probable', subjectCheck: 'reversible',
    reverseType: 'supplier', reverseDirection: 'outbound',
  },
  {
    key: 'client_of', regex: /\bclient of\b/i,
    relationshipType: 'supplier', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'reversible',
    reverseType: 'client', reverseDirection: 'inbound',
  },
  { key: 'supplied_by', regex: /\bsupplied by\b/i, relationshipType: 'supplier', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },
  { key: 'trained_with', regex: /\btrained with\b/i, relationshipType: 'training_provider', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'before' },

  // Embedded — the phrase itself already contains an explicit first-person
  // target reference ("our"/"we"), so no separate subject-before check is
  // required; still gated behind isTargetAuthored (see below).
  { key: 'our_software_platform', regex: /\bas our\s+[a-z\s]{0,20}(platform|software|system|tool)\b/i, relationshipType: 'software_vendor', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'embedded' },
  { key: 'our_supplier_is', regex: /\bour supplier is\b/i, relationshipType: 'supplier', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'embedded' },
  { key: 'our_consultant_is', regex: /\bour consultant is\b/i, relationshipType: 'consultant', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'embedded' },
  { key: 'advises_us', regex: /\badvises (us|our firm|our team|our company)\b/i, relationshipType: 'consultant', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'embedded' },
  { key: 'our_training_provided_by', regex: /\bour training (?:is |was )?provided by\b/i, relationshipType: 'training_provider', relationshipDirection: 'outbound', relationshipConfidenceState: 'probable', subjectCheck: 'embedded' },
]);

// ── Explicit exclusion patterns (Part 5) ──────────────────────────────────
// Checked against the whole sentence, independent of subject-position
// analysis — literal, high-precision "this sentence is not making a claim
// about the target's own relationship" signals.
const EXCLUSION_PATTERNS = Object.freeze([
  { regex: /\bnot regulated by\b/i, classification: 'general_context', reason: 'Explicit negation ("not regulated by") — the relationship is denied, not asserted.' },
  { regex: /\bnot affiliated with\b/i, classification: 'general_context', reason: 'Explicit negation ("not affiliated with").' },
  { regex: /\bno relationship with\b/i, classification: 'general_context', reason: 'Explicit negation ("no relationship with").' },
  { regex: /\bfirms regulated by\b/i, classification: 'target_advises_entity_regulated_sector', reason: 'Describes the regulatory status of the target\'s clients/sector, not the target\'s own regulator.' },
  { regex: /\bclients regulated by\b/i, classification: 'target_advises_entity_regulated_sector', reason: 'Describes the regulatory status of the target\'s clients, not the target\'s own regulator.' },
  { regex: /\bon behalf of a client\b/i, classification: 'general_context', reason: 'Acting on behalf of an unspecified client, not asserting the target\'s own relationship.' },
  { regex: /\bformerly employed by\b/i, classification: 'employee_history', reason: 'Describes a person\'s past employment, not a relationship held by the target organisation.' },
  { regex: /\bpreviously worked (for|at)\b/i, classification: 'employee_history', reason: 'Describes a person\'s past employment, not a relationship held by the target organisation.' },
  { regex: /\bused to work (for|at)\b/i, classification: 'employee_history', reason: 'Describes a person\'s past employment, not a relationship held by the target organisation.' },
  { regex: /\bformer (employee|director|partner|staff member) of\b/i, classification: 'employee_history', reason: 'Describes a person\'s past employment, not a relationship held by the target organisation.' },
  { regex: /\bguidance issued by\b/i, classification: 'policy_requirement', reason: 'A general publication/guidance reference, not a relationship claim.' },
  { regex: /\baccording to\b/i, classification: 'general_context', reason: 'An attributed statement/citation, not a relationship claim.' },
  { regex: /\breported by\b/i, classification: 'general_context', reason: 'A news/reporting attribution, not a relationship claim.' },
  { regex: /\brequired by\b/i, classification: 'policy_requirement', reason: 'A general regulatory requirement, not a relationship claim.' },
  { regex: /\bmust register with\b/i, classification: 'policy_requirement', reason: 'A general regulatory requirement addressed to an unspecified party, not a claim about the target.' },
  { regex: /\bmay complain to\b/i, classification: 'policy_requirement', reason: 'A general consumer-rights reference, not a relationship claim.' },
  { regex: /\bsubject to\b/i, classification: 'policy_requirement', reason: 'A general regulatory-scope reference, not a relationship claim.' },
  { regex: /\bdiscussed by\b/i, classification: 'general_context', reason: 'An editorial/discussion reference, not a relationship claim.' },
  { regex: /\ban article about\b/i, classification: 'general_context', reason: 'Editorial/thought-leadership content about a topic, not a relationship claim.' },
  { regex: /\bat the same (conference|event)\b/i, classification: 'general_context', reason: 'Co-attendance at an event is not, by itself, an organisational relationship.' },
  { regex: /\bmay complain to\b/i, classification: 'policy_requirement', reason: 'A general consumer-rights reference, not a relationship claim.' },
]);

// Blocking subject nouns: when the phrase's grammatical subject is one of
// these (rather than the target itself), the sentence describes an
// unspecified/generic third party — never the target — even though the
// phrase and entity both appear in the sentence.
const BLOCKING_SUBJECT_WORDS = ['firms', 'clients', 'organisations', 'organizations', 'businesses', 'agents', 'advisers', 'advisors', 'individuals', 'persons', 'anyone', 'someone', 'entities', 'companies'];

const ADVISE_VERB_NEARBY = /\badvis\w*\b/i;

const COPULA_AND_FILLER_WORDS = new Set(['is', 'are', 'was', 'were', 'been', 'being', 'has', 'have', 'that', 'which', 'who', 'a', 'an', 'also', 'currently', 'now', 'still']);

const PRONOUN_TARGET_REFERENCES = Object.freeze(['we', 'our', 'our firm', 'our team', 'our company', 'the firm', 'the company']);

function stripTrailingFillers(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  while (words.length && COPULA_AND_FILLER_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) {
    words.pop();
  }
  return words.join(' ');
}

function stripLeadingFillers(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  while (words.length && COPULA_AND_FILLER_WORDS.has(words[0].toLowerCase().replace(/[^a-z]/g, ''))) {
    words.shift();
  }
  return words.join(' ');
}

/**
 * Builds the target-reference patterns used to test whether a tail (text
 * immediately before a phrase) or head (text immediately after a phrase)
 * refers to the investigation target. Pronoun forms ("we"/"our"/...) are
 * only included when `isTargetAuthored` is true — a bare "we"/"our" on a
 * page NOT authored by the target (e.g. a discovered third party's own
 * site, or press coverage) does not refer to the investigation subject.
 */
function buildTargetReferenceFragments(targetName, targetAliases, isTargetAuthored) {
  const fragments = [];
  if (targetName) fragments.push(escapeRegex(targetName));
  for (const alias of targetAliases || []) fragments.push(escapeRegex(alias));
  if (isTargetAuthored) {
    for (const p of PRONOUN_TARGET_REFERENCES) fragments.push(escapeRegex(p));
  }
  return fragments;
}

function endsWithAny(text, fragments) {
  return fragments.some((f) => new RegExp(`\\b${f}$`, 'i').test(text));
}

function startsWithAny(text, fragments) {
  return fragments.some((f) => new RegExp(`^${f}\\b`, 'i').test(text));
}

function endsWithEntity(text, entityText) {
  if (!entityText) return false;
  return new RegExp(`\\b${escapeRegex(entityText)}$`, 'i').test(text);
}

function startsWithEntity(text, entityText) {
  if (!entityText) return false;
  return new RegExp(`^${escapeRegex(entityText)}\\b`, 'i').test(text);
}

// Bounded-window variant: allows a short verb gap between a subject
// reference and the relationship phrase ("We WORK in partnership with X",
// "We ARE PLEASED TO partner with X") without requiring exact adjacency.
// Deliberately still bounded (default 4 words), NOT "anywhere in the
// sentence" — the failure mode this module exists to prevent. Callers must
// check the more specific, exactly-adjacent BLOCKING_SUBJECT_WORDS check
// first (see assessRelationshipAssertion) so a literal "firms"/"clients"
// immediately before the phrase is never overridden by an earlier "we".
function withinTailWindow(tailChunk, fragments, maxWords = 8) {
  const words = tailChunk.trim().split(/\s+/).filter(Boolean);
  const windowStr = words.slice(-maxWords).join(' ');
  return fragments.some((f) => new RegExp(`\\b${f}\\b`, 'i').test(windowStr));
}

function findFirstMatchingPhrase(sentence) {
  for (const def of RELATIONSHIP_PHRASE_DEFINITIONS) {
    const match = def.regex.exec(sentence);
    if (match) return { def, match };
  }
  return null;
}

function findExclusion(sentence) {
  for (const ex of EXCLUSION_PATTERNS) {
    if (ex.regex.test(sentence)) return ex;
  }
  return null;
}

/**
 * assessRelationshipAssertion({ sentence, entityText, targetName,
 *   targetAliases, isTargetAuthored }) -> {
 *     supported, classification, direction, confidence, reason,
 *     matchedPattern, relationshipType, relationshipConfidenceState,
 *     targetReference, entityReference,
 *   }
 *
 * Deterministic — no LLM/NLP service. `sentence` should already be a
 * single-sentence excerpt (entity-detection.js's sentence splitter); this
 * module does not itself split sentences, so a caller passing a multi-
 * sentence block risks the exact cross-sentence contamination this module
 * exists to prevent.
 */
function assessRelationshipAssertion({ sentence, entityText, targetName, targetAliases = [], isTargetAuthored = true } = {}) {
  const text = sentence || '';

  // Exclusion patterns are checked FIRST, independent of whether a tracked
  // relationship phrase is present — "previously worked for" or "may
  // complain to" should classify correctly even when no RELATIONSHIP_PHRASE
  // definition happens to match the same sentence.
  const earlyExclusion = findExclusion(text);
  if (earlyExclusion) {
    return {
      supported: false, classification: earlyExclusion.classification, direction: null, confidence: null,
      reason: earlyExclusion.reason, matchedPattern: null,
      relationshipType: null, relationshipConfidenceState: null, targetReference: null, entityReference: entityText || null,
    };
  }

  const found = findFirstMatchingPhrase(text);
  if (!found) {
    return {
      supported: false, classification: 'general_context', direction: null, confidence: null,
      reason: 'No relationship phrase found in this sentence.', matchedPattern: null,
      relationshipType: null, relationshipConfidenceState: null, targetReference: null, entityReference: entityText || null,
    };
  }

  const { def, match } = found;
  const phraseStart = match.index;
  const phraseEnd = match.index + match[0].length;
  const before = sentence.slice(0, phraseStart);
  const after = sentence.slice(phraseEnd);
  const targetFragments = buildTargetReferenceFragments(targetName, targetAliases, isTargetAuthored);

  const baseResult = {
    matchedPattern: def.key,
    relationshipType: def.relationshipType,
    relationshipConfidenceState: def.relationshipConfidenceState,
  };

  // 1. Explicit exclusion patterns — literal, highest priority.
  const exclusion = findExclusion(sentence);
  if (exclusion) {
    return { ...baseResult, supported: false, classification: exclusion.classification, direction: null, confidence: null, reason: exclusion.reason, targetReference: null, entityReference: entityText || null };
  }

  // 2. Negation immediately before the phrase (belt-and-braces beyond the
  // literal exclusion list above, for phrasing the literal list doesn't
  // cover verbatim).
  const negationWindow = before.split(/\s+/).slice(-4).join(' ');
  if (/\b(not|no|never|cannot|can't|isn't|aren't|doesn't|don't|wasn't|weren't)\b/i.test(negationWindow)) {
    return { ...baseResult, supported: false, classification: 'general_context', direction: null, confidence: null, reason: 'Relationship phrase is negated in the immediately preceding text.', targetReference: null, entityReference: entityText || null };
  }

  // 3. Embedded phrases — target reference is part of the phrase itself.
  if (def.subjectCheck === 'embedded') {
    if (!isTargetAuthored) {
      return { ...baseResult, supported: false, classification: 'ambiguous', direction: null, confidence: null, reason: 'First-person relationship language only counts on target-authored content.', targetReference: null, entityReference: entityText || null };
    }
    return {
      ...baseResult, supported: true, classification: 'target_relationship', direction: def.relationshipDirection,
      confidence: 'medium', reason: `Phrase "${def.key}" is self-contained with an explicit first-person target reference.`,
      targetReference: '(embedded in phrase)', entityReference: entityText || null,
    };
  }

  const tailChunk = stripTrailingFillers(before);
  const headChunk = stripLeadingFillers(after);

  // 4. Subject-before-phrase analysis. The exact-last-word BLOCKING check
  // is deliberately evaluated BEFORE the (bounded-window, verb-gap-
  // tolerant) target-reference check: "We advise firms regulated by the
  // FCA" must reject on "firms" even though "we" also appears earlier in
  // the same tail — specificity of the immediately-adjacent word wins.
  const tailIsBlocking = BLOCKING_SUBJECT_WORDS.some((w) => new RegExp(`\\b${w}$`, 'i').test(tailChunk));
  const tailIsEntity = endsWithEntity(tailChunk, entityText);
  const tailIsTarget = !tailIsBlocking && withinTailWindow(tailChunk, targetFragments);

  if (tailIsBlocking) {
    if (ADVISE_VERB_NEARBY.test(before)) {
      return { ...baseResult, supported: false, classification: 'target_advises_entity_regulated_sector', direction: null, confidence: null, reason: `The sentence describes advice given to "${tailChunk.split(/\s+/).pop()}" regulated/certified by the entity, not the target's own relationship to it.`, targetReference: null, entityReference: entityText || null };
    }
    return { ...baseResult, supported: false, classification: 'policy_requirement', direction: null, confidence: null, reason: `The phrase applies to an unspecified third party ("${tailChunk.split(/\s+/).pop()}"), not to the target.`, targetReference: null, entityReference: entityText || null };
  }

  if (tailIsTarget) {
    return {
      ...baseResult, supported: true, classification: 'target_relationship', direction: def.relationshipDirection,
      confidence: 'medium', reason: `Target reference precedes the "${def.key}" phrase.`,
      targetReference: tailChunk, entityReference: entityText || null,
    };
  }

  if (def.subjectCheck === 'reversible' && tailIsEntity) {
    // Entity is the grammatical subject — the relationship only holds if
    // the target appears as the object, immediately after the phrase.
    if (startsWithAny(headChunk, targetFragments)) {
      return {
        ...baseResult, supported: true, classification: 'target_relationship', direction: def.reverseDirection,
        confidence: 'medium', reason: `Entity is the subject of "${def.key}", with the target as its object.`,
        relationshipType: def.reverseType, targetReference: headChunk, entityReference: entityText || null,
      };
    }
    return { ...baseResult, supported: false, classification: 'third_party_relationship', direction: null, confidence: null, reason: 'Entity is the subject of this phrase, but the target does not appear as its object.', targetReference: null, entityReference: entityText || null };
  }

  if (def.subjectCheck === 'either' && tailIsEntity) {
    // Partnership-type language is reciprocal — direction stays as defined
    // regardless of which party is grammatically first, provided the
    // target appears somewhere as the counterpart (object position).
    if (startsWithAny(headChunk, targetFragments)) {
      return {
        ...baseResult, supported: true, classification: 'target_relationship', direction: def.relationshipDirection,
        confidence: 'medium', reason: `Entity precedes the "${def.key}" phrase, with the target named as its counterpart.`,
        targetReference: '(found as counterpart)', entityReference: entityText || null,
      };
    }
    return { ...baseResult, supported: false, classification: 'third_party_relationship', direction: null, confidence: null, reason: 'Entity is adjacent to this phrase, but no target reference is found as its counterpart.', targetReference: null, entityReference: entityText || null };
  }

  // 5. No structural connection established. Distinguish "target mentioned
  // elsewhere in the sentence but not connected" (ambiguous — conservative
  // reject) from "target not mentioned at all" (third_party_relationship).
  const targetAppearsAnywhere = targetFragments.some((f) => new RegExp(`\\b${f}\\b`, 'i').test(sentence));
  return {
    ...baseResult, supported: false,
    classification: targetAppearsAnywhere ? 'ambiguous' : 'third_party_relationship',
    direction: null, confidence: null,
    reason: targetAppearsAnywhere
      ? 'The target is mentioned in this sentence, but not in a position that structurally connects it to the relationship phrase.'
      : 'The target organisation is not referenced in this sentence at all.',
    targetReference: null, entityReference: entityText || null,
  };
}

module.exports = {
  assessRelationshipAssertion,
  RELATIONSHIP_PHRASE_DEFINITIONS,
  EXCLUSION_PATTERNS,
  BLOCKING_SUBJECT_WORDS,
  PRONOUN_TARGET_REFERENCES,
};
