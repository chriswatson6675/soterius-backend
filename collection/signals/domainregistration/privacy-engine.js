'use strict';

// privacy-engine.js — Four-state privacy detection engine
//
// Implements SOT-DOMAINREGISTRATION-001 §7.5 privacy state determination.
// Loads and matches against PSD-001 v1.2 reference list (v1.json).
//
// Privacy state vocabulary:
//   REGISTRANT_DATA  — genuine registrant contact data is present
//   PRIVACY_SERVICE  — a known privacy service entity is the registrant
//   REDACTED         — RDAP response indicates data is withheld (GDPR etc.)
//   ENTITY_ABSENT    — no registrant-role entity in the RDAP response
//
// privacy_service_present tristate:
//   true  → PRIVACY_SERVICE
//   false → REGISTRANT_DATA
//   null  → REDACTED or ENTITY_ABSENT
//
// Detection sequence (§7.5) — short-circuits at first match:
//   Step 1: Entity presence check   → ENTITY_ABSENT
//   Step 2: Redaction notice check  → REDACTED
//   Step 3: PSP reference list lookup → PRIVACY_SERVICE
//   Step 4: Default                  → REGISTRANT_DATA
//
// Authority: COL-DOMAINREGISTRATION-001 Part 6 — Privacy-State Engine

const fs   = require('node:fs');
const path = require('node:path');

// ── Constants ─────────────────────────────────────────────────────────────────

const PSP_LIST_PATH = path.join(
  __dirname, '../../data/privacy-service-reference/v1.json'
);

// Legal entity suffixes for iterative Step 5 normalisation (PSD-001 §7.2)
const LEGAL_SUFFIXES = ['llc', 'ltd', 'inc', 'pty', 'gmbh', 'ehf', 'corp', 'limited'];

// Redaction indicators — RDAP remark titles and description fragments
const REDACTION_TITLES = new Set([
  'object redaction',
  'redacted for privacy',
  'registrant information',
  'personal data redacted',
]);
const REDACTION_DESC_FRAGMENTS = [
  'redacted for privacy',
  'personal data in whois',
  'gdpr',
  'withheld for privacy',
];
const REDACTION_REMARK_TYPES = new Set([
  'object redacted due to authorization',
  'object truncated due to authorization',
]);

// ── PSP reference list loader ─────────────────────────────────────────────────

/**
 * Loads the PSD-001 privacy service reference list from v1.json.
 * Builds three lookup structures for the three-step matching sequence.
 *
 * @param {string} [listPath] - Override path (for testing)
 * @returns {PspIndex}
 */
function loadPspIndex(listPath = PSP_LIST_PATH) {
  const raw  = fs.readFileSync(listPath, 'utf8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.entries)) {
    throw new Error('privacy-service-reference v1.json missing entries array');
  }

  const version = data.dataset_version ?? 1;

  // Three lookup maps for the three-step matching sequence
  const byProviderName  = new Map(); // lowerCase(provider_name) → entry
  const byNormalisedName = new Map(); // normalised_name → entry
  const byAlias         = new Map(); // normalise(alias) → entry

  for (const entry of data.entries) {
    if (entry.status !== 'ACTIVE') continue;

    byProviderName.set(entry.provider_name.toLowerCase(), entry);
    byNormalisedName.set(entry.normalised_name, entry);

    for (const alias of (entry.known_aliases ?? [])) {
      const normAlias = normaliseProviderName(alias);
      if (normAlias) byAlias.set(normAlias, entry);
    }
  }

  return { version, byProviderName, byNormalisedName, byAlias };
}

// ── Main privacy state function ───────────────────────────────────────────────

/**
 * Determines the privacy state for a domain based on its parsed RDAP evidence.
 * Implements the §7.5 detection sequence.
 *
 * @param {Object|null} registrantEntity - Parsed registrant entity (from rdap-parser)
 * @param {Array|null} rdapRemarks - Full remarks array from RDAP response
 * @param {PspIndex} pspIndex - Loaded PSP reference index
 * @returns {PrivacyStateResult}
 */
function determinePrivacyState(registrantEntity, rdapRemarks, pspIndex) {
  // Step 1: Entity presence check
  if (!registrantEntity) {
    return {
      privacyState:              'ENTITY_ABSENT',
      privacyServicePresent:     null,
      privacyServiceName:        null,
      privacyServiceProviderId:  null,
      detectionVersion:          pspIndex.version,
    };
  }

  // Step 2: Redaction notice check
  if (_isRedacted(registrantEntity, rdapRemarks)) {
    return {
      privacyState:              'REDACTED',
      privacyServicePresent:     null,
      privacyServiceName:        null,
      privacyServiceProviderId:  null,
      detectionVersion:          pspIndex.version,
    };
  }

  // Step 3: PSP reference list lookup
  // Check both fn (full name) and org — either match is sufficient
  const candidateNames = [
    registrantEntity.vCard?.fn,
    registrantEntity.vCard?.org,
  ].filter(Boolean);

  for (const name of candidateNames) {
    const match = _lookupPsp(name, pspIndex);
    if (match) {
      return {
        privacyState:              'PRIVACY_SERVICE',
        privacyServicePresent:     true,
        privacyServiceName:        name,
        privacyServiceProviderId:  match.provider_id,
        detectionVersion:          pspIndex.version,
      };
    }
  }

  // Step 4: Default
  return {
    privacyState:              'REGISTRANT_DATA',
    privacyServicePresent:     false,
    privacyServiceName:        null,
    privacyServiceProviderId:  null,
    detectionVersion:          pspIndex.version,
  };
}

