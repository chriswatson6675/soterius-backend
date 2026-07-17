'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('../persistence/fake-client');
const persistence = require('../persistence/db');
const { runResearchAgent } = require('./orchestrator');
const { createToolRegistry } = require('./tools/registry');
const { createExtractEntitiesTool } = require('./tools/extract-entities');
const { createExtractRelationshipsTool } = require('./tools/extract-relationships');
const { createRecordEvidenceTool } = require('./tools/record-evidence');
const { createRecordClaimTool } = require('./tools/record-claim');
const { createRecordDiscoveryTool } = require('./tools/record-discovery');
const { createFinishInvestigationTool } = require('./tools/finish-investigation');
const { createInspectTargetWebsiteTool } = require('./tools/inspect-target-website');

const HOMEPAGE_HTML = `<html><head><title>Compliance Office</title></head><body>
  <h1>Compliance Office</h1>
  <p>We are authorised and regulated by the Financial Conduct Authority (FCA).</p>
  <a href="https://acmecompliance.example/">Acme Compliance Software</a>
</body></html>`;

function buildFakeToolRegistry({ companiesHouseMatch = true, fetchFails = false } = {}) {
  const fakeSearchWeb = {
    name: 'search_web', description: 'fake', inputSchema: { required: ['query', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.query, errors: i?.query ? [] : ['query required'] }),
    execute: async (input) => ({ success: true, toolName: 'search_web', output: { query: input.query, results: [{ title: 'r', url: 'https://example.com', snippet: 's', source: 'x', rank: 1 }] } }),
  };
  const fakeFetchWebPage = {
    name: 'fetch_web_page', description: 'fake', inputSchema: { required: ['url', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.url, errors: i?.url ? [] : ['url required'] }),
    execute: async (input) => {
      if (fetchFails) return { success: false, toolName: 'fetch_web_page', errorType: 'connection_error', error: 'refused', retryable: true };
      const { extractHtml } = require('../sources/html-extract');
      const extracted = extractHtml(HOMEPAGE_HTML, input.url);
      return { success: true, toolName: 'fetch_web_page', output: { finalUrl: input.url, title: extracted.title, visibleText: extracted.visibleText, headings: extracted.headings, internalLinks: extracted.internalLinks, externalLinks: extracted.externalLinks, jsonLd: extracted.jsonLd, footerText: extracted.footerText, rawBody: HOMEPAGE_HTML, retrievedAt: '2026-07-15T00:00:00.000Z' } };
    },
  };
  const fakeCompaniesHouseLookup = {
    name: 'companies_house_lookup', description: 'fake', inputSchema: { required: ['investigationId'] },
    validateInput: () => ({ valid: true, errors: [] }),
    execute: async () => (companiesHouseMatch
      ? { success: true, toolName: 'companies_house_lookup', output: { matched: true, matchConfidence: 'high', matchBasis: 'exact_name_match', company: { companyNumber: '12345678', name: 'Compliance Office Ltd', status: 'active' } } }
      : { success: true, toolName: 'companies_house_lookup', output: { matched: false, matchBasis: 'no_result', candidates: [] } }),
  };
  const fakeFcaLookup = {
    name: 'fca_lookup', description: 'fake', inputSchema: { required: ['investigationId'] },
    validateInput: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, toolName: 'fca_lookup', output: { matched: false, matchBasis: 'no_result', candidates: [] } }),
  };
  const fakeSraLookup = {
    name: 'sra_lookup', description: 'fake', inputSchema: { required: ['investigationId'] },
    validateInput: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, toolName: 'sra_lookup', output: { matched: false, matchBasis: 'no_result', candidates: [] } }),
  };
  const fakeReadPdf = {
    name: 'read_pdf', description: 'fake', inputSchema: { required: ['url', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.url, errors: [] }),
    execute: async () => ({ success: false, toolName: 'read_pdf', errorType: 'not_pdf', error: 'no pdf', retryable: false }),
  };

  return createToolRegistry([
    fakeSearchWeb, fakeFetchWebPage, fakeCompaniesHouseLookup, fakeFcaLookup, fakeSraLookup, fakeReadPdf,
    createInspectTargetWebsiteTool({ researchWebsite: async () => ({ success: true }) }),
    createExtractEntitiesTool(), createExtractRelationshipsTool(),
    createRecordEvidenceTool(), createRecordClaimTool(), createRecordDiscoveryTool(), createFinishInvestigationTool(),
  ]);
}

async function setupInvestigation(client, { domain = 'complianceoffice-agent.co.uk', name = 'Compliance Office' } = {}) {
  const created = await persistence.createInvestigation({ name, domain, normalisedDomain: domain }, { client });
  await persistence.createInitialDossier(created.investigation.id, { name, domain }, { client });
  return created.investigation.id;
}

