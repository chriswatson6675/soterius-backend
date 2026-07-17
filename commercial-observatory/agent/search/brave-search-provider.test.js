'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createBraveSearchProvider } = require('./brave-search-provider');

function braveItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Result ${i}`, url: `https://example.com/${i}`, description: `description ${i}`,
  }));
}

describe('brave provider — successful result mapping', () => {
  test('maps Brave web.results into the provider-neutral shape', async () => {
    const httpGet = async () => ({ data: { web: { results: braveItems(2) } }, headers: {} });
    const provider = createBraveSearchProvider({ apiKey: 'fake-brave-key', httpGet });
    const result = await provider.search({ query: 'Compliance Office' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'brave');
    assert.strictEqual(result.results.length, 2);
    const [r0] = result.results;
    assert.strictEqual(r0.title, 'Result 0');
    assert.strictEqual(r0.url, 'https://example.com/0');
    assert.strictEqual(r0.snippet, 'description 0');
    assert.strictEqual(r0.source, 'brave');
    assert.ok(r0.retrievedAt);
  });

  test('preserves Brave\'s own original rank/order even when some entries are filtered out', async () => {
    const items = [
      { title: 'A', url: 'javascript:alert(1)', description: 'bad' }, // filtered — malformed/unsupported URL
      { title: 'B', url: 'https://good.example/1', description: 'good 1' },
      { title: 'C', url: 'https://good.example/2', description: 'good 2' },
    ];
    const httpGet = async () => ({ data: { web: { results: items } }, headers: {} });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.results[0].rank, 2); // original index 1 -> rank 2
    assert.strictEqual(result.results[1].rank, 3); // original index 2 -> rank 3
  });

  test('handles a missing description honestly — snippet is null, never fabricated', async () => {
    const httpGet = async () => ({ data: { web: { results: [{ title: 'No description', url: 'https://example.com/x' }] } }, headers: {} });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.results[0].snippet, null);
  });

  test('captures a request id where the response headers provide one', async () => {
    const httpGet = async () => ({ data: { web: { results: braveItems(1) } }, headers: { 'x-request-id': 'req-123' } });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.requestId, 'req-123');
  });

  test('never treats a Brave AI summary as factual evidence — only web.results is ever read', async () => {
    const httpGet = async () => ({
      data: { web: { results: braveItems(1) }, summarizer: { text: 'An AI-generated summary claiming things.' } },
      headers: {},
    });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.ok(!JSON.stringify(result).includes('AI-generated summary'));
  });
});

describe('brave provider — malformed URL filtering and result limits', () => {
  test('filters a malformed or unsupported result URL', async () => {
    const items = [
      { title: 'ok', url: 'https://example.com/ok', description: 'x' },
      { title: 'bad protocol', url: 'ftp://example.com/file', description: 'x' },
      { title: 'unparseable', url: 'not a url at all', description: 'x' },
    ];
    const httpGet = async () => ({ data: { web: { results: items } }, headers: {} });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].url, 'https://example.com/ok');
  });

  test('enforces the bounded maximum result count even if Brave returns more', async () => {
    const httpGet = async () => ({ data: { web: { results: braveItems(20) } }, headers: {} });
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x', maxResults: 3 });
    assert.strictEqual(result.results.length, 3);
  });
});

describe('brave provider — retry behaviour', () => {
  test('retries once on a connection failure (no response), succeeding on the second attempt', async () => {
    let calls = 0;
    const httpGet = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return { data: { web: { results: braveItems(1) } }, headers: {} };
    };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  test('retries once on a timeout', async () => {
    let calls = 0;
    const httpGet = async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('timeout of 10000ms exceeded'); e.code = 'ECONNABORTED'; throw e; }
      return { data: { web: { results: braveItems(1) } }, headers: {} };
    };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  test('retries once on HTTP 429', async () => {
    let calls = 0;
    const httpGet = async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('rate limited'); e.response = { status: 429 }; throw e; }
      return { data: { web: { results: braveItems(1) } }, headers: {} };
    };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  test('retries once on HTTP 5xx', async () => {
    let calls = 0;
    const httpGet = async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('server error'); e.response = { status: 503 }; throw e; }
      return { data: { web: { results: braveItems(1) } }, headers: {} };
    };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  test('does not retry an ordinary 4xx authentication/input error', async () => {
    let calls = 0;
    const httpGet = async () => { calls += 1; const e = new Error('bad request'); e.response = { status: 400 }; throw e; };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(calls, 1);
  });

  test('a 401/403 is reported as a non-retryable authentication_error, not a crash', async () => {
    const httpGet = async () => { const e = new Error('invalid key'); e.response = { status: 401 }; throw e; };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'authentication_error');
    assert.strictEqual(result.retryable, false);
  });
});

describe('brave provider — configuration and credential safety', () => {
  test('reports not_configured honestly when no API key is available, never throws', async () => {
    const originalKey = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const provider = createBraveSearchProvider({});
      const result = await provider.search({ query: 'x' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.errorType, 'not_configured');
    } finally {
      if (originalKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKey;
    }
  });

  test('sends the API key through the documented auth header, never the query string', async () => {
    let capturedParams = null;
    let capturedHeaders = null;
    const httpGet = async (url, opts) => { capturedParams = opts.params; capturedHeaders = opts.headers; return { data: { web: { results: [] } }, headers: {} }; };
    const provider = createBraveSearchProvider({ apiKey: 'super-secret-brave-key', httpGet });
    await provider.search({ query: 'x' });
    assert.strictEqual(capturedHeaders['X-Subscription-Token'], 'super-secret-brave-key');
    assert.ok(!('key' in capturedParams));
    assert.ok(!JSON.stringify(capturedParams).includes('super-secret-brave-key'));
  });

  test('incorporates a domain restriction into the query when there is no direct Brave parameter', async () => {
    let capturedParams = null;
    const httpGet = async (url, opts) => { capturedParams = opts.params; return { data: { web: { results: [] } }, headers: {} }; };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    await provider.search({ query: '"Compliance Office"', domainRestriction: 'complianceoffice.co.uk' });
    assert.ok(capturedParams.q.includes('site:complianceoffice.co.uk'));
  });

  test('passes optional country/language/freshness through as Brave-documented params', async () => {
    let capturedParams = null;
    const httpGet = async (url, opts) => { capturedParams = opts.params; return { data: { web: { results: [] } }, headers: {} }; };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet });
    await provider.search({ query: 'x', country: 'GB', language: 'en', freshness: 'py' });
    assert.strictEqual(capturedParams.country, 'GB');
    assert.strictEqual(capturedParams.search_lang, 'en');
    assert.strictEqual(capturedParams.freshness, 'py');
  });

  test('never leaks the API key in a failure result', async () => {
    const httpGet = async () => { throw new Error('boom'); };
    const provider = createBraveSearchProvider({ apiKey: 'super-secret-brave-key', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.ok(!JSON.stringify(result).includes('super-secret-brave-key'));
  });

  test('safely handles a malformed/unexpected provider error payload without crashing', async () => {
    const httpGet = async () => { const e = new Error('weird'); e.response = { status: 500, data: null }; throw e; };
    const provider = createBraveSearchProvider({ apiKey: 'fake', httpGet, maxRetries: 0 });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'http_error');
  });
});
