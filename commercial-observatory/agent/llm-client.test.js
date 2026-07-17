'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLlmClient, isConfigured } = require('./llm-client');

describe('llm-client', () => {
  test('isAvailable() is false with no API key and no injected client', () => {
    const client = createLlmClient({ env: {} });
    assert.strictEqual(client.isAvailable(), false);
  });

  test('complete() reports available:false honestly when not configured, never throws', async () => {
    const client = createLlmClient({ env: {} });
    const result = await client.complete({ system: 'x', prompt: 'y' });
    assert.strictEqual(result.available, false);
    assert.ok(result.reason);
  });

  test('uses an injected fake Anthropic client without any real network/API key', async () => {
    const fakeAnthropicClient = {
      messages: {
        create: async () => ({ content: [{ text: '{"action":"finish"}' }], usage: { input_tokens: 10, output_tokens: 5 } }),
      },
    };
    const client = createLlmClient({ anthropicClient: fakeAnthropicClient, env: {} });
    assert.strictEqual(client.isAvailable(), true);
    const result = await client.complete({ system: 'x', prompt: 'y' });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.text, '{"action":"finish"}');
    assert.strictEqual(result.usage.inputTokens, 10);
  });

  test('a thrown error from the LLM call is reported as unavailable, never propagated', async () => {
    const fakeAnthropicClient = { messages: { create: async () => { throw new Error('rate limited'); } } };
    const client = createLlmClient({ anthropicClient: fakeAnthropicClient, env: {} });
    const result = await client.complete({ system: 'x', prompt: 'y' });
    assert.strictEqual(result.available, false);
  });

  test('isConfigured() reflects ANTHROPIC_API_KEY presence', () => {
    assert.strictEqual(isConfigured({}), false);
    assert.strictEqual(isConfigured({ ANTHROPIC_API_KEY: 'x' }), true);
  });
});
