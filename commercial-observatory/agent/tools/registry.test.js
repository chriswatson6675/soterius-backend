'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createToolRegistry } = require('./registry');

function fakeTool(name) { return { name, description: `desc for ${name}`, inputSchema: {} }; }

describe('createToolRegistry', () => {
  test('registers valid tools and retrieves them by name', () => {
    const registry = createToolRegistry([fakeTool('search_web'), fakeTool('fetch_web_page')]);
    assert.strictEqual(registry.has('search_web'), true);
    assert.strictEqual(registry.get('search_web').name, 'search_web');
  });

  test('an unknown tool name is rejected (returns null, not thrown)', () => {
    const registry = createToolRegistry([fakeTool('search_web')]);
    assert.strictEqual(registry.get('invented_tool'), null);
    assert.strictEqual(registry.has('invented_tool'), false);
  });

  test('list() exposes name/description/inputSchema only, not internals', () => {
    const registry = createToolRegistry([fakeTool('search_web')]);
    const listed = registry.list();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].name, 'search_web');
  });

  test('throws at construction time for a tool missing a name', () => {
    assert.throws(() => createToolRegistry([{ description: 'no name' }]));
  });
});
