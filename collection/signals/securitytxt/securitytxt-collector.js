'use strict';

// SOT-SECURITYTXT-001 — Security.txt Collector v1
//
// Signal Lab principles applied:
//   - Two independent HTTPS fetches: /.well-known/security.txt and /security.txt
//   - Observable facts only; no interpretation, validation, scoring, or compliance checking
//   - PGP structure detected by content markers only; no cryptographic verification
//   - Both canonical and legacy bodies parsed independently when PRESENT_BOTH
//   - All evidence preserved verbatim; no field trimming or normalisation
//   - BOM stripped for parsing only; raw_content in FetchResult retains the BOM
//
// Schema: SOT-SECURITYTXT-001 v1 (frozen)
// Requires: Node.js >=18 (native fetch, AbortSignal.timeout, ReadableStream)

const SIGNAL_ID      = 'SOT-SECURITYTXT-001';
const SIGNAL_VERSION = '1';

// ── Type definitions ──────────────────────────────────────────────────────────
//
// These are JSDoc-only; they carry no runtime cost.

/**
 * @typedef {'FOUND'|'FOUND_EMPTY'|'NOT_FOUND'|'SERVER_ERROR'|'OTHER_HTTP'|'REDIRECT_NO_CONTENT'|'TIMEOUT'|'CONNECTION_ERROR'} FetchState
 */

/**
 * @typedef {'PRESENT_CANONICAL'|'PRESENT_LEGACY_ONLY'|'PRESENT_BOTH'|'ABSENT'|'INDETERMINATE'} FileState
 */

/**
 * @typedef {'SIGNED'|'UNSIGNED'|'MALFORMED_PGP'} ContentState
 */

/**
 * @typedef {Object} RedirectHop
 * @property {string} url    — URL at which the 3xx response was received
 * @property {number} status — HTTP status code of the 3xx response
 */

/**
 * @typedef {Object} DirectiveLine
 * @property {number}  line_number     — 1-indexed within the parse body
 * @property {string}  field_name_raw  — characters before the first colon; case-preserved; not trimmed
 * @property {string}  field_value_raw — characters after the first colon; leading space preserved; not trimmed
 * @property {boolean} is_known_field  — true if field_name_raw (case-insensitive) is an RFC 9116 field name
 * @property {string}  raw_line        — verbatim line content; no line terminator
 */

/**
 * @typedef {Object} CommentLine
 * @property {number} line_number
 * @property {string} raw_line     — verbatim; includes the leading '#'
 */

/**
 * @typedef {Object} MalformedLine
 * @property {number} line_number
 * @property {string} raw_line     — verbatim; not a directive, comment, or blank line
 */

/**
 * @typedef {Object} UnknownField
 * @property {string} field_name_raw
 * @property {string} field_value_raw
 * @property {number} line_number
 * @property {string} raw_line
 */

/**
 * @typedef {Object} FetchResult
 * @property {string}         url               — initial URL; never the post-redirect URL
 * @property {FetchState}     fetch_state
 * @property {number|null}    http_status        — null if no response received
 * @property {string|null}    content_type       — Content-Type header of terminal response; null if absent
 * @property {RedirectHop[]}  redirect_chain     — empty array if no redirect followed
 * @property {string|null}    raw_content        — decoded body; null unless fetch_state === 'FOUND'
 * @property {number|null}    raw_content_bytes  — byteLength for FOUND; 0 for FOUND_EMPTY; null for all other states
 */

