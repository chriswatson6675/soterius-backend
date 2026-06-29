'use strict';

// SOT-DKIM-001 — DKIM Signal Collector
//
// Stores observable facts only. No scores, ratings, or assessments.
//
// Signal Lab principles applied:
//   - Three states: present (true) / not confirmed (null)
//   - dkim_present = false is never stored — selector namespace is not
//     enumerable, so absence cannot be confirmed from probe results
//   - dkim_collection_status = 'NOT_DETECTED' records a complete probe
//     with no key found; it does not assert DKIM is absent
//   - raw_record is preserved for every discovered key

const crypto = require('node:crypto');
const dns    = require('node:dns').promises;

const SIGNAL_ID       = 'dkim';
const SIGNAL_VERSION  = 1;
const PROBE_SET_VERSION = 1;

// Probe set v1 — common selectors across major email providers.
// Ordered roughly by prevalence in UK Higher Education.
const PROBE_SELECTORS = [
  'selector1',   // Microsoft 365 (primary)
  'selector2',   // Microsoft 365 (rotation)
  'google',      // Google Workspace
  'default',     // Generic / self-hosted
  'dkim',        // Generic
  'mail',        // Generic
  'email',       // Generic
  'k1',          // Mailchimp / Intuit
  'k2',          // Mailchimp
  's1',          // SendGrid
  's2',          // SendGrid
  'sm',          // SendGrid
  'amazonses',   // Amazon SES
  'proofpoint',  // Proofpoint
  'mimecast',    // Mimecast
  'mandrill',    // Mailchimp transactional
  'litmus',      // Litmus
  'pm',          // Postmark
  'pm2',         // Postmark
  'sig1',        // Generic / Yahoo
];

// ── DNS error classification ───────────────────────────────────────────────────

const DEFINITIVE_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

// DNS_FAILURE takes priority over DNS_SERVFAIL, which takes priority over DNS_TIMEOUT.
// When multiple probes fail with different errors, the highest priority is reported.
const DNS_ERROR_PRIORITY = { DNS_FAILURE: 3, DNS_SERVFAIL: 2, DNS_TIMEOUT: 1 };

function classifyDnsError(err) {
  const code = err.code ?? '';
  if (DEFINITIVE_ABSENT_CODES.has(code)) return 'ABSENT';
  if (code === 'ETIMEDOUT') return 'DNS_TIMEOUT';
  if (code === 'ESERVFAIL') return 'DNS_SERVFAIL';
  return 'DNS_FAILURE';
}

// ── DKIM record parser ─────────────────────────────────────────────────────────
//
// Accepts a raw DKIM TXT record string and returns observable structural facts.
// Makes no DNS calls. Pure function.
//
// RFC 6376 §3.6.1 tag definitions:
//   v= version (DKIM1 if present; not required)
//   k= key type (rsa default, ed25519)
//   p= public key base64 (required; empty = revoked)
//   h= acceptable hash algorithms (colon-separated)
//   s= service type (colon-separated; default *)
//   t= flags (colon-separated; y=testing, s=no subdomain signing)
//   n= notes (informational; not parsed)

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function parseDkimRecord(rawRecord) {
  if (!rawRecord || rawRecord.trim() === '') {
    return {
      parse_success:      false,
      version:            null,
      key_type:           null,
      key_bits:           null,
      public_key_present: null,
      hash_algorithms:    null,
      service_type:       null,
      flags:              null,
      syntax_errors:      [{ code: 'EMPTY_RECORD', message: 'DKIM record is empty' }],
    };
  }

  const errors = [];
  const tags   = {};

  for (const part of rawRecord.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue; // stray content — skip
    const name  = trimmed.slice(0, eqIdx).trim().toLowerCase();
    const value = trimmed.slice(eqIdx + 1).trim();
    tags[name]  = value;
  }

  // v= tag
  const version = tags['v'] ?? null;
  if (version !== null && version !== 'DKIM1') {
    errors.push({ code: 'INVALID_VERSION', message: `Expected v=DKIM1, got v=${version}` });
  }

  // k= tag — default is rsa per RFC 6376
  const rawKeyType = (tags['k'] ?? 'rsa').toLowerCase();
  const keyType    = rawKeyType;
  if (rawKeyType !== 'rsa' && rawKeyType !== 'ed25519') {
    errors.push({ code: 'UNKNOWN_KEY_TYPE', message: `Unrecognised key type: ${rawKeyType}` });
  }

  // p= tag
  let publicKeyPresent = false;
  let keyBits          = null;
  const pTag           = tags['p'];

  if (pTag === undefined) {
    errors.push({ code: 'MISSING_P_TAG', message: 'p= tag is absent from DKIM record' });
  } else {
    const pValue = pTag.replace(/\s+/g, '');  // strip whitespace (chunked keys may include spaces)

    if (pValue === '') {
      publicKeyPresent = false; // key revoked per RFC 6376 §3.6.1
    } else {
      publicKeyPresent = true;

      if (!BASE64_RE.test(pValue)) {
        errors.push({ code: 'INVALID_BASE64', message: 'p= value contains non-base64 characters' });
      } else if (rawKeyType === 'rsa') {
        try {
          const der    = Buffer.from(pValue, 'base64');
          const keyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
          keyBits      = keyObj.asymmetricKeyDetails?.modulusLength ?? null;
        } catch (e) {
          errors.push({ code: 'KEY_PARSE_ERROR', message: `Could not parse RSA public key: ${e.message}` });
        }
      }
      // Ed25519: key_bits = null — bit length is fixed by the algorithm, not a per-key measurement
    }
  }

  // h= tag — colon-separated hash algorithms
  const hashAlgorithms = tags['h']
    ? tags['h'].split(':').map(h => h.trim().toLowerCase()).filter(h => h)
    : null;

  // s= tag — colon-separated service types
  const serviceType = tags['s']
    ? tags['s'].split(':').map(s => s.trim().toLowerCase()).filter(s => s)
    : null;

  // t= tag — colon-separated flags
  const flags = tags['t']
    ? tags['t'].split(':').map(f => f.trim().toLowerCase()).filter(f => f)
    : null;

  return {
    parse_success:      errors.length === 0,
    version,
    key_type:           keyType,
    key_bits:           keyBits,
    public_key_present: publicKeyPresent,
    hash_algorithms:    hashAlgorithms,
    service_type:       serviceType,
    flags,
    syntax_errors:      errors,
  };
}

