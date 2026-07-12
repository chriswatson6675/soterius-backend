'use strict';

// SOT-SECURITYHEADERS-001 — Test Suite
// Groups A–H (facts-only evidence model) + I (SLG-136 source-authentication
// harmonisation, COLLECT-PHILOSOPHY-v1.0 §7 R-1 / C-4/C-5/C-7).

const { describe, test } = require('node:test');
const assert             = require('node:assert/strict');

const {
  collectSecurityHeaders,
  fetchEndpoint,
  fetchProbe,
  buildHeaderPairs,
  extractSecurityHeaders,
  classifyError,
  deriveTlsVerdict,
  SECURITY_HEADER_MAP,
  TLS_ERROR_CODES,
  VERIFICATION_MAP,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  MAX_REDIRECTS,
  TIMEOUT_MS,
} = require('./securityheaders-collector');

// ── Test helper ───────────────────────────────────────────────────────────────

function mockRequest(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) return { statusCode: 404, rawHeaders: [], resume() {} };

    if (route.error === 'timeout') {
      const e = new Error('Timeout');
      e.name  = 'TimeoutError';
      throw e;
    }
    if (route.error === 'network') {
      const e = new TypeError('ECONNREFUSED');
      e.code  = 'ECONNREFUSED';
      throw e;
    }
    if (route.error === 'tls') {
      const e = new TypeError('TLS failure');
      e.code  = 'DEPTH_ZERO_SELF_SIGNED_CERT';
      throw e;
    }
    if (route.error === 'tls_ssl') {
      const e = new TypeError('SSL error');
      e.code  = 'ERR_SSL_WRONG_VERSION_NUMBER';
      throw e;
    }
    if (route.error === 'tls_prefix') {
      const e = new TypeError('TLS prefix error');
      e.code  = 'ERR_TLS_CERT_ALTNAME_INVALID';
      throw e;
    }
    if (route.error === 'abort') {
      const e = new Error('Aborted');
      e.name  = 'AbortError';
      throw e;
    }
    if (route.error === 'etimedout') {
      const e = new Error('ETIMEDOUT');
      e.code  = 'ETIMEDOUT';
      throw e;
    }

    const rawHeaders = [];
    for (const [name, val] of Object.entries(route.headers ?? {})) {
      const values = Array.isArray(val) ? val : [val];
      for (const v of values) {
        rawHeaders.push(name, v);
      }
    }

    // location shorthand for redirect routes
    if (route.location) {
      rawHeaders.push('location', route.location);
    }

    return {
      statusCode: route.status ?? 200,
      rawHeaders,
      // SLG-136: the injectable requestFn seam carries the source-authentication
      // verdict verbatim (the default requestFn derives it from the socket).
      tls_verification_result: route.tls_verification_result ?? null,
      tls_error_code:          route.tls_error_code ?? null,
      resume() {},
    };
  };
}

// ── A. Constants ──────────────────────────────────────────────────────────────

describe('A. Constants', () => {
  test('A01 — SIGNAL_VERSION has expected format', () => {
    assert.equal(SIGNAL_VERSION, 'SOT-SECURITYHEADERS-001-v2');
  });

  test('A02 — COLLECTOR_VERSION is non-empty string', () => {
    assert.ok(typeof COLLECTOR_VERSION === 'string' && COLLECTOR_VERSION.length > 0);
  });

  test('A03 — MAX_REDIRECTS is 10', () => {
    assert.equal(MAX_REDIRECTS, 10);
  });

  test('A04 — TIMEOUT_MS is 10000', () => {
    assert.equal(TIMEOUT_MS, 10_000);
  });

  test('A05 — SECURITY_HEADER_MAP has exactly 25 entries', () => {
    assert.equal(SECURITY_HEADER_MAP.size, 25);
  });

  test('A06 — SECURITY_HEADER_MAP contains strict-transport-security', () => {
    assert.equal(SECURITY_HEADER_MAP.get('strict_transport_security'), 'strict-transport-security');
  });

  test('A07 — SECURITY_HEADER_MAP contains x-aspnetmvc-version', () => {
    assert.equal(SECURITY_HEADER_MAP.get('x_aspnetmvc_version'), 'x-aspnetmvc-version');
  });

  test('A08 — TLS_ERROR_CODES contains DEPTH_ZERO_SELF_SIGNED_CERT', () => {
    assert.ok(TLS_ERROR_CODES.has('DEPTH_ZERO_SELF_SIGNED_CERT'));
  });

  test('A09 — TLS_ERROR_CODES contains CERT_HAS_EXPIRED', () => {
    assert.ok(TLS_ERROR_CODES.has('CERT_HAS_EXPIRED'));
  });
});

