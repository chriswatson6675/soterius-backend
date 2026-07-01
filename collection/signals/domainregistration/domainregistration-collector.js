'use strict';

// domainregistration-collector.js — Domain Registration Facts collector
//
// Implements SOT-DOMAINREGISTRATION-001 v1.4 — Domain Registration Facts.
// Single RDAP query per domain. Classifies privacy state. Derives lifecycle
// and status observations. Persists complete evidence to signal_domainregistration_v1.
//
// Collection boundary (SLG-011 + SOT-DOMAINREGISTRATION-001 §5.3):
//   - One RDAP query per domain per run (single authoritative registry endpoint)
//   - Protocol-mandated redirects (RFC 7480 §5.2) followed
//   - Registrar referral links (rel=related) NOT followed — URL extracted only
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Authority: COL-DOMAINREGISTRATION-001 Part 1–3 — Collector Purpose, Architecture,
//            Collection Workflow

const { loadBootstrap, resolveRdapEndpoint }  = require('./rdap-bootstrap');
const { queryRdap, createRateManager }         = require('./rdap-client');
const { parseRdapResponse }                    = require('./rdap-parser');
const { determinePrivacyState, loadPspIndex }  = require('./privacy-engine');
const { classifyTld, loadTldSnapshot }         = require('./tld-classifier');
const { buildEvidence, extractPromotedScalars } = require('./evidence-builder');

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNAL_ID       = 'domainregistration';
const SIGNAL_VERSION  = '1.4';
const COLLECTOR_VERSION = '1.0.0';
const TABLE_NAME      = 'signal_domainregistration_v1';

// Five endpoint state vocabulary (SOT-DOMAINREGISTRATION-001 §6.1)
const ENDPOINT_STATES = Object.freeze({
  RDAP_RESPONSE_OBSERVED: 'RDAP_RESPONSE_OBSERVED',
  DOMAIN_NOT_FOUND:       'DOMAIN_NOT_FOUND',
  RDAP_ERROR:             'RDAP_ERROR',
  RDAP_NOT_SUPPORTED:     'RDAP_NOT_SUPPORTED',
  CONNECTION_ERROR:       'CONNECTION_ERROR',
});

// ── Run context ───────────────────────────────────────────────────────────────

/**
 * Initialises all shared run resources. Must be called once before the
 * collection loop. Returns a context object passed to collectDomainRegistrationSignal().
 *
 * @param {Object} [options]
 * @param {number} [options.defaultRateDelayMs=500]
 * @param {Object} [options.registryDelays={}] - rdapBaseUrl → delay override (ms)
 * @returns {Promise<RunContext>}
 */
async function initialiseRunContext(options = {}) {
  const [bootstrapCache, pspIndex, tldSnapshot] = await Promise.all([
    loadBootstrap(),
    Promise.resolve(loadPspIndex()),
    Promise.resolve(loadTldSnapshot()),
  ]);

  const rateManager = createRateManager({
    defaultDelayMs:  options.defaultRateDelayMs ?? 500,
    registryDelays:  options.registryDelays ?? {},
  });

  return {
    bootstrapCache,
    pspIndex,
    tldSnapshot,
    rateManager,
  };
}

// ── Per-domain collection ─────────────────────────────────────────────────────

/**
 * Collects domain registration facts for a single domain.
 * Implements the §7.3 collection workflow (Steps 1–7).
 * Never rejects — errors are captured in the evidence object.
 *
 * @param {string} domain
 * @param {RunContext} ctx - Shared run context from initialiseRunContext()
 * @param {Object} [options]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @returns {Promise<CollectionResult>}
 */
async function collectDomainRegistrationSignal(domain, ctx, options = {}) {
  const collectedAt = new Date().toISOString();

  // Step 1: Determine RDAP endpoint from bootstrap
  const endpoint = resolveRdapEndpoint(domain, ctx.bootstrapCache);

  if (!endpoint) {
    // No RDAP endpoint for this TLD
    const tldClass = ctx.tldSnapshot.classify(domain, null);
    const evidence = buildEvidence({
      domain, collectedAt,
      endpointState: ENDPOINT_STATES.RDAP_NOT_SUPPORTED,
      rdapBaseUrl: null, redirectChain: [null],
      errorCode: 'NO_RDAP_ENDPOINT', errorMessage: 'No RDAP endpoint registered for this TLD',
      parsed: null, privacyResult: null, tldClass,
      tldSnapshotDate: ctx.tldSnapshot.snapshotDate,
    });
    return { evidence, warnings: [] };
  }

  const { rdapBaseUrl, queryUrl } = endpoint;

  // Steps 2–3: Execute RDAP request, classify endpoint state
  const httpResult = await queryRdap(queryUrl, rdapBaseUrl, ctx.rateManager, options);

  const { endpointState, rdapJson, errorCode, errorMessage } = _classifyHttpResult(httpResult);

  // TLD classification (available regardless of endpoint state). Suffix
  // extraction is governed by the PSL inside the classifier (P1-1a); the prior
  // registry-URL substring heuristic has been removed.
  const tldClass    = ctx.tldSnapshot.classify(domain, null);

  if (endpointState !== ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED) {
    const evidence = buildEvidence({
      domain, collectedAt, endpointState,
      rdapBaseUrl, redirectChain: httpResult.redirectChain,
      errorCode, errorMessage,
      parsed: null, privacyResult: null, tldClass,
      tldSnapshotDate: ctx.tldSnapshot.snapshotDate,
    });
    return { evidence, warnings: [] };
  }

  // Step 4: Parse RDAP response
  const parsed = parseRdapResponse(rdapJson, domain);

  // Step 5: Determine privacy state
  const privacyResult = determinePrivacyState(
    parsed.registrantEntity,
    parsed.rdapMetadata?.rdapRemarks ?? null,
    ctx.pspIndex,
  );

  // Steps 6–7: Build complete evidence object
  const evidence = buildEvidence({
    domain, collectedAt,
    endpointState: ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED,
    rdapBaseUrl, redirectChain: httpResult.redirectChain,
    errorCode: null, errorMessage: null,
    parsed, privacyResult, tldClass,
    tldSnapshotDate: ctx.tldSnapshot.snapshotDate,
  });

  return { evidence, warnings: parsed.warnings };
}

