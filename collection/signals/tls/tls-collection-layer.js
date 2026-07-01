'use strict';

const tls = require('tls');

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_PORT = 443;
const DEFAULT_TIMEOUT = 30000;
const MAX_CHAIN_DEPTH = 10;
const ALPN_PROTOCOLS = ['h2', 'http/1.1'];

// Error codes that indicate TCP/network-layer failure (CONNECTION_ERROR)
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);

// Map from Node.js authorizationError strings to tls_verification_result values
const VERIFICATION_MAP = {
  CERT_HAS_EXPIRED:                    'CERT_EXPIRED',
  CERT_NOT_YET_VALID:                  'CERT_NOT_YET_VALID',
  ERR_TLS_CERT_ALTNAME_INVALID:        'HOSTNAME_MISMATCH',
  DEPTH_ZERO_SELF_SIGNED_CERT:         'SELF_SIGNED',
  SELF_SIGNED_CERT_IN_CHAIN:           'SELF_SIGNED_IN_CHAIN',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:     'CHAIN_UNVERIFIABLE',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:   'CHAIN_UNVERIFIABLE',
  CERT_REVOKED:                        'CERT_REVOKED',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates a per-run context. Must be shared across all signal runners
 * for the same collection run to enforce C-1 (one TLS session per domain).
 * @returns {{ sessions: Map<string, Promise<object>> }}
 */
function createRunContext() {
  return { sessions: new Map() };
}

/**
 * Returns a TLS Session Evidence Object for `domain`. Never rejects.
 * Concurrent callers for the same domain within the same runContext
 * share a single TLS session (C-1 guarantee).
 *
 * @param {string} domain
 * @param {{ sessions: Map }} runContext
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<object>}
 */
function collectTLSSession(domain, runContext, options = {}) {
  // C-1: return existing promise if domain already requested this run
  if (runContext.sessions.has(domain)) {
    return runContext.sessions.get(domain);
  }

  // Store the promise SYNCHRONOUSLY before any await to prevent race conditions.
  // JavaScript's single-threaded event loop guarantees that concurrent callers
  // see this stored promise before the async work begins.
  const promise = _initiateSession(domain, options);
  runContext.sessions.set(domain, promise);
  return promise;
}

// ── Internal session establishment ────────────────────────────────────────────

async function _initiateSession(domain, options) {
  const timeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_TIMEOUT;
  const port    = typeof options.port    === 'number' ? options.port    : TARGET_PORT;
  const collectedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let settled = false;

    function settle(evidence) {
      if (settled) return;
      settled = true;
      resolve(Object.freeze(evidence));
    }

    const socket = tls.connect({
      host: domain,
      port,
      servername: domain,
      rejectUnauthorized: false,
      ALPNProtocols: ALPN_PROTOCOLS,
      timeout,
    });

    socket.on('timeout', () => {
      socket.destroy();
      settle(_buildFailureEvidence(domain, collectedAt, 'CONNECTION_ERROR', 'ETIMEDOUT', 'Connection timed out'));
    });

    socket.on('error', (err) => {
      const code = err.code || 'UNKNOWN';
      const state = CONNECTION_ERROR_CODES.has(code) ? 'CONNECTION_ERROR' : 'TLS_ERROR';
      settle(_buildFailureEvidence(domain, collectedAt, state, code, err.message));
    });

    socket.on('secureConnect', () => {
      try {
        const evidence = _extractSuccessEvidence(domain, collectedAt, socket);
        settle(evidence);
      } catch (err) {
        settle(_buildFailureEvidence(domain, collectedAt, 'CONNECTION_ERROR', 'EVIDENCE_EXTRACTION_ERROR', err.message));
      } finally {
        socket.destroy();
      }
    });
  });
}

// ── Evidence extraction (RESPONSE_OBSERVED path) ──────────────────────────────

