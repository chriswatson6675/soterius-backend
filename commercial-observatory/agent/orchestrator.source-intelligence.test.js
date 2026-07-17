'use strict';

// Integration tests for the Source Intelligence gate wired into the
// orchestrator: a candidate URL (search result or co-party hyperlink) must
// be assessed BEFORE fetch_web_page is ever scheduled for it, and a
// low-quality/irrelevant source must never consume a fetch.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('../persistence/fake-client');
const persistence = require('../persistence/db');
const { runResearchAgent } = require('./orchestrator');
const { createToolRegistry } = require('./tools/registry');
const { extractHtml } = require('../sources/html-extract');
const { createExtractEntitiesTool } = require('./tools/extract-entities');
const { createExtractRelationshipsTool } = require('./tools/extract-relationships');
const { createRecordEvidenceTool } = require('./tools/record-evidence');
const { createRecordClaimTool } = require('./tools/record-claim');
const { createRecordDiscoveryTool } = require('./tools/record-discovery');
const { createFinishInvestigationTool } = require('./tools/finish-investigation');
const { createInspectTargetWebsiteTool } = require('./tools/inspect-target-website');
const { createReadPdfTool } = require('./tools/read-pdf');

async function setupInvestigation(client, domain) {
  const created = await persistence.createInvestigation({ name: 'Compliance Office', domain, normalisedDomain: domain }, { client });
  await persistence.createInitialDossier(created.investigation.id, { name: 'Compliance Office', domain }, { client });
  return created.investigation.id;
}

function buildRegistry({ pageMap, searchResults }) {
  const fakeSearchWeb = {
    name: 'search_web', description: 'fake', inputSchema: { required: ['query', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.query, errors: i?.query ? [] : ['query required'] }),
    execute: async (input) => ({ success: true, toolName: 'search_web', output: { query: input.query, results: searchResults || [], provider: 'fake' } }),
  };
  const fakeFetchWebPage = {
    name: 'fetch_web_page', description: 'fake', inputSchema: { required: ['url', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.url, errors: i?.url ? [] : ['url required'] }),
    execute: async (input) => {
      const html = pageMap[input.url];
      if (!html) return { success: false, toolName: 'fetch_web_page', errorType: 'connection_error', error: 'no fixture for url', retryable: false };
      const extracted = extractHtml(html, input.url);
      return { success: true, toolName: 'fetch_web_page', output: { finalUrl: input.url, title: extracted.title, visibleText: extracted.visibleText, headings: extracted.headings, internalLinks: extracted.internalLinks, externalLinks: extracted.externalLinks, jsonLd: extracted.jsonLd, footerText: extracted.footerText, rawBody: html, retrievedAt: '2026-07-15T00:00:00.000Z' } };
    },
  };
  const noopMatch = (name) => ({
    name, description: 'fake', inputSchema: { required: ['investigationId'] }, validateInput: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, toolName: name, output: { matched: false, matchBasis: 'no_result', candidates: [] } }),
  });

  return createToolRegistry([
    fakeSearchWeb, fakeFetchWebPage, noopMatch('companies_house_lookup'), noopMatch('fca_lookup'), noopMatch('sra_lookup'),
    createReadPdfTool({}), createInspectTargetWebsiteTool({ researchWebsite: async () => ({ success: true }) }),
    createExtractEntitiesTool(), createExtractRelationshipsTool(),
    createRecordEvidenceTool(), createRecordClaimTool(), createRecordDiscoveryTool(), createFinishInvestigationTool(),
  ]);
}

describe('orchestrator — Source Intelligence gates search results before fetch_web_page', () => {
  test('an irrelevant generic-reference result (shares vocabulary, not the organisation) is never fetched', async () => {
    const client = createFakeClient();
    const domain = 'source-intel-search.co.uk';
    const investigationId = await setupInvestigation(client, domain);

    const relevantUrl = `https://${domain}/services`;
    const irrelevantUrl = 'https://www.bls.gov/ooh/business-and-financial/compliance-officers.htm';
    const pageMap = {
      [`https://${domain}/`]: `<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>`,
      [relevantUrl]: `<html><head><title>Compliance Office — Services</title></head><body><h1>Our Services</h1><p>We provide COLP and COFA support.</p></body></html>`,
      [irrelevantUrl]: `<html><head><title>irrelevant</title></head><body>should never be fetched</body></html>`,
    };
    const searchResults = [
      { title: 'Compliance Office — Services', url: relevantUrl, snippet: 'Compliance Office services', source: 'fake', rank: 1 },
      { title: 'Compliance Officers : Occupational Outlook Handbook', url: irrelevantUrl, snippet: 'Compliance officers ensure a company complies with regulations.', source: 'fake', rank: 2 },
    ];
    const toolRegistry = buildRegistry({ pageMap, searchResults });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 10 } });

    assert.ok(result.externalSourcesFetched.some((s) => s.url === relevantUrl));
    assert.ok(!result.externalSourcesFetched.some((s) => s.url === irrelevantUrl));
    assert.ok(result.sourcesSkippedBySourceIntelligence.some((s) => s.url === irrelevantUrl && s.context === 'search_result'));
    assert.ok(!result.toolCallLog.some((c) => c.toolName === 'fetch_web_page' && c.toolInput.url === irrelevantUrl));
  });
});

describe('orchestrator — Source Intelligence gates co-party candidates before follow-up', () => {
  test('a generic-reference co-party candidate is never queued for follow-up; a regulator candidate still is', async () => {
    const client = createFakeClient();
    const domain = 'source-intel-coparty.co.uk';
    const investigationId = await setupInvestigation(client, domain);

    const homepage = `<html><head><title>Compliance Office</title></head><body>
      <h1>Compliance Office</h1>
      <p>See <a href="https://onetonline.org/link/summary/13-1041.00">occupational data</a> and <a href="https://www.sra.org.uk/guidance">SRA guidance</a>.</p>
    </body></html>`;
    const pageMap = {
      [`https://${domain}/`]: homepage,
      'https://onetonline.org/': `<html><head><title>O*NET</title></head><body>should never be fetched as a co-party</body></html>`,
      'https://www.sra.org.uk/': `<html><head><title>SRA</title></head><body>Solicitors Regulation Authority</body></html>`,
    };
    const toolRegistry = buildRegistry({ pageMap, searchResults: [] });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12 } });

    assert.ok(!result.coPartiesInvestigated.some((n) => /onetonline/i.test(n)) || !result.externalSourcesFetched.some((s) => /onetonline\.org/.test(s.url)));
    assert.ok(!result.externalSourcesFetched.some((s) => /onetonline\.org/.test(s.url)));
    assert.ok(result.sourcesSkippedBySourceIntelligence.some((s) => s.url === 'https://onetonline.org/' && s.context === 'co_party_candidate'));
  });
});
