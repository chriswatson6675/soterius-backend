'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./args');

describe('parseArgs', () => {
  test('parses --key=value pairs', () => {
    const result = parseArgs(['--domain=example.com', '--name=Example Ltd']);
    assert.deepStrictEqual(result, { domain: 'example.com', name: 'Example Ltd' });
  });

  test('converts kebab-case keys to camelCase', () => {
    const result = parseArgs(['--investigation-id=abc-123']);
    assert.deepStrictEqual(result, { investigationId: 'abc-123' });
  });

  test('treats a bare --flag as boolean true', () => {
    const result = parseArgs(['--dry-run']);
    assert.deepStrictEqual(result, { dryRun: true });
  });

  test('ignores non-flag positional arguments', () => {
    const result = parseArgs(['node', 'script.js', '--domain=example.com']);
    assert.deepStrictEqual(result, { domain: 'example.com' });
  });

  test('empty argv produces an empty object', () => {
    assert.deepStrictEqual(parseArgs([]), {});
  });
});