function _extractSuccessEvidence(domain, collectedAt, socket) {
  const protocol  = socket.getProtocol() || null;
  const cipherObj = socket.getCipher();
  const alpnRaw   = socket.alpnProtocol;

  const cipherOpenssl  = cipherObj?.name || null;
  const cipherStandard = cipherObj?.standardName || null;

  const derived = _deriveCipherFields(protocol, cipherOpenssl);

  // Normalise alpnProtocol: false → null (no ALPN negotiated)
  const alpnProtocol   = (alpnRaw === false || alpnRaw === null || alpnRaw === undefined) ? null : alpnRaw;
  const http2Negotiated = alpnProtocol === null ? null : alpnProtocol === 'h2';

  const peerCert   = socket.getPeerCertificate(true);
  const certEvid   = _extractCertificateEvidence(peerCert, collectedAt);
  const verifState = _deriveVerificationResult(socket);

  return {
    // ── Shared context ────────────────────────────────────────────────────
    endpoint_state:        'RESPONSE_OBSERVED',
    collected_at:          collectedAt,
    collection_hostname:   domain,
    connection_error_code: null,
    connection_error_msg:  null,

    // ── TLS configuration evidence ────────────────────────────────────────
    negotiated_version:    protocol,
    cipher_suite_openssl:  cipherOpenssl,
    cipher_suite_standard: cipherStandard,
    cipher_key_exchange:   derived.cipher_key_exchange,
    cipher_symmetric_alg:  derived.cipher_symmetric_alg,
    cipher_mac_hash:       derived.cipher_mac_hash,
    forward_secrecy:       derived.forward_secrecy,
    alpn_protocol:         alpnProtocol,
    http2_negotiated:      http2Negotiated,

    // ── Certificate evidence ──────────────────────────────────────────────
    certificate_present:          certEvid.certificate_present,
    tls_verification_result:      verifState.tls_verification_result,
    tls_error_code:               verifState.tls_error_code,
    leaf_subject_cn:              certEvid.leaf_subject_cn,
    leaf_subject_o:               certEvid.leaf_subject_o,
    leaf_subject_dn_raw:          certEvid.leaf_subject_dn_raw,
    leaf_issuer_cn:               certEvid.leaf_issuer_cn,
    leaf_issuer_o:                certEvid.leaf_issuer_o,
    leaf_issuer_dn_raw:           certEvid.leaf_issuer_dn_raw,
    leaf_serial_number:           certEvid.leaf_serial_number,
    leaf_fingerprint_sha256:      certEvid.leaf_fingerprint_sha256,
    leaf_signature_algorithm:     certEvid.leaf_signature_algorithm,
    leaf_key_type:                certEvid.leaf_key_type,
    leaf_key_bits:                certEvid.leaf_key_bits,
    leaf_key_curve:               certEvid.leaf_key_curve,
    leaf_not_before:              certEvid.leaf_not_before,
    leaf_not_after:               certEvid.leaf_not_after,
    leaf_days_remaining:          certEvid.leaf_days_remaining,
    leaf_lifetime_days:           certEvid.leaf_lifetime_days,
    leaf_san_entries:             certEvid.leaf_san_entries,
    leaf_san_count:               certEvid.leaf_san_count,
    leaf_is_wildcard:             certEvid.leaf_is_wildcard,
    leaf_is_self_signed:          certEvid.leaf_is_self_signed,
    leaf_aia_ocsp_urls:           certEvid.leaf_aia_ocsp_urls,
    leaf_aia_ca_issuers_urls:     certEvid.leaf_aia_ca_issuers_urls,
    leaf_policy_oids:             certEvid.leaf_policy_oids,
    leaf_basic_constraints_ca:    certEvid.leaf_basic_constraints_ca,
    leaf_basic_constraints_pathlen: certEvid.leaf_basic_constraints_pathlen,
    leaf_extension_parse_errors:  certEvid.leaf_extension_parse_errors,
    chain_intermediates:          certEvid.chain_intermediates,
    cert_chain_depth:             certEvid.cert_chain_depth,
    cert_chain_complete:          certEvid.cert_chain_complete,

    // ── Future consideration fields (always null in v1) ───────────────────
    session_ticket_issued: null,
    ocsp_stapling_present: null,
    key_share_group:       null,
  };
}

// ── Failure evidence (CONNECTION_ERROR / TLS_ERROR paths) ─────────────────────