// ── B. classifyError ──────────────────────────────────────────────────────────

describe('B. classifyError', () => {
  test('B01 — TimeoutError name → TIMEOUT', () => {
    const e = new Error(); e.name = 'TimeoutError';
    assert.equal(classifyError(e), 'TIMEOUT');
  });

  test('B02 — AbortError name → TIMEOUT', () => {
    const e = new Error(); e.name = 'AbortError';
    assert.equal(classifyError(e), 'TIMEOUT');
  });

  test('B03 — ETIMEDOUT code → TIMEOUT', () => {
    const e = new Error(); e.code = 'ETIMEDOUT';
    assert.equal(classifyError(e), 'TIMEOUT');
  });

  test('B04 — DEPTH_ZERO_SELF_SIGNED_CERT → TLS_ERROR', () => {
    const e = new Error(); e.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
    assert.equal(classifyError(e), 'TLS_ERROR');
  });

  test('B05 — CERT_HAS_EXPIRED → TLS_ERROR', () => {
    const e = new Error(); e.code = 'CERT_HAS_EXPIRED';
    assert.equal(classifyError(e), 'TLS_ERROR');
  });

  test('B06 — ERR_SSL_ prefix → TLS_ERROR', () => {
    const e = new Error(); e.code = 'ERR_SSL_WRONG_VERSION_NUMBER';
    assert.equal(classifyError(e), 'TLS_ERROR');
  });

  test('B07 — ERR_TLS_ prefix → TLS_ERROR', () => {
    const e = new Error(); e.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
    assert.equal(classifyError(e), 'TLS_ERROR');
  });

  test('B08 — ECONNREFUSED → CONNECTION_ERROR', () => {
    const e = new Error(); e.code = 'ECONNREFUSED';
    assert.equal(classifyError(e), 'CONNECTION_ERROR');
  });

  test('B09 — ENOTFOUND → CONNECTION_ERROR', () => {
    const e = new Error(); e.code = 'ENOTFOUND';
    assert.equal(classifyError(e), 'CONNECTION_ERROR');
  });

  test('B10 — unknown error → CONNECTION_ERROR', () => {
    const e = new Error('unknown');
    assert.equal(classifyError(e), 'CONNECTION_ERROR');
  });
});

// ── C. buildHeaderPairs ───────────────────────────────────────────────────────

describe('C. buildHeaderPairs', () => {
  test('C01 — empty rawHeaders → empty array', () => {
    assert.deepEqual(buildHeaderPairs([]), []);
  });

  test('C02 — single header → position 1', () => {
    const pairs = buildHeaderPairs(['Content-Type', 'text/html']);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].name_raw, 'Content-Type');
    assert.equal(pairs[0].value_raw, 'text/html');
    assert.equal(pairs[0].position, 1);
  });

  test('C03 — two headers → positions 1 and 2', () => {
    const pairs = buildHeaderPairs(['X-A', 'v1', 'X-B', 'v2']);
    assert.equal(pairs[0].position, 1);
    assert.equal(pairs[1].position, 2);
  });

  test('C04 — preserves original casing of header name', () => {
    const pairs = buildHeaderPairs(['Strict-Transport-Security', 'max-age=31536000']);
    assert.equal(pairs[0].name_raw, 'Strict-Transport-Security');
  });

  test('C05 — preserves original casing of header value', () => {
    const pairs = buildHeaderPairs(['Server', 'Apache/2.4.51 (Ubuntu)']);
    assert.equal(pairs[0].value_raw, 'Apache/2.4.51 (Ubuntu)');
  });

  test('C06 — duplicate header names get distinct positions', () => {
    const pairs = buildHeaderPairs(['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']);
    assert.equal(pairs[0].position, 1);
    assert.equal(pairs[1].position, 2);
    assert.equal(pairs[0].value_raw, 'a=1');
    assert.equal(pairs[1].value_raw, 'b=2');
  });

  test('C07 — wire order is preserved (first appearance is position 1)', () => {
    const raw   = ['X-Frame-Options', 'DENY', 'Content-Type', 'text/html', 'X-Frame-Options', 'SAMEORIGIN'];
    const pairs = buildHeaderPairs(raw);
    assert.equal(pairs[0].name_raw, 'X-Frame-Options');
    assert.equal(pairs[1].name_raw, 'Content-Type');
    assert.equal(pairs[2].name_raw, 'X-Frame-Options');
    assert.equal(pairs[2].position, 3);
  });
});

