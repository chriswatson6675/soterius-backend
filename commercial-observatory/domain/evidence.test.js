'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { contentHash, normaliseSourceUrl, validateEvidenceInput, buildEvidenceRecord } = require('./evidence');

describe('contentHash', () => {
  test('is deterministic for identical string content', () => {
    assert.strictEqual(contentHash('hello world'), contentHash('hello world'));
  });

  test('is order-insensitive for object content (canonicalised)', () => {
    assert.strictEqual(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  });

  test('differs for different content', () => {
    assert.notStrictEqual(contentHash('a'), contentHash('b'));
  });
});

describe('normaliseSourceUrl', () => {
  test('lowercases the host and strips a trailing slash', () => {
    assert.strictEqual(normaliseSourceUrl('https://WWW.Example.com/About/'), 'example.com/About');
  });

  test('returns null for an unparseable URL', () => {
    assert.strictEqual(normaliseSourceUrl('not a url'), null);
  });
});

describe('validateEvidenceInput / buildEvidenceRecord', () => {
  const BASE = { investigationId: 'inv-1', sourceUrl: 'https://example.com/about', retrievedAt: '2026-07-14T00:00:00.000Z', evidenceClass: 'public' };

  test('accepts a well-formed evidence input', () => {
    assert.strictEqual(validateEvidenceInput(BASE).valid, true);
  });

  test('rejects an invalid evidence class', () => {
    assert.strictEqual(validateEvidenceInput({ ...BASE, evidenceClass: 'rumour' }).valid, false);
  });

  test('buildEvidenceRecord computes a content hash only when raw content is supplied', () => {
    const withoutContent = buildEvidenceRecord(BASE);
    assert.strictEqual(withoutContent.contentHash, null);

    const withContent = buildEvidenceRecord({ ...BASE, rawContent: 'page text' });
    assert.ok(withContent.contentHash.startsWith('sha256:'));
  });

  test('buildEvidenceRecord throws on invalid input', () => {
    assert.throws(() => buildEvidenceRecord({ ...BASE, evidenceClass: 'rumour' }));
  });
});
