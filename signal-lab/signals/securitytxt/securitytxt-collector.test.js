'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectSecurityTxt,
  parseContent,
  detectPgp,
  extractSignedBody,
  determineFileState,
} = require('./securitytxt-collector');

const COLLECTOR_VERSION = '0.0.0-test';

// ── Mock fetch helper ─────────────────────────────────────────────────────────
//
// Creates a fetch implementation that routes requests by exact URL.
// Each route descriptor maps to a synthetic Response.
//
// Route fields:
//   status  {number}  — HTTP status code (default 200)
//   headers {Object}  — response headers
//   body    {string}  — response body (omit or undefined for empty body)
//   error   'abort'|'network' — throw AbortError or TypeError instead of returning
//
// URLs not present in routes return 404 with no body.

/**
 * @param {Record<string, { status?: number, headers?: Record<string,string>, body?: string, error?: 'abort'|'network' }>} routes
 * @returns {typeof globalThis.fetch}
 */
function mockFetch(routes) {
  return async (input, _init) => {
    const url   = typeof input === 'string' ? input : input.toString();
    const route = routes[url];

    if (!route) {
      return new Response(null, { status: 404 });
    }

    if (route.error === 'abort') {
      const err = new Error('The operation was aborted');
      err.name  = 'AbortError';
      throw err;
    }

    if (route.error === 'network') {
      throw new TypeError('fetch failed');
    }

    const headers  = new Headers(route.headers ?? {});
    const bodyInit = route.body !== undefined ? route.body : null;

    return new Response(bodyInit, { status: route.status ?? 200, headers });
  };
}

// ── T01 — Canonical present; legacy absent ────────────────────────────────────

describe('T01 — canonical only', () => {
  test('file_state is PRESENT_CANONICAL', async () => {
    const fetch = mockFetch({
      'https://t01.example.com/.well-known/security.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'Contact: security@t01.example.com\nExpires: 2027-01-01T00:00:00z\n',
      },
      'https://t01.example.com/security.txt': { status: 404 },
    });

    const record = await collectSecurityTxt('t01.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'PRESENT_CANONICAL');
    assert.equal(record.canonical_fetch.fetch_state, 'FOUND');
    assert.equal(record.legacy_fetch.fetch_state, 'NOT_FOUND');
    assert.notEqual(record.canonical_parse, null);
    assert.equal(record.legacy_parse, null);
    assert.equal(record.canonical_parse.contact.length, 1);
    assert.equal(record.canonical_parse.expires.length, 1);
  });
});

// ── T02 — Legacy present; canonical absent ────────────────────────────────────

describe('T02 — legacy only', () => {
  test('file_state is PRESENT_LEGACY_ONLY', async () => {
    const fetch = mockFetch({
      'https://t02.example.com/.well-known/security.txt': { status: 404 },
      'https://t02.example.com/security.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'Contact: security@t02.example.com\n',
      },
    });

    const record = await collectSecurityTxt('t02.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'PRESENT_LEGACY_ONLY');
    assert.equal(record.canonical_fetch.fetch_state, 'NOT_FOUND');
    assert.equal(record.legacy_fetch.fetch_state, 'FOUND');
    assert.equal(record.canonical_parse, null);
    assert.notEqual(record.legacy_parse, null);
    assert.equal(record.legacy_parse.contact[0], ' security@t02.example.com');
  });
});

// ── T03 — Both present; identical content ─────────────────────────────────────