/**
 * @typedef {Object} ParsedContent
 * @property {ContentState}   content_state
 * @property {string|null}    pgp_signed_body_raw  — signed body extracted from PGP wrapper; null if UNSIGNED
 * @property {string|null}    pgp_signature_raw    — PGP signature block verbatim incl. delimiters; null unless SIGNED
 * @property {number}         total_lines          — line count of the parse body
 * @property {number}         total_bytes          — UTF-8 byte count of the parse body
 * @property {DirectiveLine[]} directive_lines
 * @property {CommentLine[]}  comment_lines
 * @property {MalformedLine[]} malformed_lines
 * @property {number}         blank_line_count
 * @property {number[]}       blank_line_positions  — 1-indexed
 * @property {string[]}       contact
 * @property {string[]}       expires
 * @property {string[]}       encryption
 * @property {string[]}       acknowledgments
 * @property {string[]}       policy
 * @property {string[]}       preferred_languages
 * @property {string[]}       hiring
 * @property {string[]}       canonical
 * @property {UnknownField[]} unknown_fields
 * @property {number}         directive_count
 * @property {number}         known_field_count
 * @property {number}         unknown_field_count
 * @property {number}         comment_line_count
 * @property {number}         malformed_line_count
 */

/**
 * @typedef {Object} SecurityTxtRecord
 * @property {'SOT-SECURITYTXT-001'} signal_id
 * @property {'1'}                   signal_version
 * @property {string}                collector_version
 * @property {string}                domain
 * @property {string}                collected_at     — ISO 8601 UTC
 * @property {FileState}             file_state
 * @property {FetchResult}           canonical_fetch
 * @property {FetchResult}           legacy_fetch
 * @property {ParsedContent|null}    canonical_parse
 * @property {ParsedContent|null}    legacy_parse
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const KNOWN_FIELDS = new Set([
  'contact',
  'expires',
  'encryption',
  'acknowledgments',
  'policy',
  'preferred-languages',
  'hiring',
  'canonical',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** @type {Set<FetchState>} */
const BLOCKING_STATES = new Set(['CONNECTION_ERROR', 'TIMEOUT', 'SERVER_ERROR']);

const MAX_BODY_BYTES   = 1_048_576; // 1 MB cap — truncation is logged externally; not flagged in schema
const MAX_REDIRECTS    = 10;        // inclusive; depth exceeded → REDIRECT_NO_CONTENT
const FETCH_TIMEOUT_MS = 10_000;    // per individual hop

const PGP_HEADER    = '-----BEGIN PGP SIGNED MESSAGE-----';
const PGP_SIG_START = '-----BEGIN PGP SIGNATURE-----';
const PGP_SIG_END   = '-----END PGP SIGNATURE-----';

const REQUEST_HEADERS = {
  'User-Agent': 'Soterius-SignalLab/1 SOT-SECURITYTXT-001/1',
  'Accept':     'text/plain, */*',
};

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Strips a UTF-8 BOM (U+FEFF) from the start of a string.
 * raw_content in FetchResult retains the BOM; this is applied only to the working copy.
 *
 * @param {string} s
 * @returns {string}
 */
function stripBom(s) {
  return s.startsWith('﻿') ? s.slice(1) : s;
}

/**
 * Decodes a buffer to a string. Attempts UTF-8 with fatal mode first;
 * falls back to Latin-1 if UTF-8 decoding fails.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeBody(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return new TextDecoder('latin1', { ignoreBOM: true }).decode(buffer);
  }
}

/**
 * Reads a response body up to MAX_BODY_BYTES using streaming.
 * If the body exceeds the cap, reading stops and the stream is cancelled.
 * Truncation is not flagged in the schema; callers should log it externally.
 *
 * @param {Response} response
 * @returns {Promise<Buffer>}
 */
async function readBodyCapped(response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_BODY_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
  } catch (err) {
    await reader.cancel();
    throw err;
  }

  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

/**
 * @param {string}        url
 * @param {FetchState}    fetch_state
 * @param {number|null}   http_status
 * @param {string|null}   content_type
 * @param {RedirectHop[]} redirect_chain
 * @param {string|null}   raw_content
 * @param {number|null}   raw_content_bytes
 * @returns {FetchResult}
 */
function makeFetchResult(url, fetch_state, http_status, content_type, redirect_chain, raw_content, raw_content_bytes) {
  return { url, fetch_state, http_status, content_type, redirect_chain, raw_content, raw_content_bytes };
}

