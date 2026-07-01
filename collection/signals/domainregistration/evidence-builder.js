'use strict';

// evidence-builder.js — §7.1 evidence object assembly and promoted scalar extraction
//
// Assembles the complete 70-field evidence object from all layer outputs.
// All 70 keys must be present. No undefined values. No omitted keys.
//
// Derived fields (SOT-DOMAINREGISTRATION-001 §7.2–§7.3):
//   Lifecycle: domain_age_days, expiry_days_remaining, registration_term_days
//   Status booleans (tristate): transfer_lock_present, domain_active,
//                                pending_delete, server_hold_present,
//                                privacy_service_present
//
// Future-consideration fields always null in v1:
//   billing_contact, legacy_whois_text, rdap_entities_raw
//
// Negative values for domain_age_days and expiry_days_remaining are valid
// (pre-dated registration or already-expired domain). No lower-bound clamping.
//
// Authority: COL-DOMAINREGISTRATION-001 Part 7 — Evidence Construction

// ── EPP status codes used for derived boolean derivation ─────────────────────

// Transfer lock: either of these codes indicates transfer is prohibited
const TRANSFER_LOCK_CODES = new Set([
  'clienttransferprohibited',
  'servertransferprohibited',
  'client transfer prohibited',
  'server transfer prohibited',
]);

// Domain active: these codes indicate the domain is operationally active
const DOMAIN_ACTIVE_CODES = new Set(['ok', 'active']);

// Pending delete indicator
const PENDING_DELETE_CODES = new Set(['pendingdelete', 'pending delete']);

// Server hold indicator
const SERVER_HOLD_CODES = new Set(['serverhold', 'server hold']);

// ── Main evidence builder ─────────────────────────────────────────────────────

/**
 * Assembles the complete §7.1 evidence object from all layer outputs.
 *
 * @param {Object} params
 * @param {string}  params.domain
 * @param {string}  params.collectedAt - ISO 8601 UTC timestamp
 * @param {string}  params.endpointState - One of five RDAP endpoint state values
 * @param {string|null}  params.rdapBaseUrl
 * @param {string[]} params.redirectChain
 * @param {string|null}  params.errorCode
 * @param {string|null}  params.errorMessage
 * @param {Object|null}  params.parsed - Output from rdap-parser.js parseRdapResponse()
 * @param {Object|null}  params.privacyResult - Output from privacy-engine.js determinePrivacyState()
 * @param {Object}  params.tldClass - Output from tld-classifier.js classifyTld()
 * @param {string}  params.tldSnapshotDate
 * @returns {EvidenceObject} Complete 70-field evidence object
 */
