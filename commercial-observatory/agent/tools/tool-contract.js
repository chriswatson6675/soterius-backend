'use strict';

// Shared tool contract for the Commercial Observatory Research Agent
// (execution architecture design, §E "Tool catalogue", applied for real).
//
// Every tool is a plain object: { name, description, inputSchema,
// validateInput(input), timeoutMs, maxRetries, costHint, execute(input,
// context) }. `execute` NEVER writes to the dossier — it returns an
// OBSERVATION for the orchestrator to validate and persist (Part 1's
// central rule). The only tools whose `execute` touches persistence at all
// are the explicit record_* tools and the reused `inspect_target_website`
// pipeline (documented exception — see tools/inspect-target-website.js);
// every one of those checks `context.dryRun` itself and performs zero
// writes when it is true.
//
// A tool never throws — `wrapExecute` catches anything unexpected and
// converts it into the same structured failure shape every tool already
// returns for its own expected failures.

function successResult(toolName, output, { provenance = null, costMetadata = null } = {}) {
  return { success: true, toolName, output, provenance, costMetadata, retrievedAt: new Date().toISOString() };
}

function failureResult(toolName, { errorType, error, retryable = false }) {
  return { success: false, toolName, errorType, error, retryable, retrievedAt: new Date().toISOString() };
}

/**
 * Wraps a tool's raw async executor so an unexpected thrown error becomes a
 * structured failure result instead of propagating — the "never throw"
 * discipline every other Commercial Observatory tool (web-fetch.js, etc.)
 * already follows.
 */
function wrapExecute(toolName, rawExecute) {
  return async function execute(input, context = {}) {
    try {
      return await rawExecute(input, context);
    } catch (err) {
      return failureResult(toolName, { errorType: 'unexpected_error', error: err.message, retryable: false });
    }
  };
}

/**
 * Minimal hand-rolled input validator — matches this codebase's existing
 * convention (domain/*.js) rather than introducing a JSON-Schema library.
 * `schema.required`: array of required field names.
 * `schema.properties`: { field: { type: 'string'|'number'|'boolean'|'array', optional } }
 */
function validateInput(input, schema) {
  const errors = [];
  if (!input || typeof input !== 'object') return { valid: false, errors: ['Input must be an object.'] };

  for (const field of schema.required || []) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      errors.push(`${field} is required.`);
    }
  }
  for (const [field, spec] of Object.entries(schema.properties || {})) {
    const value = input[field];
    if (value === undefined) continue;
    if (spec.type === 'array' && !Array.isArray(value)) errors.push(`${field} must be an array.`);
    else if (spec.type !== 'array' && spec.type && typeof value !== spec.type) errors.push(`${field} must be a ${spec.type}.`);
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${field} must be one of ${spec.enum.join(', ')}.`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { successResult, failureResult, wrapExecute, validateInput };