/**
 * Returns a zero-evidence ParsedContent for use when parsing fails unexpectedly.
 *
 * @returns {ParsedContent}
 */
function emptyParsedContent() {
  return {
    content_state:        'UNSIGNED',
    pgp_signed_body_raw:  null,
    pgp_signature_raw:    null,
    total_lines:          0,
    total_bytes:          0,
    directive_lines:      [],
    comment_lines:        [],
    malformed_lines:      [],
    blank_line_count:     0,
    blank_line_positions: [],
    contact:              [],
    expires:              [],
    encryption:           [],
    acknowledgments:      [],
    policy:               [],
    preferred_languages:  [],
    hiring:               [],
    canonical:            [],
    unknown_fields:       [],
    directive_count:      0,
    known_field_count:    0,
    unknown_field_count:  0,
    comment_line_count:   0,
    malformed_line_count: 0,
  };
}

// ── PGP Structure Detection ───────────────────────────────────────────────────

/**
 * Extracts the signed body from a PGP clearsign document.
 *
 * Solely responsible for:
 *   - Locating signed content (after armor headers and blank separator)
 *   - Removing the signature block and everything following it
 *   - Trimming trailing whitespace from the extracted body
 *
 * detectPgp performs no post-processing of the value returned by this function.
 *
 * Line endings in the returned body are LF only (the split+join normalises CRLF).
 * For signed CRLF files this means pgp_signed_body_raw.length < raw_content.length
 * by one byte per signed line. This also affects total_bytes in ParsedContent.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractSignedBody(content) {
  const lines = content.split(/\r?\n/);

  // Skip line 0: '-----BEGIN PGP SIGNED MESSAGE-----'
  // Skip armor header lines (non-empty; e.g. 'Hash: SHA256')
  // Stop at first blank line — the mandatory separator between armor headers and body
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '') {
    i++;
  }

  i++; // skip the blank separator line itself

  if (i >= lines.length) {
    return null; // no signed body found (malformed structure)
  }

  // Join remaining lines with LF (normalises CRLF to LF)
  let body = lines.slice(i).join('\n');

  // Remove the signature block and any content following it
  const sigPos = body.indexOf(PGP_SIG_START);
  if (sigPos !== -1) {
    body = body.slice(0, sigPos);
  }

  // Trim trailing whitespace — blank lines between content and signature block are not part of the body
  body = body.trimEnd();

  return body.length > 0 ? body : null;
}

/**
 * Detects PGP clearsign structure in file content.
 * Performs no cryptographic operation and no signature verification.
 * Performs no post-processing of extractSignedBody's return value.
 *
 * content_state values:
 *   SIGNED       — '-----BEGIN PGP SIGNED MESSAGE-----' present with complete signature block
 *   UNSIGNED     — no PGP opening marker detected
 *   MALFORMED_PGP — PGP opening marker present; signature block absent or structurally incomplete
 *
 * @param {string} content
 * @returns {{ content_state: ContentState, pgp_signed_body_raw: string|null, pgp_signature_raw: string|null }}
 */
function detectPgp(content) {
  if (!content.startsWith(PGP_HEADER)) {
    return { content_state: 'UNSIGNED', pgp_signed_body_raw: null, pgp_signature_raw: null };
  }

  const sigStartIdx = content.indexOf(PGP_SIG_START);
  const sigEndIdx   = content.indexOf(PGP_SIG_END);

  // Opening marker present; signature block absent or structurally incomplete
  if (sigStartIdx === -1 || sigEndIdx === -1 || sigEndIdx <= sigStartIdx) {
    return {
      content_state:       'MALFORMED_PGP',
      pgp_signed_body_raw: extractSignedBody(content),
      pgp_signature_raw:   null,
    };
  }

  // Complete PGP structure.
  // extractSignedBody handles all trimming; no post-processing is applied here.
  return {
    content_state:       'SIGNED',
    pgp_signed_body_raw: extractSignedBody(content),
    pgp_signature_raw:   content.slice(sigStartIdx, sigEndIdx + PGP_SIG_END.length),
  };
}