function buildEvidence({
  domain,
  collectedAt,
  endpointState,
  rdapBaseUrl,
  redirectChain,
  errorCode,
  errorMessage,
  parsed,
  privacyResult,
  tldClass,
  tldSnapshotDate,
}) {
  const core      = parsed?.registrationCore ?? null;
  const meta      = parsed?.rdapMetadata ?? null;
  const registrar = parsed?.registrarEntity ?? null;
  const registrant = parsed?.registrantEntity ?? null;
  const admin     = parsed?.adminEntity ?? null;
  const tech      = parsed?.techEntity ?? null;

  // Derive lifecycle and status fields from parsed evidence
  const derivedLifecycle = _deriveLifecycle(core, collectedAt);
  const derivedStatus    = _deriveStatus(core, privacyResult);

  return {
    // ── Collection context (always populated) ─────────────────────────────
    endpoint_state:                  endpointState,
    collected_at:                    collectedAt,
    collection_domain:               domain,
    rdap_endpoint_resolved:          rdapBaseUrl ?? null,
    rdap_redirect_chain:             redirectChain.length > 1 ? redirectChain : null,
    error_code:                      errorCode ?? null,
    error_message:                   errorMessage ?? null,

    // ── Registration core (null when not RDAP_RESPONSE_OBSERVED) ─────────
    registry_domain_id:              core?.registryDomainId ?? null,
    domain_name_ldh:                 core?.domainNameLdh ?? null,
    domain_name_unicode:             core?.domainNameUnicode ?? null,
    creation_date:                   core?.creationDate ?? null,
    expiration_date:                 core?.expirationDate ?? null,
    last_update_date:                core?.lastUpdateDate ?? null,
    nameservers:                     core?.nameservers ?? null,
    status_codes:                    core?.statusCodes ?? null,
    event_history:                   core?.eventHistory ?? null,

    // ── RDAP protocol metadata ────────────────────────────────────────────
    rdap_conformance:                meta?.rdapConformance ?? null,
    rdap_remarks:                    meta?.rdapRemarks ?? null,
    rdap_notices:                    meta?.rdapNotices ?? null,
    rdap_self_link:                  meta?.rdapSelfLink ?? null,
    rdap_registrar_referral_url:     meta?.rdapRegistrarReferralUrl ?? null,

    // ── Registrar entity ──────────────────────────────────────────────────
    registrar_name:                  registrar?.vCard?.fn ?? null,
    registrar_iana_id:               registrar?.registrarIanaId ?? null,
    // §3.20 / §5.2: registrar URL is the registrar entity's vCard `url`, not the
    // RDAP entity self-link (which is not the registrar's website) (P0-3 / M3).
    registrar_url:                   registrar?.vCard?.url ?? null,
    registrar_abuse_email:           registrar?.registrarAbuseEmail ?? null,
    registrar_abuse_telephone:       registrar?.registrarAbuseTel ?? null,
    registrar_entity_handle:         registrar?.handle ?? null,

    // ── Privacy state ─────────────────────────────────────────────────────
    privacy_state:                   privacyResult?.privacyState ?? null,
    privacy_service_name:            privacyResult?.privacyServiceName ?? null,
    privacy_service_provider_id:     privacyResult?.privacyServiceProviderId ?? null,
    privacy_service_detection_version: privacyResult?.detectionVersion ?? null,

    // ── Registrant entity ─────────────────────────────────────────────────
    registrant_org_name:             registrant?.vCard?.org ?? null,
    registrant_full_name:            registrant?.vCard?.fn ?? null,
    registrant_email:                registrant?.vCard?.email ?? null,
    registrant_telephone:            registrant?.vCard?.tel ?? null,
    registrant_address_street:       registrant?.vCard?.street ?? null,
    registrant_address_city:         registrant?.vCard?.city ?? null,
    registrant_address_state:        registrant?.vCard?.state ?? null,
    registrant_address_postal:       registrant?.vCard?.postal ?? null,
    // Raw RDAP priority (§4.5; §6.3 "Unexpected ≠ Invalid"): the country is
    // preserved verbatim in the evidence block. Normalisation to ISO 3166-1
    // alpha-2 happens only at the promoted scalar (extractPromotedScalars) (M5).
    registrant_country_code:         registrant?.vCard?.country ?? null,
    registrant_handle:               registrant?.handle ?? null,
    registrant_roles:                registrant?.roles ?? null,
    registrant_status_codes:         registrant?.statusCodes ?? null,

    // ── Admin contact ─────────────────────────────────────────────────────
    admin_org_name:                  admin?.vCard?.org ?? null,
    admin_full_name:                 admin?.vCard?.fn ?? null,
    admin_email:                     admin?.vCard?.email ?? null,
    admin_telephone:                 admin?.vCard?.tel ?? null,
    admin_country_code:              admin?.vCard?.country ?? null,
    admin_handle:                    admin?.handle ?? null,

    // ── Technical contact ─────────────────────────────────────────────────
    tech_org_name:                   tech?.vCard?.org ?? null,
    tech_full_name:                  tech?.vCard?.fn ?? null,
    tech_email:                      tech?.vCard?.email ?? null,
    tech_telephone:                  tech?.vCard?.tel ?? null,
    tech_country_code:               tech?.vCard?.country ?? null,
    tech_handle:                     tech?.handle ?? null,

    // ── TLD classification ────────────────────────────────────────────────
    tld_string:                      tldClass?.tldString ?? null,
    tld_type:                        tldClass?.tldType ?? null,
    tld_country_code:                tldClass?.tldCountryCode ?? null,
    tld_classification_snapshot_date: tldSnapshotDate ?? null,

    // ── Derived lifecycle (null if source dates absent) ───────────────────
    domain_age_days:                 derivedLifecycle.domainAgeDays,
    expiry_days_remaining:           derivedLifecycle.expiryDaysRemaining,
    registration_term_days:          derivedLifecycle.registrationTermDays,

    // ── Derived status booleans (tristate — NO ?? null coalescing) ────────
    // These fields must preserve false as false. Direct assignment only.
    privacy_service_present:         derivedStatus.privacyServicePresent,
    transfer_lock_present:           derivedStatus.transferLockPresent,
    domain_active:                   derivedStatus.domainActive,
    pending_delete:                  derivedStatus.pendingDelete,
    server_hold_present:             derivedStatus.serverHoldPresent,

    // ── Future consideration — always null in v1 ──────────────────────────
    billing_contact:                 null,
    legacy_whois_text:               null,
    rdap_entities_raw:               null,
  };
}

// ── Promoted scalar extractor ─────────────────────────────────────────────────

/**
 * Extracts the 12 promoted scalar columns from a complete evidence object.
 * These map directly to the named columns in signal_domainregistration_v1.
 *
 * @param {EvidenceObject} evidence
 * @returns {PromotedScalars}
 */
