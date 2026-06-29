'use strict';
const crypto = require('crypto');

function sha256(value) { return value ? crypto.createHash('sha256').update(value).digest('hex') : null; }

function deriveEvidenceState(locatedState, detectorResult) {
  if (locatedState !== 'located') {
    return { evidence_state: null, currency_raw_value: null, currency_form: null };
  }
  const r = detectorResult || { state: null, rawValue: null, form: null };
  return {
    evidence_state: r.state,
    currency_raw_value: r.rawValue != null ? r.rawValue : null,
    currency_form: r.form != null ? r.form : null,
  };
}

function buildObservation(params) {
  const { runId, domain, collectorVersion, locatedState, discovery, retrieval, detectorResult, content } = params;
  const ev = deriveEvidenceState(locatedState, detectorResult);
  return {
    run_id: runId,
    cohort_id: 'HE-001',
    domain,
    signal_id: 'SOT-DISCLOSURECURRENCY-001',
    signal_version: '1.0',
    collector_version: collectorVersion,
    element_set_version: 'pad-v1',
    located_state: locatedState,
    evidence_state: ev.evidence_state,
    currency_raw_value: ev.currency_raw_value,
    currency_form: ev.currency_form,
    policy_url: (retrieval && retrieval.finalUrl) || (discovery && discovery.policyUrl) || null,
    retrieval_method: (retrieval && retrieval.retrievalMethod) || null,
    http_status: retrieval && retrieval.httpStatus != null ? retrieval.httpStatus : null,
    redirect_chain: (discovery && discovery.redirectChain) || [],
    fetched_at: new Date().toISOString(),
    content_hash: sha256(content),
    raw_content: content || null,
  };
}

async function writeObservation(supabase, row) {
  const { error } = await supabase.from('h_disclosure_currency_observations').insert(row);
  if (error) throw new Error(`insert failed for ${row.domain}: ${error.message}`);
  return row;
}

module.exports = { buildObservation, writeObservation, deriveEvidenceState, sha256 };