// ── D. extractSecurityHeaders ─────────────────────────────────────────────────

describe('D. extractSecurityHeaders', () => {
  test('D01 — absent header → present:false, count:0, values:[], first_position:null', () => {
    const inv = extractSecurityHeaders([]);
    assert.deepEqual(inv.strict_transport_security, {
      present: false, count: 0, values: [], first_position: null,
    });
  });

  test('D02 — all 25 fields present in output even when no headers sent', () => {
    const inv = extractSecurityHeaders([]);
    assert.equal(Object.keys(inv).length, 25);
  });

  test('D03 — present header → present:true, count:1', () => {
    const pairs = buildHeaderPairs(['Strict-Transport-Security', 'max-age=31536000']);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.strict_transport_security.present, true);
    assert.equal(inv.strict_transport_security.count, 1);
    assert.deepEqual(inv.strict_transport_security.values, ['max-age=31536000']);
    assert.equal(inv.strict_transport_security.first_position, 1);
  });

  test('D04 — case-insensitive matching (mixed-case wire name)', () => {
    const pairs = buildHeaderPairs(['STRICT-TRANSPORT-SECURITY', 'max-age=0']);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.strict_transport_security.present, true);
  });

  test('D05 — duplicate header → count:2, values array has both', () => {
    const raw   = ['X-Frame-Options', 'DENY', 'x-frame-options', 'SAMEORIGIN'];
    const pairs = buildHeaderPairs(raw);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.x_frame_options.count, 2);
    assert.deepEqual(inv.x_frame_options.values, ['DENY', 'SAMEORIGIN']);
  });

  test('D06 — first_position reflects wire position of first occurrence', () => {
    const raw   = ['Content-Type', 'text/html', 'Content-Security-Policy', 'default-src \'none\''];
    const pairs = buildHeaderPairs(raw);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.content_security_policy.first_position, 2);
  });

  test('D07 — non-security headers do not pollute inventory', () => {
    const pairs = buildHeaderPairs(['Content-Type', 'text/html', 'Content-Length', '42']);
    const inv   = extractSecurityHeaders(pairs);
    // All 25 keys present, none of them truthy for content-type/length
    assert.equal(Object.keys(inv).length, 25);
    for (const obs of Object.values(inv)) {
      assert.equal(obs.present, false);
    }
  });

  test('D08 — server header captured (information disclosure)', () => {
    const pairs = buildHeaderPairs(['server', 'nginx/1.24.0']);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.server.present, true);
    assert.deepEqual(inv.server.values, ['nginx/1.24.0']);
  });

  test('D09 — feature_policy captured alongside permissions_policy', () => {
    const raw = [
      'Permissions-Policy', 'geolocation=()',
      'Feature-Policy',     'geolocation \'none\'',
    ];
    const pairs = buildHeaderPairs(raw);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.permissions_policy.present, true);
    assert.equal(inv.feature_policy.present, true);
  });
});

// ── E. fetchEndpoint (HTTPS, follows redirects) ───────────────────────────────