function extractPromotedScalars(evidence) {
  return {
    endpoint_state:              evidence.endpoint_state,
    privacy_state:               evidence.privacy_state,
    privacy_service_present:     evidence.privacy_service_present,
    privacy_service_provider_id: evidence.privacy_service_provider_id,
    registrar_iana_id:           evidence.registrar_iana_id,
    // Promoted/indexed scalar is normalised to ISO 3166-1 alpha-2 for
    // jurisdictional queries (§3.23); the raw value remains in the JSONB
    // evidence block (M5). Non-conforming raw → null scalar only.
    registrant_country_code:     _normaliseCountryCode(evidence.registrant_country_code),
    transfer_lock_present:       evidence.transfer_lock_present,
    domain_active:               evidence.domain_active,
    pending_delete:              evidence.pending_delete,
    tld_type:                    evidence.tld_type,
    domain_age_days:             evidence.domain_age_days,
    expiry_days_remaining:       evidence.expiry_days_remaining,
  };
}

// ── Derived lifecycle ─────────────────────────────────────────────────────────

function _deriveLifecycle(core, collectedAt) {
  if (!core) {
    return { domainAgeDays: null, expiryDaysRemaining: null, registrationTermDays: null };
  }

  const now            = new Date(collectedAt).getTime();
  const creationMs     = _parseIsoMs(core.creationDate);
  const expirationMs   = _parseIsoMs(core.expirationDate);

  // domain_age_days and expiry_days_remaining can legitimately be negative.
  // No lower-bound CHECK constraint. No clamping. (SOT-DOMAINREGISTRATION-001 §7.2)
  const domainAgeDays = creationMs != null
    ? Math.floor((now - creationMs) / 86400000)
    : null;

  const expiryDaysRemaining = expirationMs != null
    ? Math.floor((expirationMs - now) / 86400000)
    : null;

  const registrationTermDays = (creationMs != null && expirationMs != null)
    ? Math.floor((expirationMs - creationMs) / 86400000)
    : null;

  return { domainAgeDays, expiryDaysRemaining, registrationTermDays };
}

// ── Derived status (tristate booleans) ───────────────────────────────────────

function _deriveStatus(core, privacyResult) {
  const statusCodes = core?.statusCodes ?? null;

  return {
    // privacy_service_present comes from the privacy engine, not status codes
    privacyServicePresent: privacyResult?.privacyServicePresent ?? null,

    // Status booleans: true if code present, false if status array present but code absent, null if no status array
    transferLockPresent: _deriveStatusBoolean(statusCodes, TRANSFER_LOCK_CODES),
    domainActive:        _deriveStatusBoolean(statusCodes, DOMAIN_ACTIVE_CODES),
    pendingDelete:       _deriveStatusBoolean(statusCodes, PENDING_DELETE_CODES),
    serverHoldPresent:   _deriveStatusBoolean(statusCodes, SERVER_HOLD_CODES),
  };
}

/**
 * Derives a tristate boolean from an EPP status code array.
 * - null  → statusCodes array is null (no status evidence)
 * - true  → any code in matchSet is present (case-insensitive)
 * - false → statusCodes present but no matching code
 *
 * @param {string[]|null} statusCodes
 * @param {Set<string>} matchSet - Lowercase code strings
 * @returns {boolean|null}
 */
function _deriveStatusBoolean(statusCodes, matchSet) {
  if (!Array.isArray(statusCodes)) return null;
  return statusCodes.some(code => matchSet.has(code.toLowerCase()));
}

// ── Country code normalisation ────────────────────────────────────────────────

/**
 * Normalises a country code string to ISO 3166-1 alpha-2 uppercase format for the
 * promoted/indexed scalar column. Returns null if the value is absent or does not
 * match the expected format. This is applied ONLY at the promoted-scalar boundary
 * (extractPromotedScalars); the raw country value is preserved verbatim in the
 * JSONB evidence block (registrant_/admin_/tech_country_code), so a non-conforming
 * value nulls only the indexed scalar and is never lost from the evidence (M5).
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function _normaliseCountryCode(raw) {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  // ISO 3166-1 alpha-2: exactly 2 uppercase letters
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _parseIsoMs(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  return isNaN(ms) ? null : ms;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buildEvidence, extractPromotedScalars };

/**
 * @typedef {Object} EvidenceObject - Complete 70-field §7.1 evidence block
 */

/**
 * @typedef {Object} PromotedScalars - 12 promoted scalar column values
 * @property {string} endpoint_state
 * @property {string|null} privacy_state
 * @property {boolean|null} privacy_service_present
 * @property {string|null} privacy_service_provider_id
 * @property {string|null} registrar_iana_id
 * @property {string|null} registrant_country_code
 * @property {boolean|null} transfer_lock_present
 * @property {boolean|null} domain_active
 * @property {boolean|null} pending_delete
 * @property {string|null} tld_type
 * @property {number|null} domain_age_days
 * @property {number|null} expiry_days_remaining
 */