function _buildFailureEvidence(domain, collectedAt, endpointState, errorCode, errorMsg) {
  return {
    endpoint_state:        endpointState,
    collected_at:          collectedAt,
    collection_hostname:   domain,
    connection_error_code: errorCode,
    connection_error_msg:  errorMsg,

    negotiated_version:    null,
    cipher_suite_openssl:  null,
    cipher_suite_standard: null,
    cipher_key_exchange:   null,
    cipher_symmetric_alg:  null,
    cipher_mac_hash:       null,
    forward_secrecy:       null,
    alpn_protocol:         null,
    http2_negotiated:      null,

    certificate_present:          null,
    tls_verification_result:      null,
    tls_error_code:               null,
    leaf_subject_cn:              null,
    leaf_subject_o:               null,
    leaf_subject_dn_raw:          null,
    leaf_issuer_cn:               null,
    leaf_issuer_o:                null,
    leaf_issuer_dn_raw:           null,
    leaf_serial_number:           null,
    leaf_fingerprint_sha256:      null,
    leaf_signature_algorithm:     null,
    leaf_key_type:                null,
    leaf_key_bits:                null,
    leaf_key_curve:               null,
    leaf_not_before:              null,
    leaf_not_after:               null,
    leaf_days_remaining:          null,
    leaf_lifetime_days:           null,
    leaf_san_entries:             [],
    leaf_san_count:               0,
    leaf_is_wildcard:             null,
    leaf_is_self_signed:          null,
    leaf_aia_ocsp_urls:           [],
    leaf_aia_ca_issuers_urls:     [],
    leaf_policy_oids:             [],
    leaf_basic_constraints_ca:    null,
    leaf_basic_constraints_pathlen: null,
    leaf_extension_parse_errors:  [],
    chain_intermediates:          [],
    cert_chain_depth:             null,
    cert_chain_complete:          null,

    session_ticket_issued: null,
    ocsp_stapling_present: null,
    key_share_group:       null,
  };
}

// ── Cipher derivation (SOT-TLS-001 §7.2) ─────────────────────────────────────

function _deriveCipherFields(negotiatedVersion, cipherOpenssl) {
  if (!cipherOpenssl) {
    return { cipher_key_exchange: null, cipher_symmetric_alg: null, cipher_mac_hash: null, forward_secrecy: null };
  }

  // ── Key exchange mechanism ─────────────────────────────────────────────
  let keyExchange = null;
  if (negotiatedVersion === 'TLSv1.3') {
    keyExchange = 'TLS13';
  } else if (cipherOpenssl.startsWith('ECDHE-')) {
    keyExchange = 'ECDHE';
  } else if (cipherOpenssl.startsWith('DHE-') || cipherOpenssl.startsWith('EDH-')) {
    keyExchange = 'DHE';
  } else if (cipherOpenssl.startsWith('RSA-') || cipherOpenssl.includes('_WITH_')) {
    keyExchange = 'RSA';
  }
  // else null — unable to determine key exchange from cipher name

  // ── Forward secrecy ────────────────────────────────────────────────────
  let forwardSecrecy = null;
  if (negotiatedVersion === 'TLSv1.3') {
    forwardSecrecy = true;
  } else if (keyExchange === 'ECDHE' || keyExchange === 'DHE') {
    forwardSecrecy = true;
  } else if (keyExchange === 'RSA') {
    forwardSecrecy = false;
  }
  // else null — key exchange unknown

  // ── Symmetric algorithm and MAC hash ───────────────────────────────────
  let symmetricAlg = null;
  let macHash = null;

  if (negotiatedVersion === 'TLSv1.3') {
    // Format: TLS_AES_256_GCM_SHA384
    const m = cipherOpenssl.match(/^TLS_(.+)_(SHA\d+)$/);
    if (m) {
      symmetricAlg = m[1]; // e.g., 'AES_256_GCM'
      macHash      = m[2]; // e.g., 'SHA384'
    }
  } else if (keyExchange !== null) {
    // TLS 1.2 OpenSSL format: [KEYEXCH-][AUTH-]SYM-...-HASH
    // Only derive when the cipher structure is identifiable (key exchange known).
    // If key_exchange is null the cipher is unparseable — all derived fields stay null.
    const parts = cipherOpenssl.split('-');
    if (parts.length >= 2) {
      macHash = parts[parts.length - 1]; // Last segment = hash

      // Find the start of the symmetric algorithm segment
      let symStart = 0;
      const first = parts[0].toUpperCase();
      if (first === 'ECDHE' || first === 'DHE' || first === 'EDH' || first === 'RSA') {
        symStart = 1;
        if (parts.length > 2) {
          const second = parts[1].toUpperCase();
          if (second === 'RSA' || second === 'ECDSA' || second === 'DSS' || second === 'PSK' || second === 'ANON') {
            symStart = 2;
          }
        }
      }

      const symParts = parts.slice(symStart, parts.length - 1);
      symmetricAlg = symParts.length > 0 ? symParts.join('-') : null;
    }
  }

  return { cipher_key_exchange: keyExchange, cipher_symmetric_alg: symmetricAlg, cipher_mac_hash: macHash, forward_secrecy: forwardSecrecy };
}