describe('E. fetchEndpoint', () => {
  test('E01 — 200 response → RESPONSE_OBSERVED, correct url', async () => {
    const req = mockRequest({ 'https://example.com/': { status: 200 } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.url, 'https://example.com/');
    assert.equal(r.http_status, 200);
    assert.deepEqual(r.redirect_chain, []);
  });

  test('E02 — non-200 non-redirect → RESPONSE_OBSERVED', async () => {
    const req = mockRequest({ 'https://example.com/': { status: 503 } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.http_status, 503);
  });

  test('E03 — 301 redirect followed to final 200', async () => {
    const req = mockRequest({
      'https://example.com/':     { status: 301, location: 'https://www.example.com/' },
      'https://www.example.com/': { status: 200 },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.url, 'https://www.example.com/');
    assert.equal(r.redirect_chain.length, 1);
    assert.equal(r.redirect_chain[0].url, 'https://example.com/');
    assert.equal(r.redirect_chain[0].http_status, 301);
    assert.equal(r.redirect_chain[0].location, 'https://www.example.com/');
  });

  test('E04 — 302 redirect followed', async () => {
    const req = mockRequest({
      'https://example.com/':     { status: 302, location: 'https://other.com/' },
      'https://other.com/':       { status: 200 },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.redirect_chain.length, 1);
  });

  test('E05 — redirect without location → REDIRECT_UNRESOLVED', async () => {
    const req = mockRequest({ 'https://example.com/': { status: 301 } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'REDIRECT_UNRESOLVED');
    assert.equal(r.redirect_chain.length, 1);
  });

  test('E06 — exactly MAX_REDIRECTS redirects → REDIRECT_UNRESOLVED on 10th', async () => {
    const routes = {};
    for (let i = 0; i <= 10; i++) {
      const url  = `https://example.com/r${i}/`;
      const next = `https://example.com/r${i + 1}/`;
      routes[url] = { status: 301, location: next };
    }
    routes['https://example.com/'] = { status: 301, location: 'https://example.com/r0/' };
    const req = mockRequest(routes);
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'REDIRECT_UNRESOLVED');
    assert.ok(r.redirect_chain.length > 0);
  });

  test('E07 — TLS error → TLS_ERROR', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'tls' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TLS_ERROR');
    assert.equal(r.http_status, null);
    assert.deepEqual(r.redirect_chain, []);
    assert.deepEqual(r.header_pairs, []);
  });

  test('E08 — connection error → CONNECTION_ERROR', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'network' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'CONNECTION_ERROR');
  });

  test('E09 — timeout → TIMEOUT', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'timeout' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TIMEOUT');
  });

  test('E10 — ERR_SSL_ code → TLS_ERROR', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'tls_ssl' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TLS_ERROR');
  });

  test('E11 — response headers are captured as header_pairs', async () => {
    const req = mockRequest({
      'https://example.com/': {
        status:  200,
        headers: { 'Strict-Transport-Security': 'max-age=31536000' },
      },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.header_pairs.length, 1);
    assert.equal(r.header_pairs[0].name_raw, 'Strict-Transport-Security');
  });

  test('E12 — headers from redirect hops are NOT in final header_pairs (final response only)', async () => {
    const req = mockRequest({
      'https://example.com/':     { status: 301, location: 'https://www.example.com/', headers: { 'X-Hop': '1' } },
      'https://www.example.com/': { status: 200, headers: { 'X-Frame-Options': 'DENY' } },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.header_pairs.length, 1);
    assert.equal(r.header_pairs[0].name_raw, 'X-Frame-Options');
  });

  test('E13 — AbortError → TIMEOUT', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'abort' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TIMEOUT');
  });

  test('E14 — ETIMEDOUT code → TIMEOUT', async () => {
    const req = mockRequest({ 'https://example.com/': { error: 'etimedout' } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TIMEOUT');
  });

  test('E15 — relative location resolved against current URL', async () => {
    const req = mockRequest({
      'https://example.com/':      { status: 301, location: '/new/' },
      'https://example.com/new/':  { status: 200 },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.url, 'https://example.com/new/');
  });

  test('E16 — 308 redirect followed', async () => {
    const req = mockRequest({
      'https://example.com/':     { status: 308, location: 'https://secure.example.com/' },
      'https://secure.example.com/': { status: 200 },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.redirect_chain.length, 1);
  });

  test('E17 — 404 response → RESPONSE_OBSERVED (not an error)', async () => {
    const req = mockRequest({ 'https://example.com/': { status: 404 } });
    const r   = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.http_status, 404);
  });
});

// ── F. fetchProbe (HTTP, single non-following request) ────────────────────────

describe('F. fetchProbe', () => {
  test('F01 — 200 response → RESPONSE_OBSERVED, redirect_chain always []', async () => {
    const req = mockRequest({ 'http://example.com/': { status: 200 } });
    const r   = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.url, 'http://example.com/');
    assert.deepEqual(r.redirect_chain, []);
  });

  test('F02 — 301 response → RESPONSE_OBSERVED, redirect NOT followed, redirect_chain []', async () => {
    const req = mockRequest({ 'http://example.com/': { status: 301, location: 'https://example.com/' } });
    const r   = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    assert.equal(r.http_status, 301);
    assert.deepEqual(r.redirect_chain, []);
  });

  test('F03 — connection error → CONNECTION_ERROR', async () => {
    const req = mockRequest({ 'http://example.com/': { error: 'network' } });
    const r   = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'CONNECTION_ERROR');
    assert.equal(r.http_status, null);
  });

  test('F04 — timeout → TIMEOUT', async () => {
    const req = mockRequest({ 'http://example.com/': { error: 'timeout' } });
    const r   = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TIMEOUT');
  });

  test('F05 — headers captured from single response', async () => {
    const req = mockRequest({
      'http://example.com/': {
        status:  200,
        headers: { 'Server': 'Apache' },
      },
    });
    const r = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.header_pairs.length, 1);
    assert.equal(r.header_pairs[0].name_raw, 'Server');
  });

  test('F06 — url is always http:// scheme', async () => {
    const req = mockRequest({ 'http://uni.ac.uk/': { status: 200 } });
    const r   = await fetchProbe('uni.ac.uk', { requestFn: req });
    assert.ok(r.url.startsWith('http://'));
  });

  test('F07 — TLS error on HTTP probe → TLS_ERROR (edge: STARTTLS-like misconfiguration)', async () => {
    const req = mockRequest({ 'http://example.com/': { error: 'tls' } });
    const r   = await fetchProbe('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TLS_ERROR');
  });
});