// ── DKIM collector ─────────────────────────────────────────────────────────────
//
// Probes PROBE_SELECTORS against <selector>._domainkey.<domain> and returns
// observable facts for each discovered key.
//
// dkim_present states:
//   true  — at least one DKIM key was found among the probed selectors
//   null  — no key found; reason recorded in dkim_collection_status
//
// dkim_collection_status (when dkim_present = null):
//   'NOT_DETECTED' — all probes completed; no key found (DKIM may still be deployed)
//   'DNS_TIMEOUT'  — at least one probe timed out
//   'DNS_SERVFAIL' — at least one probe returned SERVFAIL
//   'DNS_FAILURE'  — at least one probe returned another DNS error

async function collectDkim(domain, { dnsResolver = dns } = {}) {
  const apex      = domain.replace(/^www\./i, '').toLowerCase().trim();
  const foundKeys = [];
  let   worstErrorStatus = null;

  for (const selector of PROBE_SELECTORS) {
    const qname = `${selector}._domainkey.${apex}`;

    try {
      const txtRecords = await dnsResolver.resolveTxt(qname);
      if (txtRecords.length > 0) {
        const rawRecord = txtRecords[0].join(''); // join chunked TXT strings
        const parsed    = parseDkimRecord(rawRecord);
        foundKeys.push({ selector, raw_record: rawRecord, ...parsed });
      }
    } catch (err) {
      const classification = classifyDnsError(err);
      if (classification !== 'ABSENT') {
        const priority      = DNS_ERROR_PRIORITY[classification] ?? 0;
        const worstPriority = DNS_ERROR_PRIORITY[worstErrorStatus] ?? 0;
        if (worstErrorStatus === null || priority > worstPriority) {
          worstErrorStatus = classification;
        }
      }
      // ABSENT (ENODATA / ENOTFOUND) = no DKIM at this selector; continue
    }
  }

  const selectorsFound = foundKeys.map(k => k.selector);

  if (foundKeys.length > 0) {
    return {
      dkim_present:          true,
      dkim_collection_status: null,
      dkim_record_count:     foundKeys.length,
      dkim_selectors_probed: [...PROBE_SELECTORS],
      dkim_selectors_found:  selectorsFound,
      dkim_probe_set_version: PROBE_SET_VERSION,
      dkim_keys:             foundKeys,
    };
  }

  const status      = worstErrorStatus ?? 'NOT_DETECTED';
  const recordCount = status === 'NOT_DETECTED' ? 0 : null;

  return {
    dkim_present:          null,
    dkim_collection_status: status,
    dkim_record_count:     recordCount,
    dkim_selectors_probed: [...PROBE_SELECTORS],
    dkim_selectors_found:  [],
    dkim_probe_set_version: PROBE_SET_VERSION,
    dkim_keys:             [],
  };
}

module.exports = {
  collectDkim,
  parseDkimRecord,
  SIGNAL_ID,
  SIGNAL_VERSION,
  PROBE_SET_VERSION,
  PROBE_SELECTORS,
};
