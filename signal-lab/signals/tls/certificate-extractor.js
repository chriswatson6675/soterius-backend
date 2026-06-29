'use strict';

/**
 * Certificate Evidence Extractor — SOT-CERTIFICATE-001 v1.0
 *
 * Consumes a TLS Session Evidence Object produced by the TLS Collection Domain Layer
 * and returns a Certificate Evidence Object containing all fields owned by
 * SOT-CERTIFICATE-001. This module does not contact the network and does not
 * write to any database.
 *
 * Authority:
 *   SOT-CERTIFICATE-001 v1.0 — Implementation Active
 *   TLS_COLLECTION_DOMAIN_LAYER_IMPLEMENTATION.md v1.1
 *   TLS Collection Domain Layer Conformance Review — Outcome B (2026-06-19)
 *
 * Conformance review edge cases preserved here:
 *   D-2: leaf_is_wildcard is null (not false) when leaf_san_entries is empty.
 *        Never coerce null to false. Null means "no SANs — inapplicable."
 *   D-4: After Layer D-4 fix, leaf_extension_parse_errors contains
 *        'Certificate Policies' on every CERTIFICATE_PRESENTED record.
 *        This is correct and expected; do not suppress it.
 *   AR-1: leaf_basic_constraints_ca, leaf_key_type, leaf_key_bits, leaf_key_curve
 *         may be null on CERTIFICATE_PRESENTED records if Node.js does not expose
 *         the underlying undocumented properties. Treat as nullable.
 */

/**
 * Extract certificate evidence from a TLS Session Evidence Object.
 *
 * All fields from the TLS Session Evidence Object that are owned by
 * SOT-CERTIFICATE-001 are copied verbatim. No interpretation or transformation
 * is applied. The returned object is frozen.
 *
 * @param {object} tlsSession - TLS Session Evidence Object from collectTLSSession()
 * @returns {Readonly<object>} Certificate Evidence Object
 * @throws {TypeError} if tlsSession is null or not an object
 */
