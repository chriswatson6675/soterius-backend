'use strict';

// llm-client — a minimal, real wrapper around the Anthropic SDK for the
// planner's decision-making step. Never throws; reports `{available:
// false}` honestly (never fabricates a response) when no API key is
// configured — a fully functional deterministic planning fallback exists
// precisely so the agent still works, and is still fully testable,
// without live LLM access (Part 13's explicit requirement).

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 1024;

function isConfigured(env = process.env) {
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * createLlmClient(deps) -> { isAvailable(), complete({system, prompt,
 *   maxTokens}) }
 *
 * `deps.anthropicClient` is injectable for tests (a fake `{ messages: {
 * create: async (opts) => ({...}) } }`) — no real SDK/network call is ever
 * required for tests.
 */
function createLlmClient(deps = {}) {
  const env = deps.env || process.env;
  let client = deps.anthropicClient || null;

  function ensureClient() {
    if (client) return client;
    if (!isConfigured(env)) return null;
    // eslint-disable-next-line global-require
    const AnthropicModule = require('@anthropic-ai/sdk');
    const AnthropicCtor = typeof AnthropicModule === 'function' ? AnthropicModule : AnthropicModule.default;
    client = new AnthropicCtor({ apiKey: env.ANTHROPIC_API_KEY });
    return client;
  }

  function isAvailable() {
    return !!(deps.anthropicClient || isConfigured(env));
  }

  async function complete({ system, prompt, maxTokens = DEFAULT_MAX_TOKENS, model = DEFAULT_MODEL } = {}) {
    const anthropic = ensureClient();
    if (!anthropic) {
      return { available: false, reason: 'ANTHROPIC_API_KEY is not configured — deterministic planning fallback in use.' };
    }
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = (response.content || []).map((block) => block.text || '').join('');
      return {
        available: true,
        text,
        usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
      };
    } catch (err) {
      return { available: false, reason: `LLM call failed: ${err.message}` };
    }
  }

  return { isAvailable, complete };
}

module.exports = { createLlmClient, isConfigured, DEFAULT_MODEL, DEFAULT_MAX_TOKENS };