// ── Endpoint state classification ─────────────────────────────────────────────

function _classifyHttpResult(httpResult) {
  if (httpResult.errorType === 'NONE') {
    // Parse JSON body
    let rdapJson = null;
    try {
      rdapJson = JSON.parse(httpResult.responseBody);
    } catch (err) {
      return {
        endpointState: ENDPOINT_STATES.RDAP_ERROR,
        rdapJson:      null,
        errorCode:     'JSON_PARSE_ERROR',
        errorMessage:  err.message,
      };
    }
    return {
      endpointState: ENDPOINT_STATES.RDAP_RESPONSE_OBSERVED,
      rdapJson,
      errorCode:     null,
      errorMessage:  null,
    };
  }

  if (httpResult.errorType === 'DOMAIN_NOT_FOUND') {
    return {
      endpointState: ENDPOINT_STATES.DOMAIN_NOT_FOUND,
      rdapJson:      null,
      errorCode:     httpResult.errorCode,
      errorMessage:  httpResult.errorMessage,
    };
  }

  if (httpResult.errorType === 'CONNECTION_ERROR') {
    return {
      endpointState: ENDPOINT_STATES.CONNECTION_ERROR,
      rdapJson:      null,
      errorCode:     httpResult.errorCode,
      errorMessage:  httpResult.errorMessage,
    };
  }

  // RDAP_ERROR (4xx/5xx/redirect overflow)
  return {
    endpointState: ENDPOINT_STATES.RDAP_ERROR,
    rdapJson:      null,
    errorCode:     httpResult.errorCode,
    errorMessage:  httpResult.errorMessage,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Inserts a single collection result into signal_domainregistration_v1.
 *
 * @param {Object} supabase - Supabase client
 * @param {string} runId
 * @param {string} domain
 * @param {EvidenceObject} evidence
 * @returns {Promise<{error: Object|null}>}
 */
async function persistObservation(supabase, runId, domain, evidence) {
  const scalars = extractPromotedScalars(evidence);

  const row = {
    run_id:           runId,
    domain:           domain,
    collected_at:     evidence.collected_at,
    signal_version:   SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,

    // 12 promoted scalar columns
    endpoint_state:              scalars.endpoint_state,
    privacy_state:               scalars.privacy_state,
    privacy_service_present:     scalars.privacy_service_present,
    privacy_service_provider_id: scalars.privacy_service_provider_id,
    registrar_iana_id:           scalars.registrar_iana_id,
    registrant_country_code:     scalars.registrant_country_code,
    transfer_lock_present:       scalars.transfer_lock_present,
    domain_active:               scalars.domain_active,
    pending_delete:              scalars.pending_delete,
    tld_type:                    scalars.tld_type,
    domain_age_days:             scalars.domain_age_days,
    expiry_days_remaining:       scalars.expiry_days_remaining,

    // Complete evidence JSONB
    evidence,
  };

  const { error } = await supabase.from(TABLE_NAME).insert(row);
  return { error: error ?? null };
}

// ── Full collection run orchestrator ─────────────────────────────────────────

/**
 * Runs the full collection loop over a domain list.
 * Manages concurrency, logging, and run metrics.
 *
 * @param {Object} params
 * @param {string[]}  params.domains - Ordered domain list
 * @param {Object}    params.supabase - Supabase client
 * @param {string}    params.runId
 * @param {RunContext} params.ctx
 * @param {number}    [params.concurrency=1] - RDAP is rate-managed; default sequential
 * @param {Object}    [params.perDomainOptions] - Options forwarded to collectDomainRegistrationSignal
 * @param {function}  [params.onProgress] - Called after each domain: (domain, i, total, result)
 * @returns {Promise<RunMetrics>}
 */
async function runCollector({ domains, supabase, runId, ctx, concurrency = 1, perDomainOptions = {}, onProgress }) {
  const total    = domains.length;
  const metrics  = _initMetrics();
  const results  = new Array(total);
  let   next     = 0;

  async function worker() {
    while (next < total) {
      const i      = next++;
      const domain = domains[i];

      let result;
      try {
        result = await collectDomainRegistrationSignal(domain, ctx, perDomainOptions);
      } catch (err) {
        // collectDomainRegistrationSignal should never reject, but guard anyway
        result = {
          evidence: _errorEvidence(domain, err),
          warnings: [],
        };
      }

      const { error: dbError } = await persistObservation(supabase, runId, domain, result.evidence);

      _accumulateMetrics(metrics, domain, result, dbError);
      results[i] = { domain, evidence: result.evidence, warnings: result.warnings, dbError };

      if (onProgress) onProgress(domain, i, total, result, dbError);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, worker);
  await Promise.all(workers);

  metrics.completedAt = new Date().toISOString();
  return { metrics, results };
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

function _initMetrics() {
  return {
    total:              0,
    successCount:       0,
    dbErrorCount:       0,
    dbErrorDomains:     [],
    warningCount:       0,
    endpointStateCounts: Object.fromEntries(Object.values(ENDPOINT_STATES).map(s => [s, 0])),
    startedAt:          new Date().toISOString(),
    completedAt:        null,
  };
}

function _accumulateMetrics(metrics, domain, result, dbError) {
  metrics.total++;

  const state = result.evidence.endpoint_state;
  if (state in metrics.endpointStateCounts) {
    metrics.endpointStateCounts[state]++;
  }

  if (dbError) {
    metrics.dbErrorCount++;
    metrics.dbErrorDomains.push({ domain, error: dbError.message ?? String(dbError) });
  } else {
    metrics.successCount++;
  }

  if (result.warnings?.length > 0) metrics.warningCount++;
}

function _errorEvidence(domain, err) {
  return {
    endpoint_state:    ENDPOINT_STATES.CONNECTION_ERROR,
    collected_at:      new Date().toISOString(),
    collection_domain: domain,
    error_code:        'COLLECTOR_EXCEPTION',
    error_message:     err.message ?? String(err),
    // All other fields: null — the buildEvidence function handles this normally,
    // but in the guard path we provide a minimal valid structure
    ...Object.fromEntries([
      'rdap_endpoint_resolved', 'rdap_redirect_chain',
      'registry_domain_id', 'domain_name_ldh', 'domain_name_unicode',
      'creation_date', 'expiration_date', 'last_update_date',
      'nameservers', 'status_codes', 'event_history',
      'rdap_conformance', 'rdap_remarks', 'rdap_notices',
      'rdap_self_link', 'rdap_registrar_referral_url',
      'registrar_name', 'registrar_iana_id', 'registrar_url',
      'registrar_abuse_email', 'registrar_abuse_telephone', 'registrar_entity_handle',
      'privacy_state', 'privacy_service_name', 'privacy_service_provider_id',
      'privacy_service_detection_version',
      'registrant_org_name', 'registrant_full_name', 'registrant_email',
      'registrant_telephone', 'registrant_address_street', 'registrant_address_city',
      'registrant_address_state', 'registrant_address_postal',
      'registrant_country_code', 'registrant_handle', 'registrant_roles',
      'registrant_status_codes',
      'admin_org_name', 'admin_full_name', 'admin_email',
      'admin_telephone', 'admin_country_code', 'admin_handle',
      'tech_org_name', 'tech_full_name', 'tech_email',
      'tech_telephone', 'tech_country_code', 'tech_handle',
      'tld_string', 'tld_type', 'tld_country_code', 'tld_classification_snapshot_date',
      'domain_age_days', 'expiry_days_remaining', 'registration_term_days',
      'privacy_service_present', 'transfer_lock_present', 'domain_active',
      'pending_delete', 'server_hold_present',
      'billing_contact', 'legacy_whois_text', 'rdap_entities_raw',
    ].map(k => [k, null])),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  collectDomainRegistrationSignal,
  runCollector,
  initialiseRunContext,
  persistObservation,
  SIGNAL_ID,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  TABLE_NAME,
  ENDPOINT_STATES,
};

/**
 * @typedef {Object} RunContext
 * @property {BootstrapCache} bootstrapCache
 * @property {PspIndex} pspIndex
 * @property {TldSnapshot} tldSnapshot
 * @property {RateManager} rateManager
 */

/**
 * @typedef {Object} CollectionResult
 * @property {EvidenceObject} evidence
 * @property {Array} warnings
 */

/**
 * @typedef {Object} RunMetrics
 * @property {number} total
 * @property {number} successCount
 * @property {number} dbErrorCount
 * @property {string[]} dbErrorDomains
 * @property {number} warningCount
 * @property {Object} endpointStateCounts
 * @property {string} startedAt
 * @property {string|null} completedAt
 */