// ── Content Parsing ───────────────────────────────────────────────────────────

/**
 * Parses the raw content of a security.txt response into structured evidence.
 * Called independently for canonical and legacy bodies.
 *
 * Line classification priority:
 *   1. Blank     — line.trim() === ''
 *   2. Comment   — line.startsWith('#')
 *   3. Directive — line.indexOf(':') > 0   (colon at index > 0 required)
 *   4. Malformed — everything else
 *
 * total_lines invariant:
 *   total_lines === directive_count + comment_line_count + malformed_line_count + blank_line_count
 *   Every line belongs to exactly one classification category.
 *
 * For SIGNED and MALFORMED_PGP files where pgp_signed_body_raw is non-null:
 *   total_lines and total_bytes describe the parse body (signed content), not the full file.
 *   Full file byte count is available in FetchResult.raw_content_bytes.
 *
 * Must not throw — any unexpected error returns emptyParsedContent().
 *
 * @param {string} rawContent
 * @returns {ParsedContent}
 */
function parseContent(rawContent) {
  try {
    const working = stripBom(rawContent);
    const pgp     = detectPgp(working);

    // Select parse body: signed body for PGP files (when extractable), else full content
    const parseBody = pgp.pgp_signed_body_raw !== null ? pgp.pgp_signed_body_raw : working;

    const totalBytes = Buffer.byteLength(parseBody, 'utf-8');
    const lines      = parseBody.split(/\r?\n/);
    const totalLines = lines.length;

    /** @type {DirectiveLine[]} */  const directiveLines   = [];
    /** @type {CommentLine[]} */    const commentLines     = [];
    /** @type {MalformedLine[]} */  const malformedLines   = [];
    /** @type {number[]} */         const blankPositions   = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1; // 1-indexed
      const line       = lines[i];

      // Priority 1: Blank
      if (line.trim() === '') {
        blankPositions.push(lineNumber);
        continue;
      }

      // Priority 2: Comment
      if (line.startsWith('#')) {
        commentLines.push({ line_number: lineNumber, raw_line: line });
        continue;
      }

      // Priority 3: Directive — colon must appear at index > 0 (non-empty field name)
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const fieldNameRaw  = line.slice(0, colonIdx);
        const fieldValueRaw = line.slice(colonIdx + 1); // leading space preserved; not trimmed
        const isKnownField  = KNOWN_FIELDS.has(fieldNameRaw.toLowerCase());
        directiveLines.push({
          line_number:     lineNumber,
          field_name_raw:  fieldNameRaw,
          field_value_raw: fieldValueRaw,
          is_known_field:  isKnownField,
          raw_line:        line,
        });
        continue;
      }

      // Priority 4: Malformed
      malformedLines.push({ line_number: lineNumber, raw_line: line });
    }

    // Named field extraction — in file order; field_value_raw unmodified
    const contact             = [];
    const expires             = [];
    const encryption          = [];
    const acknowledgments     = [];
    const policy              = [];
    const preferred_languages = [];
    const hiring              = [];
    const canonical           = [];
    /** @type {UnknownField[]} */
    const unknownFields       = [];

    for (const dl of directiveLines) {
      switch (dl.field_name_raw.toLowerCase()) {
        case 'contact':              contact.push(dl.field_value_raw);              break;
        case 'expires':              expires.push(dl.field_value_raw);              break;
        case 'encryption':           encryption.push(dl.field_value_raw);           break;
        case 'acknowledgments':      acknowledgments.push(dl.field_value_raw);      break;
        case 'policy':               policy.push(dl.field_value_raw);               break;
        case 'preferred-languages':  preferred_languages.push(dl.field_value_raw);  break;
        case 'hiring':               hiring.push(dl.field_value_raw);               break;
        case 'canonical':            canonical.push(dl.field_value_raw);            break;
        default:
          unknownFields.push({
            field_name_raw:  dl.field_name_raw,
            field_value_raw: dl.field_value_raw,
            line_number:     dl.line_number,
            raw_line:        dl.raw_line,
          });
      }
    }

    const knownFieldCount   = directiveLines.filter(d => d.is_known_field).length;
    const unknownFieldCount = directiveLines.length - knownFieldCount;

    return {
      content_state:        pgp.content_state,
      pgp_signed_body_raw:  pgp.pgp_signed_body_raw,
      pgp_signature_raw:    pgp.pgp_signature_raw,
      total_lines:          totalLines,
      total_bytes:          totalBytes,
      directive_lines:      directiveLines,
      comment_lines:        commentLines,
      malformed_lines:      malformedLines,
      blank_line_count:     blankPositions.length,
      blank_line_positions: blankPositions,
      contact,
      expires,
      encryption,
      acknowledgments,
      policy,
      preferred_languages,
      hiring,
      canonical,
      unknown_fields:       unknownFields,
      directive_count:      directiveLines.length,
      known_field_count:    knownFieldCount,
      unknown_field_count:  unknownFieldCount,
      comment_line_count:   commentLines.length,
      malformed_line_count: malformedLines.length,
    };
  } catch {
    return emptyParsedContent();
  }
}

