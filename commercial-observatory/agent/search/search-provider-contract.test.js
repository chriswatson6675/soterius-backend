'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RESULTS_CAP,
  validateProviderInput,
  clampMaxResults,
  normaliseResultUrl,
  buildProviderSuccessResult,
  buildProviderFailureResult,
} = require('./search-provider-contract');

describe('validateProviderInput', () => {
  test('accepts a minimal valid input', () => {
    const { valid } = validateProviderInput({ query: 'Compliance Office' });
    assert.strictEqual(valid, true);
  });

  test('rejects a missing/empty query', () => {
    assert.strictEqual(validateProviderInput({}).valid, false);
    assert.strictEqual(validateProviderInput({ query: '' }).valid, false);
    assert.strictEqual(validateProviderInput({ query: '   ' }).valid, false);
  });

  test('rejects a non-string optional field', () => {
    const { valid, errors } = validateProviderInput({ query: 'x', country: 123 });
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.includes('country')));
  });
});

describe('clampMaxResults', () => {
  test('defaults honestly when omitted', () => {
    assert.ok(clampMaxResults(undefined) > 0);
    assert.ok(clampMaxResults(undefined) <= MAX_RESULTS_CAP);
  });

  test('never exceeds the hard cap even when a much higher count is requested', () => {
    assert.strictEqual(clampMaxResults(999), MAX_RESULTS_CAP);
  });
});

describe('normaliseResultUrl', () => {
  test('accepts a well-formed https URL', () => {
    assert.strictEqual(normaliseResultUrl('https://example.com/page'), 'https://example.com/page');
  });

  test('rejects a non-http(s) protocol', () => {
    assert.strictEqual(normaliseResultUrl('javascript:alert(1)'), null);
    assert.strictEqual(normaliseResultUrl('mailto:someone@example.com'), null);
    assert.strictEqual(normaliseResultUrl('ftp://example.com/file'), null);
  });

  test('rejects an unparseable URL', () => {
    assert.strictEqual(normaliseResultUrl('not a url'), null);
    assert.strictEqual(normaliseResultUrl(''), null);
    assert.strictEqual(normaliseResultUrl(null), null);
  });
});

describe('buildProviderSuccessResult', () => {
  test('produces a valid success envelope', () => {
    const result = buildProviderSuccessResult('brave', 'q', [
      { title: 't', url: 'https://example.com/', snippet: 's', source: 'brave', rank: 1, retrievedAt: '2026-01-01T00:00:00.000Z', providerMetadata: {} },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'brave');
    assert.strictEqual(result.query, 'q');
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(result.usage, {});
    assert.strictEqual(result.requestId, null);
  });

  test('a result never carries an evidenceId or persisted flag — it is never itself evidence', () => {
    const result = buildProviderSuccessResult('brave', 'q', [
      { title: 't', url: 'https://example.com/', snippet: 's', source: 'brave', rank: 1, retrievedAt: '2026-01-01T00:00:00.000Z', providerMetadata: {} },
    ]);
    for (const r of result.results) {
      assert.strictEqual(r.evidenceId, undefined);
      assert.strictEqual(r.persisted, undefined);
    }
  });

  test('strips anything credential-shaped out of providerMetadata as a last line of defence', () => {
    const result = buildProviderSuccessResult('brave', 'q', [
      { title: 't', url: 'https://example.com/', snippet: 's', source: 'brave', rank: 1, retrievedAt: '2026-01-01T00:00:00.000Z', providerMetadata: { apiKey: 'super-secret', language: 'en' } },
    ]);
    assert.strictEqual(result.results[0].providerMetadata.apiKey, undefined);
    assert.strictEqual(result.results[0].providerMetadata.language, 'en');
    assert.ok(!JSON.stringify(result).includes('super-secret'));
  });
});

describe('buildProviderFailureResult', () => {
  test('produces a valid failure envelope', () => {
    const result = buildProviderFailureResult('brave', 'q', { errorType: 'http_error', error: 'boom', status: 500, retryable: true });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.provider, 'brave');
    assert.strictEqual(result.errorType, 'http_error');
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.retryable, true);
  });

  test('a malformed/incomplete result shape is never silently accepted as evidence-bearing', () => {
    // A caller that omits required identity fields still gets a structurally
    // valid, clearly-marked failure back, not a thrown error or a
    // half-formed success shape.
    const result = buildProviderFailureResult('brave', undefined, { errorType: 'invalid_input', error: 'query missing' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.query, undefined);
  });

  test('never includes a credential-shaped field in a failure result', () => {
    const result = buildProviderFailureResult('brave', 'q', { errorType: 'authentication_error', error: 'invalid key ending 9f3a' });
    assert.ok(!('apiKey' in result));
    assert.ok(!('token' in result));
  });
});