function extractCertificateEvidence(tlsSession) {
  if (!tlsSession || typeof tlsSession !== 'object') {
    throw new TypeError('extractCertificateEvidence: tlsSession must be a non-null object');
  }

  return Object.freeze({

    // ── Shared collection context ──────────────────────────────────────────
    // Copied verbatim — required to correctly interpret the absence or presence
    // of certificate evidence (SOT-CERTIFICATE-001 §4.3, §4.6).
    endpoint_state:         tlsSession.endpoint_state,
    collected_at:           tlsSession.collected_at,
    collection_hostname:    tlsSession.collection_hostname,
    connection_error_code:  tlsSession.connection_error_code,
    connection_error_msg:   tlsSession.connection_error_msg,

    // ── Certificate presence and verification ──────────────────────────────
    certificate_present:     tlsSession.certificate_present,
    tls_verification_result: tlsSession.tls_verification_result,
    tls_error_code:          tlsSession.tls_error_code,

    // ── Leaf certificate identity ──────────────────────────────────────────
    leaf_subject_cn:          tlsSession.leaf_subject_cn,
    leaf_subject_o:           tlsSession.leaf_subject_o,
    leaf_subject_dn_raw:      tlsSession.leaf_subject_dn_raw,
    leaf_issuer_cn:           tlsSession.leaf_issuer_cn,
    leaf_issuer_o:            tlsSession.leaf_issuer_o,
    leaf_issuer_dn_raw:       tlsSession.leaf_issuer_dn_raw,
    leaf_serial_number:       tlsSession.leaf_serial_number,
    leaf_fingerprint_sha256:  tlsSession.leaf_fingerprint_sha256,
    leaf_signature_algorithm: tlsSession.leaf_signature_algorithm,

    // ── Public key ─────────────────────────────────────────────────────────
    // leaf_key_type, leaf_key_bits, leaf_key_curve may be null on
    // CERTIFICATE_PRESENTED records (AR-1: undocumented Node.js properties).
    leaf_key_type:  tlsSession.leaf_key_type,
    leaf_key_bits:  tlsSession.leaf_key_bits,
    leaf_key_curve: tlsSession.leaf_key_curve,

    // ── Validity period ────────────────────────────────────────────────────
    leaf_not_before:      tlsSession.leaf_not_before,
    leaf_not_after:       tlsSession.leaf_not_after,
    leaf_days_remaining:  tlsSession.leaf_days_remaining,
    leaf_lifetime_days:   tlsSession.leaf_lifetime_days,

    // ── Subject Alternative Names ──────────────────────────────────────────
    leaf_san_entries: tlsSession.leaf_san_entries,
    leaf_san_count:   tlsSession.leaf_san_count,

    // D-2: leaf_is_wildcard is null when leaf_san_entries is empty.
    // Null means "no SANs to evaluate" — not "not a wildcard".
    // Do not coerce null to false.
    leaf_is_wildcard: tlsSession.leaf_is_wildcard,

    // ── Structural indicators ──────────────────────────────────────────────
    leaf_is_self_signed: tlsSession.leaf_is_self_signed,

    // ── Authority Information Access ───────────────────────────────────────
    leaf_aia_ocsp_urls:      tlsSession.leaf_aia_ocsp_urls,
    leaf_aia_ca_issuers_urls: tlsSession.leaf_aia_ca_issuers_urls,

    // ── Certificate Policies ───────────────────────────────────────────────
    // leaf_policy_oids is [] in v1 (Node.js API limitation; ASN.1 parsing required).
    // leaf_extension_parse_errors contains 'Certificate Policies' on every
    // CERTIFICATE_PRESENTED record (D-4 fix). Do not suppress this entry.
    leaf_policy_oids: tlsSession.leaf_policy_oids,

    // ── Basic Constraints ──────────────────────────────────────────────────
    // leaf_basic_constraints_ca may be null (undocumented peerCert.ca property).
    // leaf_basic_constraints_pathlen is always null in v1 (API limitation).
    leaf_basic_constraints_ca:     tlsSession.leaf_basic_constraints_ca,
    leaf_basic_constraints_pathlen: tlsSession.leaf_basic_constraints_pathlen,

    // ── Parse errors ───────────────────────────────────────────────────────
    // Array of strings; never null. Always contains 'Certificate Policies' on
    // CERTIFICATE_PRESENTED records after the D-4 fix is applied to the Layer.
    leaf_extension_parse_errors: tlsSession.leaf_extension_parse_errors,

    // ── Certificate chain ──────────────────────────────────────────────────
    chain_intermediates: tlsSession.chain_intermediates,
    cert_chain_depth:    tlsSession.cert_chain_depth,
    cert_chain_complete: tlsSession.cert_chain_complete,

  });
}

/**
 * Returns the promoted scalar values for indexed database columns.
 *
 * These are the fields that Migration 015 writes to dedicated scalar columns
 * alongside the full JSONB evidence block. Callers (the signal runner or
 * persistence adapter) use this to construct the INSERT statement.
 *
 * See Migration 015 (015_signal_lab_certificate.sql) for the column definitions.
 *
 * @param {Readonly<object>} certEvidence - result of extractCertificateEvidence()
 * @returns {object} Flat object of promoted scalar values
 */
function promotedScalars(certEvidence) {
  return {
    endpoint_state:           certEvidence.endpoint_state,
    certificate_present:      certEvidence.certificate_present,
    tls_error_code:           certEvidence.tls_error_code,
    leaf_days_remaining:      certEvidence.leaf_days_remaining,
    leaf_issuer_cn:           certEvidence.leaf_issuer_cn,
    leaf_issuer_o:            certEvidence.leaf_issuer_o,
    leaf_subject_cn:          certEvidence.leaf_subject_cn,
    leaf_is_self_signed:      certEvidence.leaf_is_self_signed,
    leaf_is_wildcard:         certEvidence.leaf_is_wildcard,
    leaf_fingerprint_sha256:  certEvidence.leaf_fingerprint_sha256,
  };
}

module.exports = { extractCertificateEvidence, promotedScalars };