describe('orchestrator — dryRun is required and explicit', () => {
  test('throws if dryRun is not an explicit boolean', async () => {
    await assert.rejects(() => runResearchAgent('inv-1', {}));
  });
});

describe('orchestrator — full mocked multi-step investigation (search -> fetch -> evidence -> claim -> relationship)', () => {
  test('live mode persists validated evidence, claims and relationship observations', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);
    const toolRegistry = buildFakeToolRegistry();

    const result = await runResearchAgent(investigationId, { dryRun: false, deps: client, toolRegistry, limits: { maxSteps: 6 } });

    assert.strictEqual(result.success, true);
    assert.ok(result.toolCallLog.some((c) => c.toolName === 'companies_house_lookup'));
    assert.ok(result.toolCallLog.some((c) => c.toolName === 'fetch_web_page'));

    const bundle = (await persistence.getInvestigationBundle(investigationId, { client })).bundle;
    assert.ok(bundle.evidence.length >= 1);
    assert.ok(bundle.claims.length >= 1);
    assert.ok(bundle.relationshipObservations.some((r) => r.thirdPartyName.includes('Financial Conduct') || r.thirdPartyName.includes('FCA')));
    assert.strictEqual(bundle.draft.reviewState, 'pending'); // pending draft, never approved — no canonical admission
  });
});

describe('orchestrator — dry-run performs zero database writes', () => {
  test('reports would-persist findings but writes nothing', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'dryrun-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry();

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 6 } });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.ok(result.wouldPersistEvidence.length >= 1);

    const bundle = (await persistence.getInvestigationBundle(investigationId, { client })).bundle;
    assert.strictEqual(bundle.evidence.length, 0);
    assert.strictEqual(bundle.claims.length, 0);
    assert.strictEqual(bundle.relationshipObservations.length, 0);
    assert.strictEqual(bundle.discoveries.length, 0);
    assert.strictEqual(bundle.draft, null);
    assert.strictEqual(bundle.agentEvents.length, 0);
    assert.strictEqual(bundle.investigation.status, 'pending'); // untouched
  });
});

describe('orchestrator — tool failure continuation', () => {
  test('a failed fetch does not crash the loop; the investigation still finishes', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'failure-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry({ fetchFails: true });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 6 } });
    assert.strictEqual(result.success, true);
    assert.ok(result.toolCallLog.some((c) => c.toolName === 'fetch_web_page' && c.success === false));
  });
});

describe('orchestrator — maximum-step stop', () => {
  test('stops at maxSteps even if questions remain open', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'maxsteps-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry({ companiesHouseMatch: false });

    // A planner that always proposes a fresh, never-repeating search — proves the step limit, not the repeat limit, is what stops it.
    let counter = 0;
    const decidePlannerAction = async () => { counter += 1; return { action: 'use_tool', toolName: 'search_web', toolInput: { query: `q${counter}`, investigationId }, questionId: null, reason: 'x', expectedInformationGain: 'low' }; };

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, decidePlannerAction, limits: { maxSteps: 3, maxSearches: 100 } });
    assert.strictEqual(result.stopReason, 'limit_reached:maxSteps');
    assert.strictEqual(result.usage.steps, 3);
  });
});

describe('orchestrator — repeated-action stop', () => {
  test('stops when the same action repeats past the configured limit', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'repeat-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry({ companiesHouseMatch: false });

    const decidePlannerAction = async () => ({ action: 'use_tool', toolName: 'search_web', toolInput: { query: 'same query every time', investigationId }, questionId: null, reason: 'x', expectedInformationGain: 'low' });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, decidePlannerAction, limits: { maxSteps: 100, maxSearches: 100, maxRepeatedActions: 2 } });
    assert.strictEqual(result.stopReason, 'limit_reached:maxRepeatedActions');
  });
});

describe('orchestrator — pending draft, no canonical admission', () => {
  test('produces a pending draft in live mode; approving/admitting is never performed by the agent', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'draft-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry();

    const result = await runResearchAgent(investigationId, { dryRun: false, deps: client, toolRegistry, limits: { maxSteps: 6 } });
    assert.ok(result.draft);
    assert.strictEqual(result.draft.draft.reviewState, 'pending');
  });
});

describe('orchestrator — invented tool name is rejected, not executed', () => {
  test('a planner proposing an unregistered tool halts safely rather than executing it', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'invented-tool-agent.co.uk' });
    const toolRegistry = buildFakeToolRegistry({ companiesHouseMatch: false });
    const decidePlannerAction = async () => ({ action: 'use_tool', toolName: 'browse_anything_unrestricted', toolInput: {}, questionId: null, reason: 'x' });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, decidePlannerAction, limits: { maxSteps: 5 } });
    assert.strictEqual(result.stopReason, 'fatal_tool_failure');
  });
});
