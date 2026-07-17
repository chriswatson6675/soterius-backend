'use strict';

// Tests for this task's specific improvements: canonical co-party dedup
// (no more duplicate follow-up / repeated-action stop for the same
// resolved domain under different labels) and the full
// search -> select -> fetch -> extract -> proposed-finding pipeline.

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

// Homepage links to gov.uk under two different (both plausible-entity)
// labels — the exact real dry-run bug this task fixes. Deliberately NOT
// "here"/generic UI text, which the Discovery Quality Gate (a later task)
// now correctly rejects outright — this fixture tests canonical-key
// alias-merging specifically, using two labels that both pass that gate.
const HOMEPAGE_WITH_DUPLICATE_COPARTY_LABELS = `<html><head><title>Compliance Office</title></head><body>
  <h1>Compliance Office</h1>
  <p>We provide SRA compliance audits for law firms.</p>
  <p>See <a href="https://www.gov.uk/guidance-a">GOV.UK Guidance</a> and <a href="https://www.gov.uk/guidance-b">UK Government Guidance</a> for more.</p>
</body></html>`;

const COPARTY_PAGE_HTML = `<html><head><title>GOV.UK</title></head><body><h1>Welcome to GOV.UK</h1></body></html>`;

const SEARCH_RESULT_PAGE_HTML = `<html><head><title>Compliance Office — Services</title></head><body>
  <h1>Our Services</h1>
  <p>We provide COLP and COFA support for regulated law firms.</p>
</body></html>`;

async function setupInvestigation(client, domain) {
  const created = await persistence.createInvestigation({ name: 'Compliance Office', domain, normalisedDomain: domain }, { client });
  await persistence.createInitialDossier(created.investigation.id, { name: 'Compliance Office', domain }, { client });
  return created.investigation.id;
}

function buildRegistry({ pageMap, searchResults }) {
  const fakeSearchWeb = {
    name: 'search_web', description: 'fake', inputSchema: { required: ['query', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.query, errors: i?.query ? [] : ['query required'] }),
    execute: async (input) => ({ success: true, toolName: 'search_web', output: { query: input.query, results: searchResults || [] } }),
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

describe('orchestrator — canonical co-party dedup prevents the repeated-action stop', () => {
  test('two differently-labelled discoveries resolving to the same domain are followed up only once', async () => {
    const client = createFakeClient();
    const domain = 'coparty-dedup.co.uk';
    const investigationId = await setupInvestigation(client, domain);

    const pageMap = {
      [`https://${domain}/`]: HOMEPAGE_WITH_DUPLICATE_COPARTY_LABELS,
      'https://www.gov.uk/guidance-a': COPARTY_PAGE_HTML,
      'https://www.gov.uk/guidance-b': COPARTY_PAGE_HTML,
      'https://www.gov.uk/': COPARTY_PAGE_HTML,
    };
    const toolRegistry = buildRegistry({ pageMap, searchResults: [] });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 10, maxRepeatedActions: 2 } });

    assert.notStrictEqual(result.stopReason, 'limit_reached:maxRepeatedActions');
    // Only one canonical co-party ("gov.uk") should ever be followed up, however many labels discovered it.
    assert.ok(result.coPartiesInvestigated.length <= 1);
    assert.ok(result.coPartyAliasesMerged.some((m) => m.canonicalKey === 'gov.uk' && m.aliases.length >= 1));
  });
});

describe('orchestrator — full search -> selection -> fetch -> extraction -> proposed finding pipeline', () => {
  test('a search result is selected, fetched, and produces a proposed finding, without ever treating the snippet itself as evidence', async () => {
    const client = createFakeClient();
    const domain = 'search-pipeline.co.uk';
    const investigationId = await setupInvestigation(client, domain);

    const searchResultUrl = 'https://search-pipeline.co.uk/services';
    const pageMap = {
      [`https://${domain}/`]: `<html><head><title>Home</title></head><body><h1>Compliance Office</h1><p>Welcome.</p></body></html>`,
      [searchResultUrl]: SEARCH_RESULT_PAGE_HTML,
    };
    const searchResults = [{ title: 'Compliance Office — Services', url: searchResultUrl, snippet: 'COLP and COFA support', source: 'x', rank: 1 }];
    const toolRegistry = buildRegistry({ pageMap, searchResults });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 10 } });

    assert.ok(result.searchQueriesExecuted.length > 0);
    assert.ok(result.searchResultsSelected.some((r) => r.url === searchResultUrl));
    assert.ok(result.externalSourcesFetched.some((s) => s.url === searchResultUrl));
    assert.ok(result.findings.regulatoryExpertise.some((f) => f.sourceUrl === searchResultUrl));
    // The snippet text itself never appears as a sourceUrl/evidence marker — only the fetched page's own content does.
    for (const f of result.findings.regulatoryExpertise) {
      assert.notStrictEqual(f.sourceUrl, undefined);
      assert.ok(f.evidenceId);
    }
  });
});
