'use strict';

/**
 * TLS Evidence Extractor — SOT-TLS-001 v1.0
 *
 * Consumes a TLS Session Evidence Object produced by the TLS Collection Domain Layer
 * and returns a TLS Evidence Object containing all fields owned by SOT-TLS-001.
 * This module does not contact the network and does not write to any database.
 *
 * Authority:
 *   SOT-TLS-001 v1.0 — Implementation Active
 *   TLS_COLLECTION_DOMAIN_LAYER_IMPLEMENTATION.md v1.1
 *   TLS Collection Domain Layer Conformance Review — Outcome B (2026-06-19)
 *
 * Evidence boundary (SOT-TLS-001 §5):
 *   This extractor owns: negotiated_version, cipher_suite_*, forward_secrecy, alpn_protocol,
 *   http2_negotiated, and the three future consideration fields (always null in v1).
 *   Certificate fields (leaf_*, chain_*, certificate_present, tls_verification_result)
 *   are SOT-CERTIFICATE-001 scope and are NOT included here.
 *
 * Conformance review null semantics preserved:
 *   cipher_key_exchange, cipher_symmetric_alg, cipher_mac_hash, forward_secrecy, and
 *   alpn_protocol may each be null on RESPONSE_OBSERVED records:
 *     - cipher fields: null for unrecognised TLS 1.2 ciphers (impl spec §8.1 SI-002)
 *     - forward_secrecy: null when cipher_key_exchange is null
 *     - alpn_protocol: null when server did not negotiate ALPN
 *   Do not coerce these to false or any non-null value.
 */

/**
 * Extract TLS configuration evidence from a TLS Session Evidence Object.
 *
 * All fields from the TLS Session Evidence Object that are owned by SOT-TLS-001
 * are copied verbatim. No interpretation or transformation is applied.
 * The returned object is frozen.
 *
 * @param {object} tlsSession - TLS Session Evidence Object from collectTLSSession()
 * @returns {Readonly<object>} TLS Evidence Object
 * @throws {TypeError} if tlsSession is null or not an object
 */
function extractTLSEvidence(tlsSession) {
  if (!tlsSession || typeof tlsSession !== 'object') {
    throw new TypeError('extractTLSEvidence: tlsSession must be a non-null object');
  }

  return Object.freeze({

    // ── Shared collection context ──────────────────────────────────────────
    // Copied verbatim per SOT-TLS-001 §5.2 (shared evidence at collection layer).
    // Both signals record the same endpoint_state, collected_at, and collection_hostname
    // to independently interpret their own evidence (SOT-TLS-001 §5.2 rationale).
    endpoint_state:         tlsSession.endpoint_state,
    collected_at:           tlsSession.collected_at,
    collection_hostname:    tlsSession.collection_hostname,
    connection_error_code:  tlsSession.connection_error_code,
    connection_error_msg:   tlsSession.connection_error_msg,

    // ── TLS configuration evidence ─────────────────────────────────────────
    // Null on TLS_ERROR and CONNECTION_ERROR outcomes.
    // negotiated_version, cipher_suite_openssl, cipher_suite_standard: non-null on RESPONSE_OBSERVED.
    // Derived fields (cipher_key_exchange, cipher_symmetric_alg, cipher_mac_hash, forward_secrecy):
    //   may be null on RESPONSE_OBSERVED for unrecognised TLS 1.2 cipher names (SI-002).
    negotiated_version:    tlsSession.negotiated_version,
    cipher_suite_openssl:  tlsSession.cipher_suite_openssl,
    cipher_suite_standard: tlsSession.cipher_suite_standard,

    // Derived cipher fields — may be null on RESPONSE_OBSERVED (SI-002).
    // Do not coerce null to any non-null value.
    cipher_key_exchange:   tlsSession.cipher_key_exchange,
    cipher_symmetric_alg:  tlsSession.cipher_symmetric_alg,
    cipher_mac_hash:       tlsSession.cipher_mac_hash,

    // forward_secrecy: null when cipher_key_exchange is null.
    // Null records must be excluded from both numerator and denominator in
    // forward-secrecy COP calculations (SOT-TLS-001 §7.3).
    forward_secrecy:       tlsSession.forward_secrecy,

    // ALPN evidence — null when server did not negotiate ALPN (not the same as false).
    alpn_protocol:    tlsSession.alpn_protocol,
    http2_negotiated: tlsSession.http2_negotiated,

    // ── Future consideration fields (always null in v1) ────────────────────
    // Keys must be present with null values (impl spec §11, absence = collection bug).
    session_ticket_issued: tlsSession.session_ticket_issued,
    ocsp_stapling_present: tlsSession.ocsp_stapling_present,
    key_share_group:       tlsSession.key_share_group,

  });
}

/**
 * Returns the promoted scalar values for indexed database columns.
 *
 * These are the fields that Migration 016 writes to dedicated scalar columns
 * alongside the full JSONB evidence block, per SOT-TLS-001 §4.5.
 *
 * See Migration 016 (016_signal_lab_tls.sql) for the column definitions.
 *
 * @param {Readonly<object>} tlsEvidence - result of extractTLSEvidence()
 * @returns {object} Flat object of promoted scalar values
 */
function promotedScalars(tlsEvidence) {
  return {
    endpoint_state:        tlsEvidence.endpoint_state,
    negotiated_version:    tlsEvidence.negotiated_version,
    cipher_suite_standard: tlsEvidence.cipher_suite_standard,
    // forward_secrecy: nullable — null means cipher key exchange unrecognised,
    // not that forward secrecy is absent. Migrations/extractors must handle null.
    forward_secrecy:       tlsEvidence.forward_secrecy,
    alpn_protocol:         tlsEvidence.alpn_protocol,
    http2_negotiated:      tlsEvidence.http2_negotiated,
  };
}

module.exports = { extractTLSEvidence, promotedScalars };
