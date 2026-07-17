'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fetchUrl } = require('./web-fetch');

const SAFE = () => Promise.resolve({ safe: true, addresses: ['93.184.216.34'], reason: null });

function fakeClientReturning(responses) {
  let call = 0;
  return async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (r.throws) throw r.throws;
    return r;
  };
}

describe('fetchUrl — success', () => {
  test('returns a structured success result for a 200 response', async () => {
    const result = await fetchUrl('https://example.com/', {
      resolveHostnameSafely: SAFE,
      httpClient: async () => ({ status: 200, data: '<html>hi</html>', headers: { 'content-type': 'text/html' }, finalUrl: 'https://example.com/' }),
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, '<html>hi</html>');
    assert.strictEqual(result.contentType, 'text/html');
    assert.ok(result.retrievedAt);
  });

  test('reports the final URL after a redirect', async () => {
    const result = await fetchUrl('https://example.com/', {
      resolveHostnameSafely: SAFE,
      httpClient: async () => ({ status: 200, data: 'ok', headers: {}, finalUrl: 'https://www.example.com/' }),
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.requestedUrl, 'https://example.com/');
    assert.strictEqual(result.finalUrl, 'https://www.example.com/');
  });
});

describe('fetchUrl — retry behaviour', () => {
  test('retries once on a timeout, succeeding on the second attempt', async () => {
    const client = fakeClientReturning([
      { throws: Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' }) },
      { status: 200, data: 'ok', headers: {}, finalUrl: 'https://example.com/' },
    ]);
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, true);
  });

  test('a timeout on both attempts is reported as a retryable timeout failure', async () => {
    const client = fakeClientReturning([
      { throws: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) },
      { throws: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) },
    ]);
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  test('retries once on a 5xx response, succeeding on the second attempt', async () => {
    const client = fakeClientReturning([
      { status: 503, data: 'unavailable', headers: {}, finalUrl: 'https://example.com/' },
      { status: 200, data: 'ok', headers: {}, finalUrl: 'https://example.com/' },
    ]);
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, true);
  });

  test('a 5xx on both attempts is reported as a retryable server_error failure', async () => {
    const client = fakeClientReturning([
      { status: 500, data: '', headers: {}, finalUrl: 'https://example.com/' },
      { status: 500, data: '', headers: {}, finalUrl: 'https://example.com/' },
    ]);
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'server_error');
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.retryable, true);
  });

  test('a 4xx response is never retried', async () => {
    let calls = 0;
    const client = async () => { calls += 1; return { status: 404, data: '', headers: {}, finalUrl: 'https://example.com/missing' }; };
    const result = await fetchUrl('https://example.com/missing', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'http_error');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(calls, 1);
  });

  test('a connection error (ECONNREFUSED) is retried once', async () => {
    const client = fakeClientReturning([
      { throws: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) },
      { status: 200, data: 'ok', headers: {}, finalUrl: 'https://example.com/' },
    ]);
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: client, retryDelayMs: 0 });
    assert.strictEqual(result.success, true);
  });
});

describe('fetchUrl — size limit', () => {
  test('rejects a response body larger than the configured maximum', async () => {
    const bigBody = 'x'.repeat(1000);
    const result = await fetchUrl('https://example.com/', {
      resolveHostnameSafely: SAFE,
      maxContentBytes: 100,
      httpClient: async () => ({ status: 200, data: bigBody, headers: {}, finalUrl: 'https://example.com/' }),
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'response_too_large');
  });
});

describe('fetchUrl — protocol and SSRF safety', () => {
  test('rejects a non-HTTP protocol without ever calling the HTTP client', async () => {
    let called = false;
    const result = await fetchUrl('ftp://example.com/file', {
      resolveHostnameSafely: SAFE,
      httpClient: async () => { called = true; return { status: 200, data: '', headers: {}, finalUrl: '' }; },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'unsupported_protocol');
    assert.strictEqual(called, false);
  });

  test('rejects mailto: links', async () => {
    const result = await fetchUrl('mailto:someone@example.com', { resolveHostnameSafely: SAFE, httpClient: async () => ({}) });
    assert.strictEqual(result.errorType, 'unsupported_protocol');
  });

  test('blocks a destination whose hostname resolves to a private address, without calling the HTTP client', async () => {
    let called = false;
    const result = await fetchUrl('https://sneaky.example.com/', {
      resolveHostnameSafely: async () => ({ safe: false, addresses: ['127.0.0.1'], reason: 'resolves_to_private_address' }),
      httpClient: async () => { called = true; return { status: 200, data: '', headers: {}, finalUrl: '' }; },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'ssrf_blocked');
    assert.strictEqual(called, false);
  });

  test('blocks localhost directly', async () => {
    const result = await fetchUrl('http://localhost:5432/', {
      resolveHostnameSafely: async () => ({ safe: false, addresses: [], reason: 'local_hostname' }),
      httpClient: async () => ({ status: 200, data: '', headers: {}, finalUrl: '' }),
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'ssrf_blocked');
  });
});

describe('fetchUrl — never throws', () => {
  test('an unexpected thrown error is captured as a structured failure', async () => {
    const result = await fetchUrl('https://example.com/', {
      resolveHostnameSafely: SAFE,
      httpClient: async () => { throw new Error('something unexpected'); },
      retryDelayMs: 0,
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'unknown_error');
  });

  test('never includes credential-shaped fields in a failure result', async () => {
    const result = await fetchUrl('https://example.com/', { resolveHostnameSafely: SAFE, httpClient: async () => { throw new Error('boom'); }, retryDelayMs: 0 });
    const keys = Object.keys(result);
    assert.ok(!keys.some((k) => /token|password|secret|authorization/i.test(k)));
  });
});
