'use strict';

// db.js — Domain Discovery Pilot persistence, mirroring
// commercial-observatory/persistence/db.js's DI convention exactly:
// injectable deps.client, {success,data}/{success:false,error} returns,
// no throws on expected failures. Every table this module touches is
// prefixed domain_discovery_pilot_ and defined in migration 051, isolated
// from organisations/domains/scans/commercial_* — no FKs into any of those.

const { getClient } = require('../../infra/database');
const logger = require('../../infra/utils/logger');

function client(deps) {
  return (deps && deps.client) || getClient();
}

async function insertOne(table, row, deps = {}) {
  try {
    const { data, error } = await client(deps).from(table).insert([row]).select('*').single();
    if (error) { logger.error(`domain-discovery-pilot ${table} insert failed: ${error.message}`); return { success: false, error: error.message }; }
    return { success: true, data };
  } catch (err) {
    logger.error(`domain-discovery-pilot ${table} insert threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function insertCandidate(candidate, deps = {}) {
  return insertOne('domain_discovery_pilot_candidates', {
    hmrc_registration_number: candidate.hmrcRegistrationNumber,
    business_name: candidate.businessName,
    trading_name: candidate.tradingName,
    postcode: candidate.postcode,
    sample_rank: candidate.sampleRank,
    derived_category: candidate.derivedCategory,
    name_ambiguity_class: candidate.nameAmbiguityClass,
    name_divergence_class: candidate.nameDivergenceClass,
    entity_form_class: candidate.entityFormClass,
    postcode_completeness_class: candidate.postcodeCompletenessClass,
    region_class: candidate.regionClass,
    urban_rural_class: candidate.urbanRuralClass,
    floor_pass_selected: candidate.floorPassSelected,
    sampling_rule_version: candidate.samplingRuleVersion,
  }, deps);
}

function insertPrefilterResult(candidateId, hmrcRegistrationNumber, result, deps = {}) {
  return insertOne('domain_discovery_pilot_prefilter', {
    candidate_id: candidateId,
    hmrc_registration_number: hmrcRegistrationNumber,
    match_query_inputs: result.matchQueryInputs ?? null,
    ra_search_candidates: result.raSearchCandidates ?? null,
    classification: result.classification,
    matched_organisation_id: result.matchedOrganisationId ?? null,
    matched_domain_status: result.matchedDomainStatus ?? null,
    freshness_check: result.freshnessCheck ?? null,
    final_brave_decision: result.finalBraveDecision,
    decision_reason: result.decisionReason,
    prefilter_rule_version: result.prefilterRuleVersion,
  }, deps);
}

function insertQuery(candidateId, query, deps = {}) {
  return insertOne('domain_discovery_pilot_queries', {
    candidate_id: candidateId,
    query_template_version: query.queryTemplateVersion,
    query_string: query.queryString,
    brave_request_params: query.braveRequestParams ?? null,
    brave_raw_response: query.rawResponse ?? null,
    request_id: query.requestId ?? null,
    status: query.success ? 'success' : 'failed',
    retryable: query.error ? !!query.error.retryable : false,
  }, deps);
}

function insertSearchResult(queryId, result, deps = {}) {
  const row = {
    query_id: queryId,
    rank: result.rank ?? null,
    title: result.title ?? null,
    snippet: result.snippet ?? null,
    url: result.url,
    source: result.source ?? null,
    provider_metadata: result.providerMetadata ?? null,
  };
  // retrieved_at has a DB-side DEFAULT now() — only set it explicitly when
  // the provider result actually carries its own retrievedAt, so a result
  // without one still gets a sensible value instead of a NOT NULL failure.
  if (result.retrievedAt) row.retrieved_at = result.retrievedAt;
  return insertOne('domain_discovery_pilot_search_results', row, deps);
}

function insertPageFetch(candidateId, searchResultId, page, deps = {}) {
  const r = page.fetchResult || {};
  return insertOne('domain_discovery_pilot_page_fetches', {
    candidate_id: candidateId,
    search_result_id: searchResultId ?? null,
    requested_url: page.requestedUrl,
    final_url: r.finalUrl ?? null,
    status: r.status ?? (r.success ? 200 : null),
    content_type: r.contentType ?? null,
    page_role: page.pageRole,
    raw_body: r.body ?? null,
  }, deps);
}

function insertEvidence(candidateId, pageFetchId, evidence, deps = {}) {
  return insertOne('domain_discovery_pilot_evidence', {
    candidate_id: candidateId,
    page_fetch_id: pageFetchId,
    company_number: evidence.companyNumber,
    legal_name: evidence.legalName,
    trading_name_found: evidence.tradingNameFound,
    postcode_found: evidence.postcodeFound,
    address_found: evidence.addressFound,
    telephone_found: evidence.telephoneFound,
    principals: evidence.principals,
    category_consistency: evidence.categoryConsistency,
    extraction_rule_version: evidence.extractionRuleVersion,
  }, deps);
}

function insertDecision(candidateId, decision, deps = {}) {
  return insertOne('domain_discovery_pilot_decisions', {
    candidate_id: candidateId,
    decision_state: decision.decisionState,
    score_total: decision.scoreTotal,
    score_breakdown: decision.scoreBreakdown,
    matched_domain: decision.matchedDomain,
    disqualifier_reason: decision.disqualifierReason,
    scoring_rule_version: decision.scoringRuleVersion,
  }, deps);
}

module.exports = {
  insertCandidate, insertPrefilterResult, insertQuery, insertSearchResult,
  insertPageFetch, insertEvidence, insertDecision,
};