describe('T03 — both present, identical content', () => {
  const BODY = 'Contact: security@t03.example.com\nExpires: 2027-01-01T00:00:00z\n';

  test('file_state is PRESENT_BOTH; both parsers produce equivalent contact and expires', async () => {
    const fetch = mockFetch({
      'https://t03.example.com/.well-known/security.txt': {
        status: 200, headers: { 'content-type': 'text/plain' }, body: BODY,
      },
      'https://t03.example.com/security.txt': {
        status: 200, headers: { 'content-type': 'text/plain' }, body: BODY,
      },
    });

    const record = await collectSecurityTxt('t03.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'PRESENT_BOTH');
    assert.notEqual(record.canonical_parse, null);
    assert.notEqual(record.legacy_parse, null);
    assert.deepEqual(record.canonical_parse.contact, record.legacy_parse.contact);
    assert.deepEqual(record.canonical_parse.expires, record.legacy_parse.expires);
    // Independent objects — not the same reference
    assert.notEqual(record.canonical_parse, record.legacy_parse);
  });
});

// ── T04 — Both present; different content ─────────────────────────────────────

describe('T04 — both present, different content', () => {
  test('both are parsed independently; each reflects its own body', async () => {
    const fetch = mockFetch({
      'https://t04.example.com/.well-known/security.txt': {
        status: 200, headers: { 'content-type': 'text/plain' },
        body: 'Contact: a@t04.example.com\nExpires: 2027-01-01T00:00:00z\n',
      },
      'https://t04.example.com/security.txt': {
        status: 200, headers: { 'content-type': 'text/plain' },
        body: 'Contact: b@t04.example.com\n',
      },
    });

    const record = await collectSecurityTxt('t04.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'PRESENT_BOTH');
    assert.equal(record.canonical_parse.contact[0], ' a@t04.example.com');
    assert.equal(record.canonical_parse.expires.length, 1);
    assert.equal(record.legacy_parse.contact[0], ' b@t04.example.com');
    assert.equal(record.legacy_parse.expires.length, 0);
  });
});

// ── T05 — Both absent ─────────────────────────────────────────────────────────

describe('T05 — both absent', () => {
  test('file_state is ABSENT; both parsers are null', async () => {
    const fetch = mockFetch({
      'https://t05.example.com/.well-known/security.txt': { status: 404 },
      'https://t05.example.com/security.txt':             { status: 404 },
    });

    const record = await collectSecurityTxt('t05.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'ABSENT');
    assert.equal(record.canonical_fetch.fetch_state, 'NOT_FOUND');
    assert.equal(record.legacy_fetch.fetch_state, 'NOT_FOUND');
    assert.equal(record.canonical_parse, null);
    assert.equal(record.legacy_parse, null);
  });
});

// ── T06 — Redirect followed to 200 ───────────────────────────────────────────

describe('T06 — redirect followed to 200', () => {
  test('redirect_chain records hop; terminal fetch_state is FOUND; url is initial URL', async () => {
    const INITIAL = 'https://t06.example.com/.well-known/security.txt';
    const TARGET  = 'https://t06.example.com/security-disclosure.txt';

    const fetch = mockFetch({
      [INITIAL]: {
        status: 301,
        headers: { location: TARGET },
      },
      [TARGET]: {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'Contact: security@t06.example.com\n',
      },
      'https://t06.example.com/security.txt': { status: 404 },
    });

    const record = await collectSecurityTxt('t06.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.file_state, 'PRESENT_CANONICAL');
    assert.equal(record.canonical_fetch.fetch_state, 'FOUND');
    assert.equal(record.canonical_fetch.http_status, 200);
    assert.equal(record.canonical_fetch.url, INITIAL);                             // initial URL, not TARGET
    assert.equal(record.canonical_fetch.redirect_chain.length, 1);
    assert.equal(record.canonical_fetch.redirect_chain[0].url, INITIAL);
    assert.equal(record.canonical_fetch.redirect_chain[0].status, 301);
    assert.notEqual(record.canonical_parse, null);
    assert.equal(record.canonical_parse.contact[0], ' security@t06.example.com');
  });
});

// ── T07 — Redirect depth exhausted ───────────────────────────────────────────

describe('T07 — redirect depth exhausted', () => {
  test('fetch_state is REDIRECT_NO_CONTENT; redirect_chain has 10 entries', async () => {
    const BASE = 'https://t07.example.com';
    const INITIAL = `${BASE}/.well-known/security.txt`;

    // Build 10 redirect hops: initial → r/1 → r/2 → ... → r/9 → r/10
    // The loop runs 10 times (attempts 0-9); r/10 is never fetched
    const routes = {
      [INITIAL]: { status: 301, headers: { location: `${BASE}/r/1` } },
    };
    for (let i = 1; i <= 9; i++) {
      routes[`${BASE}/r/${i}`] = { status: 301, headers: { location: `${BASE}/r/${i + 1}` } };
    }
    routes[`${BASE}/security.txt`] = { status: 404 };

    const fetch = mockFetch(routes);
    const record = await collectSecurityTxt('t07.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state, 'REDIRECT_NO_CONTENT');
    assert.equal(record.canonical_fetch.http_status, null);
    assert.equal(record.canonical_fetch.redirect_chain.length, 10);
    assert.equal(record.canonical_fetch.redirect_chain[0].url, INITIAL);
    assert.equal(record.canonical_fetch.redirect_chain[0].status, 301);
    assert.equal(record.canonical_fetch.redirect_chain[9].url, `${BASE}/r/9`);
    assert.equal(record.canonical_parse, null);
  });
});

// ── T08 — Redirect with no Location header ────────────────────────────────────

describe('T08 — redirect with no Location header', () => {
  test('fetch_state is REDIRECT_NO_CONTENT; redirect_chain is empty; http_status is null', async () => {
    const fetch = mockFetch({
      'https://t08.example.com/.well-known/security.txt': {
        status: 302,
        // no Location header
      },
      'https://t08.example.com/security.txt': { status: 404 },
    });

    const record = await collectSecurityTxt('t08.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state, 'REDIRECT_NO_CONTENT');
    assert.equal(record.canonical_fetch.redirect_chain.length, 0);
    assert.equal(record.canonical_fetch.http_status, null);
    assert.equal(record.canonical_parse, null);
  });
});

// ── T09 — Timeout ─────────────────────────────────────────────────────────────

describe('T09 — timeout', () => {
  test('fetch_state is TIMEOUT; http_status is null', async () => {
    const fetch = mockFetch({
      'https://t09.example.com/.well-known/security.txt': { error: 'abort' },
      'https://t09.example.com/security.txt':             { error: 'abort' },
    });

    const record = await collectSecurityTxt('t09.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state, 'TIMEOUT');
    assert.equal(record.canonical_fetch.http_status, null);
    assert.equal(record.legacy_fetch.fetch_state, 'TIMEOUT');
    assert.equal(record.file_state, 'INDETERMINATE');
    assert.equal(record.canonical_parse, null);
  });
});

// ── T10 — Connection error ────────────────────────────────────────────────────

describe('T10 — connection error', () => {
  test('fetch_state is CONNECTION_ERROR; http_status is null', async () => {
    const fetch = mockFetch({
      'https://t10.example.com/.well-known/security.txt': { error: 'network' },
      'https://t10.example.com/security.txt':             { error: 'network' },
    });

    const record = await collectSecurityTxt('t10.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state, 'CONNECTION_ERROR');
    assert.equal(record.canonical_fetch.http_status, null);
    assert.equal(record.file_state, 'INDETERMINATE');
  });
});

// ── T11 — Server error ────────────────────────────────────────────────────────

describe('T11 — server error', () => {
  test('fetch_state is SERVER_ERROR with the received status code', async () => {
    const fetch = mockFetch({
      'https://t11.example.com/.well-known/security.txt': { status: 500 },
      'https://t11.example.com/security.txt':             { status: 404 },
    });

    const record = await collectSecurityTxt('t11.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state, 'SERVER_ERROR');
    assert.equal(record.canonical_fetch.http_status, 500);
    assert.equal(record.file_state, 'INDETERMINATE');
    assert.equal(record.canonical_parse, null);
  });
});

// ── T12 — All RFC 9116 fields present ────────────────────────────────────────

describe('T12 — all RFC 9116 named fields', () => {
  const BODY = [
    'Contact: https://t12.example.com/report',
    'Expires: 2027-01-01T00:00:00z',
    'Encryption: https://t12.example.com/pgp-key.txt',
    'Acknowledgments: https://t12.example.com/thanks',
    'Policy: https://t12.example.com/security-policy',
    'Preferred-Languages: en, fr',
    'Hiring: https://t12.example.com/jobs',
    'Canonical: https://t12.example.com/.well-known/security.txt',
  ].join('\n') + '\n';

  test('all eight known fields extracted; no unknown fields; directive_count = 8', () => {
    const p = parseContent(BODY);

    assert.equal(p.contact[0],             ' https://t12.example.com/report');
    assert.equal(p.expires[0],             ' 2027-01-01T00:00:00z');
    assert.equal(p.encryption[0],          ' https://t12.example.com/pgp-key.txt');
    assert.equal(p.acknowledgments[0],     ' https://t12.example.com/thanks');
    assert.equal(p.policy[0],              ' https://t12.example.com/security-policy');
    assert.equal(p.preferred_languages[0], ' en, fr');
    assert.equal(p.hiring[0],              ' https://t12.example.com/jobs');
    assert.equal(p.canonical[0],           ' https://t12.example.com/.well-known/security.txt');

    assert.equal(p.directive_count,      8);
    assert.equal(p.known_field_count,    8);
    assert.equal(p.unknown_field_count,  0);
    assert.equal(p.unknown_fields.length, 0);

    // total_lines invariant
    assert.equal(
      p.total_lines,
      p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
    );
  });
});

// ── T13 — Duplicate Contact fields preserved ──────────────────────────────────

describe('T13 — duplicate Contact fields', () => {
  test('both Contact values in file order; directive_count = 2', () => {
    const p = parseContent(
      'Contact: mailto:security@t13.example.com\nContact: https://t13.example.com/report\n',
    );

    assert.equal(p.contact.length, 2);
    assert.equal(p.contact[0], ' mailto:security@t13.example.com');
    assert.equal(p.contact[1], ' https://t13.example.com/report');
    assert.equal(p.directive_count, 2);
    assert.equal(p.known_field_count, 2);
  });
});

// ── T14 — Unknown field preserved ────────────────────────────────────────────

describe('T14 — unknown field', () => {
  test('unknown field in unknown_fields; not in any named array; is_known_field is false', () => {
    const p = parseContent(
      'Contact: security@t14.example.com\nLanguage: en\n',
    );

    assert.equal(p.contact.length, 1);
    assert.equal(p.unknown_fields.length, 1);
    assert.equal(p.unknown_fields[0].field_name_raw, 'Language');
    assert.equal(p.unknown_fields[0].field_value_raw, ' en');
    assert.equal(p.unknown_fields[0].line_number, 2);
    assert.equal(p.directive_count, 2);
    assert.equal(p.known_field_count, 1);
    assert.equal(p.unknown_field_count, 1);

    // Verify the directive_lines entry for the unknown field
    const unkDl = p.directive_lines.find(d => d.field_name_raw === 'Language');
    assert.ok(unkDl);
    assert.equal(unkDl.is_known_field, false);
  });
});

// ── T15 — Malformed lines preserved ──────────────────────────────────────────

describe('T15 — malformed lines', () => {
  test('line with no colon → malformed; line with colon at index 0 → malformed', () => {
    const p = parseContent(
      'Contact: security@t15.example.com\nthis line has no colon\n:value-no-field-name\n',
    );

    assert.equal(p.directive_count,      1);
    assert.equal(p.malformed_line_count, 2);
    assert.equal(p.malformed_lines[0].line_number, 2);
    assert.equal(p.malformed_lines[0].raw_line,    'this line has no colon');
    assert.equal(p.malformed_lines[1].line_number, 3);
    assert.equal(p.malformed_lines[1].raw_line,    ':value-no-field-name');

    assert.equal(
      p.total_lines,
      p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
    );
  });
});

// ── T16 — Comment lines preserved ────────────────────────────────────────────

describe('T16 — comment lines', () => {
  test('comment lines captured; not in directive_lines', () => {
    const p = parseContent(
      '# This is a comment\nContact: security@t16.example.com\n',
    );

    assert.equal(p.comment_line_count,  1);
    assert.equal(p.directive_count,     1);
    assert.equal(p.comment_lines[0].line_number, 1);
    assert.equal(p.comment_lines[0].raw_line,    '# This is a comment');
  });
});

// ── T17 — Blank lines counted and positioned ─────────────────────────────────

describe('T17 — blank lines', () => {
  test('blank line counted; position recorded; total_lines invariant holds', () => {
    const p = parseContent(
      'Contact: security@t17.example.com\n\nExpires: 2027-01-01T00:00:00z\n',
    );

    // Lines: [contact, blank, expires, trailing-blank]
    assert.equal(p.blank_line_count,          2);
    assert.ok(p.blank_line_positions.includes(2));
    assert.ok(p.blank_line_positions.includes(4));
    assert.equal(p.directive_count,           2);

    assert.equal(
      p.total_lines,
      p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
    );
  });
});

// ── T18 — Field name case preserved; is_known_field case-insensitive ─────────

describe('T18 — field name case preserved', () => {
  test('field_name_raw retains original casing; is_known_field is true regardless of case', () => {
    const p = parseContent('CONTACT: security@t18.example.com\n');

    assert.equal(p.directive_lines[0].field_name_raw,  'CONTACT');
    assert.equal(p.directive_lines[0].is_known_field,  true);
    assert.equal(p.contact[0],                         ' security@t18.example.com');
    assert.equal(p.directive_count,                    1);
    assert.equal(p.known_field_count,                  1);
  });
});

// ── T19 — Field value leading space preserved ─────────────────────────────────

describe('T19 — field value leading space preserved', () => {
  test('field_value_raw includes the space after the colon; not trimmed', () => {
    const p = parseContent('Contact: security@t19.example.com\n');

    assert.equal(p.directive_lines[0].field_value_raw, ' security@t19.example.com');
    assert.equal(p.contact[0],                         ' security@t19.example.com');
  });
});

// ── T20 — Colon in field value: only first colon is separator ────────────────

describe('T20 — colon in field value', () => {
  test('field_value_raw contains all content after the first colon including any subsequent colons', () => {
    const p = parseContent('Contact: https://t20.example.com/security:8443\n');

    assert.equal(p.directive_lines[0].field_name_raw,  'Contact');
    assert.equal(p.directive_lines[0].field_value_raw, ' https://t20.example.com/security:8443');
    assert.equal(p.contact[0],                         ' https://t20.example.com/security:8443');
  });
});

// ── T21 — PGP signed file ────────────────────────────────────────────────────

describe('T21 — PGP signed file', () => {
  const SIGNED_BODY = [
    '-----BEGIN PGP SIGNED MESSAGE-----',
    'Hash: SHA256',
    '',
    'Contact: security@t21.example.com',
    'Expires: 2027-01-01T00:00:00z',
    '',
    '-----BEGIN PGP SIGNATURE-----',
    'iQEzBAABCAAdFiEEabc123...',
    '-----END PGP SIGNATURE-----',
  ].join('\n');

  test('content_state is SIGNED; directives parsed from signed body only; total_lines is parse body count', () => {
    const p = parseContent(SIGNED_BODY);

    assert.equal(p.content_state, 'SIGNED');
    assert.ok(p.pgp_signed_body_raw !== null);
    assert.ok(p.pgp_signature_raw !== null);

    // pgp_signed_body_raw contains only the directive content, not PGP wrapper
    assert.ok(!p.pgp_signed_body_raw.includes('BEGIN PGP'));
    assert.ok(!p.pgp_signed_body_raw.includes('Hash:'));
    assert.equal(p.contact[0], ' security@t21.example.com');
    assert.equal(p.expires[0], ' 2027-01-01T00:00:00z');

    // pgp_signature_raw spans from BEGIN to END delimiter
    assert.ok(p.pgp_signature_raw.startsWith('-----BEGIN PGP SIGNATURE-----'));
    assert.ok(p.pgp_signature_raw.endsWith('-----END PGP SIGNATURE-----'));

    // total_lines is the parse body line count, not the full file line count
    assert.equal(p.directive_count,   2);
    assert.equal(p.total_lines,       2); // 'Contact:...' and 'Expires:...' — trailing blank trimmed by extractSignedBody
    assert.equal(
      p.total_lines,
      p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
    );
  });

  test('pgp_signature_raw contains full signature block verbatim', () => {
    const p = parseContent(SIGNED_BODY);

    assert.ok(p.pgp_signature_raw.includes('iQEzBAABCAAdFiEEabc123...'));
  });
});

// ── T22 — MALFORMED_PGP ───────────────────────────────────────────────────────

describe('T22 — MALFORMED_PGP', () => {
  const MALFORMED = [
    '-----BEGIN PGP SIGNED MESSAGE-----',
    'Hash: SHA256',
    '',
    'Contact: security@t22.example.com',
    // no signature block
  ].join('\n');

  test('content_state is MALFORMED_PGP; signed body extracted; signature null; directive parsed', () => {
    const p = parseContent(MALFORMED);

    assert.equal(p.content_state, 'MALFORMED_PGP');
    assert.notEqual(p.pgp_signed_body_raw, null);
    assert.equal(p.pgp_signature_raw, null);
    assert.equal(p.contact[0], ' security@t22.example.com');
    assert.equal(p.directive_count, 1);
  });
});

// ── T23 — UTF-8 BOM ───────────────────────────────────────────────────────────

describe('T23 — UTF-8 BOM', () => {
  test('BOM stripped for parsing; field_name_raw does not carry BOM; is_known_field true', async () => {
    const BOM  = '﻿';
    const BODY = `${BOM}Contact: security@t23.example.com\n`;

    const fetch = mockFetch({
      'https://t23.example.com/.well-known/security.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: BODY,
      },
      'https://t23.example.com/security.txt': { status: 404 },
    });

    const record = await collectSecurityTxt('t23.example.com', COLLECTOR_VERSION, { fetch });

    // raw_content in FetchResult retains the BOM
    assert.ok(record.canonical_fetch.raw_content.startsWith('﻿'));

    // BOM stripped for parsing: field_name_raw has no BOM prefix
    const p = record.canonical_parse;
    assert.equal(p.directive_lines[0].field_name_raw,  'Contact');
    assert.equal(p.directive_lines[0].is_known_field,  true);
    assert.equal(p.contact[0],                         ' security@t23.example.com');
  });
});

// ── T24 — CRLF line endings ───────────────────────────────────────────────────

describe('T24 — CRLF line endings', () => {
  test('lines split correctly; raw_line has no \\r; total_lines includes trailing blank; blank_line_positions correct', () => {
    const BODY = 'Contact: security@t24.example.com\r\nExpires: 2027-01-01T00:00:00z\r\n';
    const p    = parseContent(BODY);

    // raw_line values must not contain \r
    assert.equal(p.directive_lines[0].raw_line, 'Contact: security@t24.example.com');
    assert.equal(p.directive_lines[1].raw_line, 'Expires: 2027-01-01T00:00:00z');

    assert.equal(p.directive_count,      2);
    assert.equal(p.blank_line_count,     1);   // trailing \r\n produces a trailing empty element
    assert.deepEqual(p.blank_line_positions, [3]);
    assert.equal(p.total_lines,          3);   // 2 directive lines + 1 trailing blank

    // total_lines invariant: 2 + 0 + 0 + 1 = 3
    assert.equal(
      p.total_lines,
      p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
    );
  });
});

// ── T25 — FOUND_EMPTY (200 with empty body) ───────────────────────────────────

describe('T25 — FOUND_EMPTY', () => {
  test('fetch_state FOUND_EMPTY; raw_content null; raw_content_bytes 0; canonical_parse null', async () => {
    const fetch = mockFetch({
      'https://t25.example.com/.well-known/security.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        // body omitted → empty
      },
      'https://t25.example.com/security.txt': { status: 404 },
    });

    const record = await collectSecurityTxt('t25.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.fetch_state,      'FOUND_EMPTY');
    assert.equal(record.canonical_fetch.http_status,      200);
    assert.equal(record.canonical_fetch.raw_content,      null);
    assert.equal(record.canonical_fetch.raw_content_bytes, 0);
    assert.equal(record.canonical_parse,                  null);
    assert.equal(record.file_state,                       'ABSENT');
  });
});

// ── Top-level record fields ───────────────────────────────────────────────────

describe('record metadata', () => {
  test('signal_id, signal_version, collector_version, domain, collected_at populated correctly', async () => {
    const fetch = mockFetch({
      'https://meta.example.com/.well-known/security.txt': { status: 404 },
      'https://meta.example.com/security.txt':             { status: 404 },
    });

    const record = await collectSecurityTxt('meta.example.com', '1.2.3', { fetch });

    assert.equal(record.signal_id,         'SOT-SECURITYTXT-001');
    assert.equal(record.signal_version,    '1');
    assert.equal(record.collector_version, '1.2.3');
    assert.equal(record.domain,            'meta.example.com');
    assert.ok(record.collected_at.match(/^\d{4}-\d{2}-\d{2}T/));
  });

  test('canonical_fetch.url and legacy_fetch.url are the initial URLs', async () => {
    const fetch = mockFetch({
      'https://url.example.com/.well-known/security.txt': { status: 404 },
      'https://url.example.com/security.txt':             { status: 404 },
    });

    const record = await collectSecurityTxt('url.example.com', COLLECTOR_VERSION, { fetch });

    assert.equal(record.canonical_fetch.url, 'https://url.example.com/.well-known/security.txt');
    assert.equal(record.legacy_fetch.url,    'https://url.example.com/security.txt');
  });
});

// ── determineFileState unit tests ─────────────────────────────────────────────

describe('determineFileState', () => {
  test('FOUND + FOUND → PRESENT_BOTH',              () => assert.equal(determineFileState('FOUND', 'FOUND'),              'PRESENT_BOTH'));
  test('FOUND + NOT_FOUND → PRESENT_CANONICAL',     () => assert.equal(determineFileState('FOUND', 'NOT_FOUND'),          'PRESENT_CANONICAL'));
  test('NOT_FOUND + FOUND → PRESENT_LEGACY_ONLY',   () => assert.equal(determineFileState('NOT_FOUND', 'FOUND'),          'PRESENT_LEGACY_ONLY'));
  test('NOT_FOUND + NOT_FOUND → ABSENT',             () => assert.equal(determineFileState('NOT_FOUND', 'NOT_FOUND'),      'ABSENT'));
  test('FOUND_EMPTY + NOT_FOUND → ABSENT',           () => assert.equal(determineFileState('FOUND_EMPTY', 'NOT_FOUND'),    'ABSENT'));
  test('NOT_FOUND + TIMEOUT → INDETERMINATE',        () => assert.equal(determineFileState('NOT_FOUND', 'TIMEOUT'),        'INDETERMINATE'));
  test('CONNECTION_ERROR + NOT_FOUND → INDETERMINATE',() => assert.equal(determineFileState('CONNECTION_ERROR', 'NOT_FOUND'), 'INDETERMINATE'));
  test('SERVER_ERROR + FOUND_EMPTY → INDETERMINATE', () => assert.equal(determineFileState('SERVER_ERROR', 'FOUND_EMPTY'), 'INDETERMINATE'));
  test('REDIRECT_NO_CONTENT + NOT_FOUND → ABSENT',   () => assert.equal(determineFileState('REDIRECT_NO_CONTENT', 'NOT_FOUND'), 'ABSENT'));
  test('OTHER_HTTP + OTHER_HTTP → ABSENT',            () => assert.equal(determineFileState('OTHER_HTTP', 'OTHER_HTTP'),   'ABSENT'));
});

// ── extractSignedBody unit tests ──────────────────────────────────────────────

describe('extractSignedBody', () => {
  test('extracts body between armor headers and signature block', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'Contact: security@example.com',
      '',
      '-----BEGIN PGP SIGNATURE-----',
      'abc123',
      '-----END PGP SIGNATURE-----',
    ].join('\n');

    const body = extractSignedBody(content);
    assert.equal(body, 'Contact: security@example.com');
  });

  test('returns null when no blank separator after armor headers', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      // no blank line — immediately exhausts lines
    ].join('\n');

    assert.equal(extractSignedBody(content), null);
  });

  test('trims trailing whitespace from extracted body', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'Contact: security@example.com',
      '',           // blank line before signature — should be trimmed
      '-----BEGIN PGP SIGNATURE-----',
      'abc123',
      '-----END PGP SIGNATURE-----',
    ].join('\n');

    const body = extractSignedBody(content);
    assert.ok(!body.endsWith('\n'));
    assert.ok(!body.endsWith(' '));
  });

  test('returns null when signed body is empty after trimming', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      '',           // blank body
      '-----BEGIN PGP SIGNATURE-----',
      'abc123',
      '-----END PGP SIGNATURE-----',
    ].join('\n');

    assert.equal(extractSignedBody(content), null);
  });
});