// ── Verification result derivation ────────────────────────────────────────────

function _deriveVerificationResult(socket) {
  if (socket.authorized === true) {
    return { tls_verification_result: 'CHAIN_VERIFIED', tls_error_code: null };
  }

  const errorCode = socket.authorizationError;
  if (!errorCode) {
    return { tls_verification_result: 'UNKNOWN', tls_error_code: null };
  }

  const mapped = VERIFICATION_MAP[errorCode];
  return {
    tls_verification_result: mapped || 'OTHER_TLS_ERROR',
    tls_error_code: errorCode,
  };
}

// ── Certificate evidence extraction ───────────────────────────────────────────

function _extractCertificateEvidence(peerCert, collectedAt) {
  const parseErrors = [];

  // No certificate presented
  if (!peerCert || Object.keys(peerCert).length === 0) {
    return _certAbsenceEvidence('NO_CERTIFICATE');
  }

  // Incomplete handshake — cert object exists but lacks essential fields
  if (!peerCert.fingerprint256 && !peerCert.valid_from) {
    parseErrors.push('incomplete_certificate_data');
    return _certAbsenceEvidence('HANDSHAKE_INCOMPLETE', parseErrors);
  }

  // ── Subject / issuer ──────────────────────────────────────────────────
  const subjectCn     = peerCert.subject?.CN  || null;
  const subjectO      = peerCert.subject?.O   || null;
  const subjectDnRaw  = _reconstructDn(peerCert.subject);
  const issuerCn      = peerCert.issuer?.CN   || null;
  const issuerO       = peerCert.issuer?.O    || null;
  const issuerDnRaw   = _reconstructDn(peerCert.issuer);

  // ── Serial number ─────────────────────────────────────────────────────
  const serialNumber = peerCert.serialNumber ? peerCert.serialNumber.toLowerCase() : null;

  // ── Fingerprint ───────────────────────────────────────────────────────
  const fingerprintSha256 = peerCert.fingerprint256
    ? peerCert.fingerprint256.replace(/:/g, '').toLowerCase()
    : null;

  // ── Signature algorithm ───────────────────────────────────────────────
  const signatureAlgorithm = peerCert.sigalg || null;

  // ── Public key ────────────────────────────────────────────────────────
  let keyType  = null;
  let keyBits  = null;
  let keyCurve = null;

  if (typeof peerCert.bits === 'number') {
    keyType = 'RSA';
    keyBits = peerCert.bits;
  } else if (peerCert.asn1Curve || peerCert.nistCurve) {
    keyType  = 'EC';
    keyCurve = peerCert.asn1Curve || peerCert.nistCurve || null;
  }

  // ── Validity dates ────────────────────────────────────────────────────
  const leafNotBefore = _parseDate(peerCert.valid_from, 'valid_from', parseErrors);
  const leafNotAfter  = _parseDate(peerCert.valid_to,   'valid_to',   parseErrors);

  const daysRemaining = (leafNotAfter && collectedAt)
    ? Math.floor((new Date(leafNotAfter) - new Date(collectedAt)) / 86400000)
    : null;

  const lifetimeDays = (leafNotBefore && leafNotAfter)
    ? Math.floor((new Date(leafNotAfter) - new Date(leafNotBefore)) / 86400000)
    : null;

  // ── SAN entries ───────────────────────────────────────────────────────
  const sanEntries  = _parseSan(peerCert.subjectaltname);
  const isWildcard  = sanEntries.some(s => s.startsWith('*.'));

  // ── Self-signed indicator ─────────────────────────────────────────────
  const isSelfSigned = _detectSelfSigned(peerCert, subjectDnRaw, issuerDnRaw);

  // ── AIA extension ─────────────────────────────────────────────────────
  const aiaOcspUrls      = _normaliseUrls(peerCert.infoAccess?.['OCSP - URI']);
  const aiaCaIssuersUrls = _normaliseUrls(peerCert.infoAccess?.['CA Issuers - URI']);

  // ── Certificate Policies OIDs (v1 limitation — always empty) ─────────
  // Node.js standard API does not expose OIDs from the Certificate Policies extension.
  // Per TLS_LAYER_IMPL_001 §8.4: record parse error so downstream can distinguish
  // "no policy extension" from "OIDs not extractable at collection time" (D-4 fix).
  const policyOids = [];
  parseErrors.push('Certificate Policies');

  // ── Basic constraints ─────────────────────────────────────────────────
  const basicConstraintsCa = typeof peerCert.ca === 'boolean' ? peerCert.ca : null;
  const basicConstraintsPathlen = null; // Not exposed by standard Node.js TLS API

  // ── Certificate chain ─────────────────────────────────────────────────
  const chainResult = _extractChain(peerCert);
  chainResult.parseErrors.forEach(e => parseErrors.push(e));

  return {
    certificate_present:          'CERTIFICATE_PRESENTED',
    leaf_subject_cn:              subjectCn,
    leaf_subject_o:               subjectO,
    leaf_subject_dn_raw:          subjectDnRaw,
    leaf_issuer_cn:               issuerCn,
    leaf_issuer_o:                issuerO,
    leaf_issuer_dn_raw:           issuerDnRaw,
    leaf_serial_number:           serialNumber,
    leaf_fingerprint_sha256:      fingerprintSha256,
    leaf_signature_algorithm:     signatureAlgorithm,
    leaf_key_type:                keyType,
    leaf_key_bits:                keyBits,
    leaf_key_curve:               keyCurve,
    leaf_not_before:              leafNotBefore,
    leaf_not_after:               leafNotAfter,
    leaf_days_remaining:          daysRemaining,
    leaf_lifetime_days:           lifetimeDays,
    leaf_san_entries:             sanEntries,
    leaf_san_count:               sanEntries.length,
    leaf_is_wildcard:             sanEntries.length > 0 ? isWildcard : null,
    leaf_is_self_signed:          isSelfSigned,
    leaf_aia_ocsp_urls:           aiaOcspUrls,
    leaf_aia_ca_issuers_urls:     aiaCaIssuersUrls,
    leaf_policy_oids:             policyOids,
    leaf_basic_constraints_ca:    basicConstraintsCa,
    leaf_basic_constraints_pathlen: basicConstraintsPathlen,
    leaf_extension_parse_errors:  parseErrors,
    chain_intermediates:          chainResult.intermediates,
    cert_chain_depth:             chainResult.chainDepth,
    cert_chain_complete:          chainResult.chainComplete,
  };
}

