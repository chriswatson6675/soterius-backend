'use strict';

// createInvestigation — backend-only service that initialises a new
// Commercial Observatory Investigation (execution architecture design, §B
// "when does it begin"). Deliberately inert: it validates input, persists
// the Investigation and its initial (empty) Dossier, and logs the
// investigation_created Agent Event — nothing more. It does not call an
// LLM, search the web, fetch pages, start a worker, or write into any
// canonical Organisation Authority / Commercial Authority table.

const { normaliseDomain } = require('../../authority/lib/normalise');
const { validateNewInvestigationInput } = require('./investigation');
const persistence = require('../persistence/db');

/**
 * @param {{name?: string, domain?: string, rerunOf?: string}} input
 * @param {{client?: object}} deps
 * @returns {Promise<{success: true, investigationId: string, investigation: object, dossier: object} | {success: false, error: string}>}
 */
async function createInvestigation({ name, domain, rerunOf = null } = {}, deps = {}) {
  const { valid, errors } = validateNewInvestigationInput({ name, domain });
  if (!valid) return { success: false, error: errors.join('; ') };

  const normalisedDomain = domain ? normaliseDomain(domain) : null;

  const investigationResult = await persistence.createInvestigation(
    { name, domain, normalisedDomain, rerunOf },
    deps,
  );
  if (!investigationResult.success) return investigationResult;

  const { investigation } = investigationResult;

  const dossierResult = await persistence.createInitialDossier(
    investigation.id,
    { name: name || null, domain: domain || null },
    deps,
  );
  if (!dossierResult.success) {
    return { success: false, error: `Investigation created (${investigation.id}) but initial dossier failed: ${dossierResult.error}` };
  }

  const eventResult = await persistence.appendAgentEvent(
    {
      investigationId: investigation.id,
      eventType: 'investigation_created',
      stepNumber: 0,
      payload: { name: name || null, domain: domain || null, rerunOf },
    },
    deps,
  );
  if (!eventResult.success) {
    return { success: false, error: `Investigation created (${investigation.id}) but the creation event could not be logged: ${eventResult.error}` };
  }

  return {
    success: true,
    investigationId: investigation.id,
    investigation,
    dossier: dossierResult.dossier,
  };
}

module.exports = { createInvestigation };