// ── detectPgp unit tests ──────────────────────────────────────────────────────

describe('detectPgp', () => {
  test('UNSIGNED — no PGP header', () => {
    const { content_state, pgp_signed_body_raw, pgp_signature_raw } =
      detectPgp('Contact: security@example.com\n');

    assert.equal(content_state,       'UNSIGNED');
    assert.equal(pgp_signed_body_raw, null);
    assert.equal(pgp_signature_raw,   null);
  });

  test('SIGNED — complete structure', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'Contact: security@example.com',
      '-----BEGIN PGP SIGNATURE-----',
      'abc123',
      '-----END PGP SIGNATURE-----',
    ].join('\n');

    const { content_state, pgp_signed_body_raw, pgp_signature_raw } = detectPgp(content);

    assert.equal(content_state, 'SIGNED');
    assert.ok(pgp_signed_body_raw.includes('Contact:'));
    assert.ok(pgp_signature_raw.startsWith('-----BEGIN PGP SIGNATURE-----'));
    assert.ok(pgp_signature_raw.endsWith('-----END PGP SIGNATURE-----'));
  });

  test('MALFORMED_PGP — opening marker present; no signature block', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'Contact: security@example.com',
    ].join('\n');

    const { content_state, pgp_signed_body_raw, pgp_signature_raw } = detectPgp(content);

    assert.equal(content_state,     'MALFORMED_PGP');
    assert.notEqual(pgp_signed_body_raw, null);
    assert.equal(pgp_signature_raw, null);
  });

  test('MALFORMED_PGP — END marker appears before START marker', () => {
    const content = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'Contact: security@example.com',
      '-----END PGP SIGNATURE-----',     // END without preceding START
    ].join('\n');

    const { content_state } = detectPgp(content);
    assert.equal(content_state, 'MALFORMED_PGP');
  });
});

// ── total_lines invariant across varied inputs ────────────────────────────────

describe('total_lines invariant', () => {
  const cases = [
    {
      label:    'all line types mixed',
      body:     '# comment\nContact: a@example.com\nbad line\n\n',
    },
    {
      label:    'empty file (zero bytes would be FOUND_EMPTY, but test empty string edge)',
      body:     '',
    },
    {
      label:    'only blank lines',
      body:     '\n\n\n',
    },
    {
      label:    'only comments',
      body:     '# a\n# b\n',
    },
    {
      label:    'only unknown fields',
      body:     'X-Custom: value\n',
    },
  ];

  for (const { label, body } of cases) {
    test(label, () => {
      const p = parseContent(body);
      assert.equal(
        p.total_lines,
        p.directive_count + p.comment_line_count + p.malformed_line_count + p.blank_line_count,
        `invariant failed for: ${label}`,
      );
    });
  }
});