function _certAbsenceEvidence(presentState, parseErrors = []) {
  return {
    certificate_present:          presentState,
    leaf_subject_cn:              null,
    leaf_subject_o:               null,
    leaf_subject_dn_raw:          null,
    leaf_issuer_cn:               null,
    leaf_issuer_o:                null,
    leaf_issuer_dn_raw:           null,
    leaf_serial_number:           null,
    leaf_fingerprint_sha256:      null,
    leaf_signature_algorithm:     null,
    leaf_key_type:                null,
    leaf_key_bits:                null,
    leaf_key_curve:               null,
    leaf_not_before:              null,
    leaf_not_after:               null,
    leaf_days_remaining:          null,
    leaf_lifetime_days:           null,
    leaf_san_entries:             [],
    leaf_san_count:               0,
    leaf_is_wildcard:             null,
    leaf_is_self_signed:          null,
    leaf_aia_ocsp_urls:           [],
    leaf_aia_ca_issuers_urls:     [],
    leaf_policy_oids:             [],
    leaf_basic_constraints_ca:    null,
    leaf_basic_constraints_pathlen: null,
    leaf_extension_parse_errors:  parseErrors,
    chain_intermediates:          [],
    cert_chain_depth:             null,
    cert_chain_complete:          null,
  };
}

