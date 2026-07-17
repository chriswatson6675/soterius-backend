'use strict';

// inspect_target_website — wraps the ALREADY-EXISTING, already-tested
// bounded homepage/internal-page pipeline (research/research-website.js)
// verbatim, per Part 1's "do not implement fake tools where a real
// repository capability already exists."
//
// DOCUMENTED EXCEPTION to "tools never write directly": research-
// website.js's own design already persists evidence/relationships/
// discoveries and updates the dossier atomically as part of one coherent,
// tested unit — reimplementing it as an observations-only tool would mean
// duplicating (and risking diverging from) a working pipeline for no
// benefit. Because this tool's underlying implementation cannot run
// side-effect-free, it refuses to run in dry-run mode at all (returns a
// structured "skipped — writes are inherent to this tool" result) rather
// than silently violating the dry-run zero-write guarantee. In dry-run,
// the planner/orchestrator investigates the target's own site through the
// granular, genuinely side-effect-free tools instead (fetch_web_page +
// extract_entities + extract_relationships).

const { researchWebsite: defaultResearchWebsite } = require('../../research/research-website');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['investigationId'],
  properties: { investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createInspectTargetWebsiteTool(deps = {}) {
  const researchWebsite = deps.researchWebsite || defaultResearchWebsite;

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('inspect_target_website', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (context.dryRun) {
      return successResult('inspect_target_website', {
        skipped: true,
        reason: 'inspect_target_website persists evidence/relationships/discoveries as an inherent part of its existing implementation and cannot run side-effect-free — skipped in dry-run. Use fetch_web_page + extract_entities + extract_relationships to research the target site during dry-run instead.',
      });
    }

    const result = await researchWebsite(input.investigationId, context.deps || {});
    if (!result.success) {
      return failureResult('inspect_target_website', { errorType: 'research_failed', error: result.error, retryable: false });
    }
    return successResult('inspect_target_website', result, {
      provenance: { investigationId: input.investigationId, pagesVisited: result.pagesVisited?.length ?? 0 },
    });
  }

  return {
    name: 'inspect_target_website',
    description: "Runs the bounded homepage+internal-page research pipeline against the investigation's own target domain. Persists directly (see module header) — refuses to run in dry-run.",
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 120000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createInspectTargetWebsiteTool };