// ── G. collectSecurityHeaders ─────────────────────────────────────────────────

describe('G. collectSecurityHeaders', () => {
  test('G01 — returns all top-level fields', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301, location: 'https://example.com/' } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.domain, 'example.com');
    assert.ok(typeof r.collected_at === 'string');
    assert.equal(r.signal_version, SIGNAL_VERSION);
    assert.equal(r.collector_version, '1.0.0');
    assert.ok(r.https_fetch != null);
    assert.ok(r.http_probe  != null);
    assert.ok(r.header_inventory != null);
    assert.equal(Object.keys(r.header_inventory).length, 25);
  });

  test('G02 — endpoint_state mirrors https_fetch.fetch_outcome', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.endpoint_state, r.https_fetch.fetch_outcome);
  });

  test('G03 — http_probe_state mirrors http_probe.fetch_outcome', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301, location: 'https://example.com/' } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.http_probe_state, r.http_probe.fetch_outcome);
  });

  test('G04 — TLS_ERROR on HTTPS → endpoint_state=TLS_ERROR, http_probe independent', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { error: 'tls' } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301, location: 'https://example.com/' } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.endpoint_state,   'TLS_ERROR');
    assert.equal(r.http_probe_state, 'RESPONSE_OBSERVED');
  });

  test('G05 — header_inventory built from https_fetch headers only', async () => {
    const httpsReq = mockRequest({
      'https://example.com/': {
        status:  200,
        headers: { 'Strict-Transport-Security': 'max-age=31536000' },
      },
    });
    const httpReq = mockRequest({
      'http://example.com/': {
        status:  200,
        headers: { 'X-Frame-Options': 'DENY' },
      },
    });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.header_inventory.strict_transport_security.present, true);
    assert.equal(r.header_inventory.x_frame_options.present, false);
  });

  test('G06 — TLS error → header_inventory all absent', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { error: 'tls' } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    for (const obs of Object.values(r.header_inventory)) {
      assert.equal(obs.present, false);
    }
  });

  test('G07 — collected_at is valid ISO 8601 timestamp', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 200 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.ok(!isNaN(Date.parse(r.collected_at)));
  });

  test('G08 — HTTPS and HTTP fetches run concurrently (both called)', async () => {
    let httpsCallCount = 0;
    let httpCallCount  = 0;
    const httpsReq = async (url) => { httpsCallCount++; return { statusCode: 200, rawHeaders: [], resume() {} }; };
    const httpReq  = async (url) => { httpCallCount++;  return { statusCode: 200, rawHeaders: [], resume() {} }; };
    await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(httpsCallCount, 1);
    assert.equal(httpCallCount,  1);
  });

  test('G09 — multiple security headers present in https response', async () => {
    const httpsReq = mockRequest({
      'https://example.com/': {
        status: 200,
        headers: {
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'Content-Security-Policy':   'default-src \'self\'',
          'X-Frame-Options':           'DENY',
          'X-Content-Type-Options':    'nosniff',
          'Referrer-Policy':           'no-referrer',
        },
      },
    });
    const httpReq = mockRequest({ 'http://example.com/': { status: 301 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.header_inventory.strict_transport_security.present, true);
    assert.equal(r.header_inventory.content_security_policy.present, true);
    assert.equal(r.header_inventory.x_frame_options.present, true);
    assert.equal(r.header_inventory.x_content_type_options.present, true);
    assert.equal(r.header_inventory.referrer_policy.present, true);
  });

  test('G10 — collector_version defaults to exported COLLECTOR_VERSION', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 200 } });
    const r = await collectSecurityHeaders('example.com', undefined, {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.collector_version, COLLECTOR_VERSION);
  });
});