// ── PSP lookup (three-step sequence) ─────────────────────────────────────────

/**
 * Attempts to match a registrant name string against the PSP index.
 * Three steps per PSD-001 §6.3:
 *   1. Exact match (case-insensitive) against provider_name
 *   2. Normalised match (Steps 0–5) against normalised_name
 *   3. Alias match (normalised input vs normalised aliases)
 *
 * Fuzzy, substring, and ML matching are prohibited (PSD-001 §6.4).
 *
 * @param {string} name - Raw registrant name from RDAP
 * @param {PspIndex} pspIndex
 * @returns {Object|null} Matched PSP entry or null
 */
function _lookupPsp(name, pspIndex) {
  // Step 0 normalisation applied before any matching
  const step0 = _applyStep0(name);

  // Step 1: Exact match (case-insensitive)
  const exactMatch = pspIndex.byProviderName.get(step0.toLowerCase());
  if (exactMatch) return exactMatch;

  // Steps 1–5 normalisation
  const normalised = normaliseProviderName(name);
  if (!normalised) return null;

  // Step 2: Normalised name match
  const normMatch = pspIndex.byNormalisedName.get(normalised);
  if (normMatch) return normMatch;

  // Step 3: Alias match
  const aliasMatch = pspIndex.byAlias.get(normalised);
  if (aliasMatch) return aliasMatch;

  return null;
}

// ── Normalisation function (PSD-001 §7.2) ────────────────────────────────────

/**
 * Applies PSD-001 §7.2 Steps 0–5 normalisation to a provider name string.
 *
 * Step 0: Strip " Customer [N]" suffix (Contact Privacy Inc. pattern)
 * Step 1: Lowercase
 * Step 2: Strip punctuation (non-alphanumeric, non-space)
 * Step 3: Collapse whitespace
 * Step 4: Trim
 * Step 5: Iterative legal suffix removal
 *
 * @param {string|null|undefined} input
 * @returns {string|null} Normalised string, or null if input is empty/null
 */
function normaliseProviderName(input) {
  if (!input || typeof input !== 'string') return null;

  // Step 0: strip Customer [N] suffix
  let s = _applyStep0(input);

  // Step 1: lowercase
  s = s.toLowerCase();

  // Step 2: strip punctuation (keep alphanumeric and space only)
  s = s.replace(/[^a-z0-9 ]/g, '');

  // Step 3: collapse whitespace
  s = s.replace(/\s+/g, ' ');

  // Step 4: trim
  s = s.trim();

  // Step 5: iterative suffix removal
  s = _iterativeSuffixRemoval(s);

  return s.length > 0 ? s : null;
}

function _applyStep0(input) {
  // Strips " Customer N" or " Customer 12345" suffix (case-insensitive)
  return input.replace(/\s+customer\s+\d+$/i, '').trim();
}

function _iterativeSuffixRemoval(s) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) {
        s = '';
        changed = true;
        break;
      }
      if (s.endsWith(' ' + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

// ── Redaction detection ───────────────────────────────────────────────────────

/**
 * Returns true if the RDAP response indicates registrant data is redacted.
 * Checks remarks array for ICANN-standardised and GDPR redaction indicators.
 * Also checks if registrant contact fields are all null/absent.
 *
 * @param {Object} registrantEntity - Present (non-null) registrant entity
 * @param {Array|null} rdapRemarks
 * @returns {boolean}
 */
function _isRedacted(registrantEntity, rdapRemarks) {
  const hasRedactionRemarks = _remarksIndicateRedaction(rdapRemarks);
  if (!hasRedactionRemarks) return false;

  // Redaction remarks present — confirm contact fields are absent/redacted
  const vCard = registrantEntity.vCard ?? {};
  const contactFieldsAbsent = !vCard.email && !vCard.tel && !vCard.street && !vCard.postal;

  return contactFieldsAbsent;
}

function _remarksIndicateRedaction(rdapRemarks) {
  if (!Array.isArray(rdapRemarks)) return false;

  for (const remark of rdapRemarks) {
    // Check remark type
    if (remark.type && REDACTION_REMARK_TYPES.has(remark.type.toLowerCase())) return true;

    // Check remark title
    if (remark.title && REDACTION_TITLES.has(remark.title.toLowerCase())) return true;

    // Check description fragments
    if (Array.isArray(remark.description)) {
      for (const desc of remark.description) {
        const lower = (desc ?? '').toLowerCase();
        if (REDACTION_DESC_FRAGMENTS.some(f => lower.includes(f))) return true;
      }
    }
  }

  return false;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { determinePrivacyState, normaliseProviderName, loadPspIndex };

/**
 * @typedef {Object} PspIndex
 * @property {number} version
 * @property {Map<string, Object>} byProviderName
 * @property {Map<string, Object>} byNormalisedName
 * @property {Map<string, Object>} byAlias
 */

/**
 * @typedef {Object} PrivacyStateResult
 * @property {'REGISTRANT_DATA'|'PRIVACY_SERVICE'|'REDACTED'|'ENTITY_ABSENT'} privacyState
 * @property {boolean|null} privacyServicePresent
 * @property {string|null} privacyServiceName
 * @property {string|null} privacyServiceProviderId
 * @property {number} detectionVersion
 */
