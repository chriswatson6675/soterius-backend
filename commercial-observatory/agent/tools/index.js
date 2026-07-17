'use strict';

// Default tool catalogue — every tool the Research Agent may ever call.
// The planner/orchestrator only ever sees this registry; a tool name it
// does not recognise cannot be executed, however an LLM phrases its
// decision (see registry.js).

const { createToolRegistry } = require('./registry');
const { createSearchWebTool } = require('./search-web');
const { createFetchWebPageTool } = require('./fetch-web-page');
const { createInspectTargetWebsiteTool } = require('./inspect-target-website');
const { createReadPdfTool } = require('./read-pdf');
const { createCompaniesHouseLookupTool } = require('./companies-house-lookup');
const { createFcaLookupTool } = require('./fca-lookup');
const { createSraLookupTool } = require('./sra-lookup');
const { createExtractEntitiesTool } = require('./extract-entities');
const { createExtractRelationshipsTool } = require('./extract-relationships');
const { createRecordEvidenceTool } = require('./record-evidence');
const { createRecordClaimTool } = require('./record-claim');
const { createRecordDiscoveryTool } = require('./record-discovery');
const { createFinishInvestigationTool } = require('./finish-investigation');

function buildDefaultToolCatalogue(deps = {}) {
  return [
    createSearchWebTool(deps.searchWeb || {}),
    createFetchWebPageTool(deps.fetchWebPage || {}),
    createInspectTargetWebsiteTool(deps.inspectTargetWebsite || {}),
    createReadPdfTool(deps.readPdf || {}),
    createCompaniesHouseLookupTool(deps.companiesHouseLookup || {}),
    createFcaLookupTool(deps.fcaLookup || {}),
    createSraLookupTool(deps.sraLookup || {}),
    createExtractEntitiesTool(deps.extractEntities || {}),
    createExtractRelationshipsTool(deps.extractRelationships || {}),
    createRecordEvidenceTool(deps.recordEvidence || {}),
    createRecordClaimTool(deps.recordClaim || {}),
    createRecordDiscoveryTool(deps.recordDiscovery || {}),
    createFinishInvestigationTool(deps.finishInvestigation || {}),
  ];
}

function createDefaultToolRegistry(deps = {}) {
  return createToolRegistry(buildDefaultToolCatalogue(deps));
}

module.exports = { buildDefaultToolCatalogue, createDefaultToolRegistry };