// ── H. Evidence integrity ─────────────────────────────────────────────────────

describe('H. Evidence integrity', () => {
  test('H01 — case preserved: Mixed-Case header name in header_pairs', async () => {
    const httpsReq = mockRequest({
      'https://example.com/': {
        status: 200,
        headers: { 'Strict-Transport-Security': 'max-age=31536000' },
      },
    });
    const httpReq = mockRequest({ 'http://example.com/': { status: 200 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    const sts = r.https_fetch.header_pairs.find(p => p.name_raw === 'Strict-Transport-Security');
    assert.ok(sts, 'header_pair should preserve Strict-Transport-Security casing');
  });

  test('H02 — duplicate header preserved: two X-Frame-Options in header_pairs and inventory', async () => {
    const rawHeaders = ['X-Frame-Options', 'DENY', 'X-Frame-Options', 'SAMEORIGIN'];
    const httpsReq  = async () => ({ statusCode: 200, rawHeaders, resume() {} });
    const httpReq   = mockRequest({ 'http://example.com/': { status: 200 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.https_fetch.header_pairs.length, 2);
    assert.equal(r.header_inventory.x_frame_options.count, 2);
    assert.deepEqual(r.header_inventory.x_frame_options.values, ['DENY', 'SAMEORIGIN']);
  });

  test('H03 — wire order preserved: position sequence reflects rawHeaders order', async () => {
    const rawHeaders = [
      'Server',                   'nginx',
      'Content-Type',             'text/html',
      'Strict-Transport-Security','max-age=31536000',
    ];
    const httpsReq = async () => ({ statusCode: 200, rawHeaders, resume() {} });
    const httpReq  = mockRequest({ 'http://example.com/': { status: 200 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    const pairs = r.https_fetch.header_pairs;
    assert.equal(pairs[0].name_raw, 'Server');
    assert.equal(pairs[0].position, 1);
    assert.equal(pairs[1].name_raw, 'Content-Type');
    assert.equal(pairs[1].position, 2);
    assert.equal(pairs[2].name_raw, 'Strict-Transport-Security');
    assert.equal(pairs[2].position, 3);
    assert.equal(r.header_inventory.strict_transport_security.first_position, 3);
  });

  test('H04 — http_probe redirect_chain is always empty', async () => {
    const httpsReq = mockRequest({ 'https://example.com/': { status: 200 } });
    const httpReq  = mockRequest({ 'http://example.com/':  { status: 301, location: 'https://example.com/' } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: httpsReq,
      httpRequestFn:  httpReq,
    });
    assert.deepEqual(r.http_probe.redirect_chain, []);
    assert.equal(r.http_probe.http_status, 301);
  });

  test('H05 — redirect chain records each hop url, status, location', async () => {
    const req = mockRequest({
      'https://example.com/':       { status: 301, location: 'https://www.example.com/' },
      'https://www.example.com/':   { status: 302, location: 'https://www.example.com/home/' },
      'https://www.example.com/home/': { status: 200 },
    });
    const httpReq = mockRequest({ 'http://example.com/': { status: 200 } });
    const r = await collectSecurityHeaders('example.com', '1.0.0', {
      httpsRequestFn: req,
      httpRequestFn:  httpReq,
    });
    assert.equal(r.https_fetch.redirect_chain.length, 2);
    assert.equal(r.https_fetch.redirect_chain[0].url,         'https://example.com/');
    assert.equal(r.https_fetch.redirect_chain[0].http_status, 301);
    assert.equal(r.https_fetch.redirect_chain[0].location,    'https://www.example.com/');
    assert.equal(r.https_fetch.redirect_chain[1].url,         'https://www.example.com/');
    assert.equal(r.https_fetch.redirect_chain[1].http_status, 302);
  });

  test('H06 — TLS_ERROR_CODES set membership: all expected codes present', () => {
    const expected = [
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
      'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_ALTNAME_FORMAT',
      'CERT_UNTRUSTED', 'CERT_REVOKED',
    ];
    for (const code of expected) {
      assert.ok(TLS_ERROR_CODES.has(code), `Expected TLS_ERROR_CODES to contain ${code}`);
    }
  });

  test('H07 — SECURITY_HEADER_MAP all canonical names are lowercase', () => {
    for (const [, canonical] of SECURITY_HEADER_MAP) {
      assert.equal(canonical, canonical.toLowerCase(),
        `canonical name should be lowercase: ${canonical}`);
    }
  });

  test('H08 — extractSecurityHeaders: first_position of duplicate is from first occurrence', () => {
    const raw   = ['X-A', 'unrelated', 'X-Frame-Options', 'DENY', 'X-Frame-Options', 'SAMEORIGIN'];
    const pairs = buildHeaderPairs(raw);
    const inv   = extractSecurityHeaders(pairs);
    assert.equal(inv.x_frame_options.first_position, 2);
  });

  test('H09 — fetchProbe url is http:// regardless of any redirect in response', async () => {
    const req = mockRequest({ 'http://uni.ac.uk/': { status: 301, location: 'https://uni.ac.uk/' } });
    const r   = await fetchProbe('uni.ac.uk', { requestFn: req });
    assert.ok(r.url.startsWith('http://'));
    assert.equal(r.url, 'http://uni.ac.uk/');
  });

  test('H10 — fetchEndpoint error after redirect includes redirect_chain so far', async () => {
    const req = mockRequest({
      'https://example.com/':     { status: 301, location: 'https://www.example.com/' },
      'https://www.example.com/': { error: 'tls' },
    });
    const r = await fetchEndpoint('example.com', { requestFn: req });
    assert.equal(r.fetch_outcome, 'TLS_ERROR');
    assert.equal(r.redirect_chain.length, 1);
    assert.equal(r.redirect_chain[0].url, 'https://example.com/');
  });
});

// ── I. SLG-136 source-authentication harmonisation (§7 R-1, C-4/C-5/C-7) ──────
// The v1 defect: a failed certificate discarded BOTH the headers AND the verdict
// (endpoint_state=TLS_ERROR, empty header_pairs). v2: observe the response over
// an unauthenticated origin and record the verdict inseparably. These tests
// exercise the permissive-capture path via the injectable requestFn seam.

describe('I. Source-authentication verdict (SLG-136)', () => {
  test('I01 — deriveTlsVerdict: authorized socket → CHAIN_VERIFIED, no error code', () => {
    const v = deriveTlsVerdict({ authorized: true });
    assert.equal(v.tls_verification_result, 'CHAIN_VERIFIED');
    assert.equal(v.tls_error_code, null);
  });

  test('I02 — deriveTlsVerdict: expired cert → CERT_EXPIRED, specific code preserved', () => {
    const v = deriveTlsVerdict({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' });
    assert.equal(v.tls_verification_result, 'CERT_EXPIRED');
    assert.equal(v.tls_error_code, 'CERT_HAS_EXPIRED');
  });

  test('I03 — deriveTlsVerdict: hostname mismatch mapped, self-signed mapped', () => {
    assert.equal(deriveTlsVerdict({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' }).tls_verification_result, 'HOSTNAME_MISMATCH');
    assert.equal(deriveTlsVerdict({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).tls_verification_result, 'SELF_SIGNED');
  });

  test('I04 — deriveTlsVerdict: unmapped auth error → OTHER_TLS_ERROR, raw code kept (C-5)', () => {
    const v = deriveTlsVerdict({ authorized: false, authorizationError: 'SOME_NOVEL_CODE' });
    assert.equal(v.tls_verification_result, 'OTHER_TLS_ERROR');
    assert.equal(v.tls_error_code, 'SOME_NOVEL_CODE');
  });

  test('I05 — deriveTlsVerdict: non-TLS socket (HTTP probe) → nulls, no verdict invented', () => {
    const v = deriveTlsVerdict({});
    assert.equal(v.tls_verification_result, null);
    assert.equal(v.tls_error_code, null);
  });

  test('I06 — VERIFICATION_MAP mirrors the TLS collector vocabulary', () => {
    assert.equal(VERIFICATION_MAP.CERT_HAS_EXPIRED, 'CERT_EXPIRED');
    assert.equal(VERIFICATION_MAP.ERR_TLS_CERT_ALTNAME_INVALID, 'HOSTNAME_MISMATCH');
    assert.equal(VERIFICATION_MAP.SELF_SIGNED_CERT_IN_CHAIN, 'SELF_SIGNED_IN_CHAIN');
  });

  test('I07 — headers ARE captured over a failed certificate (the 653-domain fix)', async () => {
    // Origin serves headers but its cert is expired. v1 would have discarded both.
    const httpsReq = mockRequest({
      'https://expired.example/': {
        status: 200,
        headers: { 'Strict-Transport-Security': 'max-age=63072000', 'X-Frame-Options': 'DENY' },
        tls_verification_result: 'CERT_EXPIRED',
        tls_error_code: 'CERT_HAS_EXPIRED',
      },
    });
    const httpReq = mockRequest({ 'http://expired.example/': { status: 200 } });
    const r = await collectSecurityHeaders('expired.example', '2.0.0', {
      httpsRequestFn: httpsReq, httpRequestFn: httpReq,
    });
    // Observation is NOT dropped; endpoint_state reflects the response, not the cert.
    assert.equal(r.endpoint_state, 'RESPONSE_OBSERVED');
    assert.equal(r.header_inventory.strict_transport_security.present, true);
    assert.equal(r.header_inventory.x_frame_options.present, true);
    // Verdict recorded inseparably (inside https_fetch) AND mirrored at top level.
    assert.equal(r.https_fetch.tls_verification_result, 'CERT_EXPIRED');
    assert.equal(r.https_fetch.tls_error_code, 'CERT_HAS_EXPIRED');
    assert.equal(r.tls_verification_result, 'CERT_EXPIRED');
    assert.equal(r.tls_error_code, 'CERT_HAS_EXPIRED');
  });

  test('I08 — clean cert → CHAIN_VERIFIED verdict recorded alongside headers', async () => {
    const httpsReq = mockRequest({
      'https://good.example/': {
        status: 200,
        headers: { 'Content-Security-Policy': "default-src 'self'" },
        tls_verification_result: 'CHAIN_VERIFIED',
      },
    });
    const httpReq = mockRequest({ 'http://good.example/': { status: 200 } });
    const r = await collectSecurityHeaders('good.example', '2.0.0', {
      httpsRequestFn: httpsReq, httpRequestFn: httpReq,
    });
    assert.equal(r.tls_verification_result, 'CHAIN_VERIFIED');
    assert.equal(r.tls_error_code, null);
    assert.equal(r.header_inventory.content_security_policy.present, true);
  });

  test('I09 — terminal verdict reflects the connection that served the headers, and each hop is stamped', async () => {
    // Redirect from a self-signed origin to a well-authenticated final host.
    const httpsReq = mockRequest({
      'https://redir.example/': {
        status: 301, location: 'https://final.example/',
        tls_verification_result: 'SELF_SIGNED', tls_error_code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      },
      'https://final.example/': {
        status: 200, headers: { 'X-Content-Type-Options': 'nosniff' },
        tls_verification_result: 'CHAIN_VERIFIED',
      },
    });
    const r = await fetchEndpoint('redir.example', { requestFn: httpsReq });
    assert.equal(r.fetch_outcome, 'RESPONSE_OBSERVED');
    // Terminal verdict = final host.
    assert.equal(r.tls_verification_result, 'CHAIN_VERIFIED');
    // Hop verdict = the redirecting (self-signed) host — preserved per-hop (C-4).
    assert.equal(r.redirect_chain.length, 1);
    assert.equal(r.redirect_chain[0].tls_verification_result, 'SELF_SIGNED');
    assert.equal(r.redirect_chain[0].tls_error_code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  test('I10 — genuine TLS-protocol failure (thrown) still → TLS_ERROR, verdict null (C-5)', async () => {
    // A handshake that throws (protocol mismatch) is NOT a source-auth verdict —
    // no response observed. Specific cause preserved; verdict null (nothing to record).
    const httpsReq = mockRequest({ 'https://proto.example/': { error: 'tls_ssl' } });
    const r = await fetchEndpoint('proto.example', { requestFn: httpsReq });
    assert.equal(r.fetch_outcome, 'TLS_ERROR');
    assert.equal(r.tls_verification_result, null);
    assert.equal(r.tls_error_code, null);
    assert.deepEqual(r.header_pairs, []);
  });

  test('I11 — HTTP probe carries no TLS verdict field (not applicable)', async () => {
    const httpReq = mockRequest({ 'http://plain.example/': { status: 200 } });
    const r = await fetchProbe('plain.example', { requestFn: httpReq });
    assert.equal(r.tls_verification_result, undefined); // probe result intentionally omits the field
  });
});