// ── State Determination ───────────────────────────────────────────────────────

/**
 * Derives file_state from the two fetch_state values.
 *
 * PRESENT_BOTH      — both FOUND
 * PRESENT_CANONICAL — only canonical FOUND
 * PRESENT_LEGACY_ONLY — only legacy FOUND
 * INDETERMINATE     — neither FOUND; at least one blocking state (CONNECTION_ERROR, TIMEOUT, SERVER_ERROR)
 * ABSENT            — neither FOUND; no blocking states (definitive negative result)
 *
 * @param {FetchState} canonicalState
 * @param {FetchState} legacyState
 * @returns {FileState}
 */
function determineFileState(canonicalState, legacyState) {
  if (canonicalState === 'FOUND' && legacyState === 'FOUND') return 'PRESENT_BOTH';
  if (canonicalState === 'FOUND')                            return 'PRESENT_CANONICAL';
  if (legacyState    === 'FOUND')                            return 'PRESENT_LEGACY_ONLY';
  if (BLOCKING_STATES.has(canonicalState) || BLOCKING_STATES.has(legacyState)) return 'INDETERMINATE';
  return 'ABSENT';
}

// ── HTTP Fetch ────────────────────────────────────────────────────────────────

/**
 * Fetches a single security.txt location, following redirects manually.
 *
 * FetchResult.url is always the initial URL, never the post-redirect URL.
 * The full redirect chain is recorded in FetchResult.redirect_chain.
 *
 * raw_content_bytes:
 *   FOUND       → buffer.byteLength (actual bytes read; may be less than total file size if capped at 1 MB)
 *   FOUND_EMPTY → 0
 *   all others  → null
 *
 * raw_content:
 *   FOUND       → decoded body string
 *   all others  → null
 *
 * @param {string} initialUrl
 * @param {typeof globalThis.fetch} fetchFn
 * @returns {Promise<FetchResult>}
 */