// ── Certificate chain traversal ───────────────────────────────────────────────

function _extractChain(leafCert) {
  const intermediates = [];
  const parseErrors   = [];
  let chainComplete   = false;
  const leafFp256     = leafCert.fingerprint256;

  let current = leafCert.issuerCertificate;

  while (current) {
    // Cycle detection — back to the leaf itself (self-signed leaf)
    if (leafFp256 && current.fingerprint256 === leafFp256) break;

    // Self-signed root detection — cert's issuer is itself
    const nextFp = current.issuerCertificate?.fingerprint256;
    if (nextFp && current.fingerprint256 === nextFp) {
      chainComplete = true;
      break; // Don't add root to intermediates
    }

    // Add genuine intermediate
    intermediates.push(_buildIntermediateEntry(current, intermediates.length + 1));

    // Depth safety limit
    if (intermediates.length >= MAX_CHAIN_DEPTH) {
      parseErrors.push('chain_depth_limit_reached');
      break;
    }

    current = current.issuerCertificate || null;
  }

  return {
    intermediates,
    chainDepth:     1 + intermediates.length,
    chainComplete,
    parseErrors,
  };
}

function _buildIntermediateEntry(cert, position) {
  return {
    position,
    subject_dn_raw:     _reconstructDn(cert.subject),
    subject_cn:         cert.subject?.CN || null,
    issuer_dn_raw:      _reconstructDn(cert.issuer),
    fingerprint_sha256: cert.fingerprint256
      ? cert.fingerprint256.replace(/:/g, '').toLowerCase()
      : null,
    not_before:         _parseDate(cert.valid_from, null, []),
    not_after:          _parseDate(cert.valid_to,   null, []),
    signature_algorithm: cert.sigalg || null,
    is_self_signed:     false,
  };
}

// ── Utility functions ─────────────────────────────────────────────────────────

function _reconstructDn(dnObj) {
  if (!dnObj || typeof dnObj !== 'object') return null;
  const parts = Object.entries(dnObj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return v.map(item => `${k}=${item}`).join(', ');
      return `${k}=${v}`;
    });
  return parts.length > 0 ? parts.join(', ') : null;
}

function _parseDate(raw, fieldName, parseErrors) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
      if (fieldName && parseErrors) parseErrors.push(fieldName);
      return null;
    }
    return d.toISOString();
  } catch (_) {
    if (fieldName && parseErrors) parseErrors.push(fieldName);
    return null;
  }
}

function _parseSan(subjectaltname) {
  if (!subjectaltname || typeof subjectaltname !== 'string') return [];

  return subjectaltname.split(', ')
    .map(entry => {
      if (entry.startsWith('DNS:'))        return entry.slice(4);
      if (entry.startsWith('IP Address:')) return entry.slice(11);
      if (entry.startsWith('IP:'))         return entry.slice(3);
      if (entry.startsWith('email:'))      return entry.slice(6);
      if (entry.startsWith('URI:'))        return entry.slice(4);
      return entry;
    })
    .filter(Boolean);
}

function _normaliseUrls(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return [value];
}

function _detectSelfSigned(peerCert, subjectDnRaw, issuerDnRaw) {
  // Primary: fingerprint comparison (safer; avoids DN string comparison ambiguity)
  if (peerCert.issuerCertificate && peerCert.fingerprint256) {
    const issuerFp = peerCert.issuerCertificate.fingerprint256;
    if (issuerFp) return peerCert.fingerprint256 === issuerFp;
  }
  // Fallback: DN string equality
  if (subjectDnRaw && issuerDnRaw) return subjectDnRaw === issuerDnRaw;
  return null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { createRunContext, collectTLSSession };