async function fetchLocation(initialUrl, fetchFn) {
  /** @type {RedirectHop[]} */
  const redirectChain = [];
  let currentUrl = initialUrl;

  for (let attempt = 0; attempt < MAX_REDIRECTS; attempt++) {
    /** @type {Response} */
    let response;

    try {
      response = await fetchFn(currentUrl, {
        method:   'GET',
        headers:  REQUEST_HEADERS,
        redirect: 'manual',
        signal:   AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const error = /** @type {Error} */ (err);
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return makeFetchResult(initialUrl, 'TIMEOUT', null, null, redirectChain, null, null);
      }
      return makeFetchResult(initialUrl, 'CONNECTION_ERROR', null, null, redirectChain, null, null);
    }

    const status      = response.status;
    const contentType = response.headers.get('content-type');

    // 3xx — record hop and follow
    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers.get('location');
      if (!location || !location.trim()) {
        // 3xx with no usable Location header — cannot continue
        return makeFetchResult(initialUrl, 'REDIRECT_NO_CONTENT', null, null, redirectChain, null, null);
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        // Unresolvable Location header value
        return makeFetchResult(initialUrl, 'REDIRECT_NO_CONTENT', null, null, redirectChain, null, null);
      }
      redirectChain.push({ url: currentUrl, status });
      currentUrl = nextUrl;
      continue;
    }

    // Terminal: 200
    if (status === 200) {
      let buffer;
      try {
        buffer = await readBodyCapped(response);
      } catch {
        return makeFetchResult(initialUrl, 'CONNECTION_ERROR', null, null, redirectChain, null, null);
      }

      if (buffer.byteLength === 0) {
        return makeFetchResult(initialUrl, 'FOUND_EMPTY', 200, contentType, redirectChain, null, 0);
      }

      const rawContent = decodeBody(buffer);
      return makeFetchResult(initialUrl, 'FOUND', 200, contentType, redirectChain, rawContent, buffer.byteLength);
    }

    // Terminal: 404
    if (status === 404) {
      return makeFetchResult(initialUrl, 'NOT_FOUND', 404, contentType, redirectChain, null, null);
    }

    // Terminal: 5xx
    if (status >= 500 && status <= 599) {
      return makeFetchResult(initialUrl, 'SERVER_ERROR', status, contentType, redirectChain, null, null);
    }

    // Terminal: any other HTTP status (e.g. 403, 429)
    return makeFetchResult(initialUrl, 'OTHER_HTTP', status, contentType, redirectChain, null, null);
  }

  // MAX_REDIRECTS hops exhausted without reaching a non-3xx response
  return makeFetchResult(initialUrl, 'REDIRECT_NO_CONTENT', null, null, redirectChain, null, null);
}

// ── Main Collector ────────────────────────────────────────────────────────────

/**
 * Collects security.txt evidence for a domain.
 *
 * Both canonical (/.well-known/security.txt) and legacy (/security.txt) locations
 * are fetched in parallel. When both return FOUND, both are parsed independently.
 * No source is preferred; no bodies are merged or compared.
 *
 * @param {string} domain           — bare domain, e.g. 'example.com'
 * @param {string} collectorVersion — read from package.json at the call site
 * @param {{ fetch?: typeof globalThis.fetch }} [options]
 * @returns {Promise<SecurityTxtRecord>}
 */
async function collectSecurityTxt(domain, collectorVersion, options = {}) {
  const collectedAt = new Date().toISOString();
  const fetchFn     = options.fetch ?? globalThis.fetch;

  if (!fetchFn) {
    throw new Error(
      'native fetch is not available; Node.js 18 or higher is required',
    );
  }

  const canonicalUrl = `https://${domain}/.well-known/security.txt`;
  const legacyUrl    = `https://${domain}/security.txt`;

  const [canonicalFetch, legacyFetch] = await Promise.all([
    fetchLocation(canonicalUrl, fetchFn),
    fetchLocation(legacyUrl, fetchFn),
  ]);

  const canonicalParse = canonicalFetch.fetch_state === 'FOUND'
    ? parseContent(/** @type {string} */ (canonicalFetch.raw_content))
    : null;

  const legacyParse = legacyFetch.fetch_state === 'FOUND'
    ? parseContent(/** @type {string} */ (legacyFetch.raw_content))
    : null;

  return {
    signal_id:         SIGNAL_ID,
    signal_version:    SIGNAL_VERSION,
    collector_version: collectorVersion,
    domain,
    collected_at:      collectedAt,
    file_state:        determineFileState(canonicalFetch.fetch_state, legacyFetch.fetch_state),
    canonical_fetch:   canonicalFetch,
    legacy_fetch:      legacyFetch,
    canonical_parse:   canonicalParse,
    legacy_parse:      legacyParse,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  collectSecurityTxt,
  fetchLocation,
  parseContent,
  detectPgp,
  extractSignedBody,
  determineFileState,
};
