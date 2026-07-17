'use strict';

// Integration tests for the pre-execution duplicate-fetch guard (Parts 2-6
// of the repeated-fetch-action fix) — reproduces the real bug (gov.uk and
// resources.companieshouse.gov.uk each fetched twice, tripping
// maxRepeatedActions before the register-lookup phase) and proves it no
// longer happens, while distinct useful pages on the same domain remain
// fetchable.

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

function buildRegistry({ pageMap, searchResults = [], finalUrlOverrides = {} }) {
  const fakeSearchWeb = {
    name: 'search_web', description: 'fake', inputSchema: { required: ['query', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.query, errors: i?.query ? [] : ['query required'] }),
    execute: async (input) => ({ success: true, toolName: 'search_web', output: { query: input.query, results: searchResults, provider: 'fake' } }),
  };
  const fakeFetchWebPage = {
    name: 'fetch_web_page', description: 'fake', inputSchema: { required: ['url', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.url, errors: i?.url ? [] : ['url required'] }),
    execute: async (input) => {
      const html = pageMap[input.url];
      if (!html) return { success: false, toolName: 'fetch_web_page', errorType: 'connection_error', error: 'no fixture for url', retryable: false };
      const finalUrl = finalUrlOverrides[input.url] || input.url;
      const extracted = extractHtml(html, finalUrl);
      return { success: true, toolName: 'fetch_web_page', output: { finalUrl, title: extracted.title, visibleText: extracted.visibleText, headings: extracted.headings, internalLinks: extracted.internalLinks, externalLinks: extracted.externalLinks, jsonLd: extracted.jsonLd, footerText: extracted.footerText, rawBody: html, retrievedAt: '2026-07-16T00:00:00.000Z' } };
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

describe('orchestrator — duplicate-fetch guard: the real co-party root re-fetch bug', () => {
  test('a co-party root page is fetched at most once even though maxCoPartyActionsEach allows two actions on it', async () => {
    const client = createFakeClient();
    const domain = 'dup-coparty.co.uk';
    const investigationId = await setupInvestigation(client, domain);

    // Homepage links to a single co-party root twice under different labels
    // — after canonical co-party merging this is ONE pendingDiscoveries
    // entry, and (per maxCoPartyActionsEach: 2) the orchestrator would
    // previously attempt to fetch its root URL a SECOND time.
    const homepage = `<html><head><title>Compliance Office</title></head><body>
      <h1>Compliance Office</h1>
      <p>See <a href="https://www.gov.uk/guidance-a">GOV.UK Guidance</a> and <a href="https://gov.uk/guidance-b">UK Government Guidance</a> for more.</p>
    </body></html>`;
    const pageMap = {
      [`https://${domain}/`]: homepage,
      'https://www.gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
      'https://gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
    };
    const toolRegistry = buildRegistry({ pageMap });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12, maxRepeatedActions: 2 } });

    assert.notStrictEqual(result.stopReason, 'limit_reached:maxRepeatedActions');
    const govUkFetches = result.toolCallLog.filter((c) => c.toolName === 'fetch_web_page' && /gov\.uk/i.test(c.toolInput.url));
    assert.strictEqual(govUkFetches.length, 1, 'expected gov.uk to be fetched exactly once');
    assert.ok(result.duplicateActionsSkipped.some((d) => /gov\.uk/i.test(d.requestedUrl)));
  });

  test('a duplicate skip does not consume fetch budget or increment repeatedActions', async () => {
    const client = createFakeClient();
    const domain = 'dup-budget.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const homepage = `<html><head><title>Compliance Office</title></head><body>
      <h1>Compliance Office</h1>
      <p>See <a href="https://www.gov.uk/guidance-a">GOV.UK Guidance</a> and <a href="https://gov.uk/guidance-b">UK Government Guidance</a> for more.</p>
    </body></html>`;
    const pageMap = {
      [`https://${domain}/`]: homepage,
      'https://www.gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
      'https://gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
    };
    const toolRegistry = buildRegistry({ pageMap });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12, maxRepeatedActions: 2 } });

    // fetchedPages should reflect only genuine fetches: homepage + gov.uk once.
    assert.strictEqual(result.usage.fetchedPages, 2);
    assert.strictEqual(result.usage.repeatedActions, 0);
  });
});

describe('orchestrator — duplicate-fetch guard: search-driven duplicates', () => {
  test('a search result equivalent to the already-fetched homepage (www variant) is skipped, not re-fetched', async () => {
    const client = createFakeClient();
    const domain = 'dup-search.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const homepageUrl = `https://${domain}/`;
    // The target's own domain is deliberately exempt from
    // search-result-selection.js's coarser "already fetched domain"
    // rejection (so search can surface a genuine new subpage) — which
    // means a www-variant of the homepage ITSELF reaching a search result
    // is exactly the case that needs THIS finer canonical-URL guard, not
    // the pre-existing domain-level one.
    const pageMap = {
      [homepageUrl]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>',
      [`https://www.${domain}/`]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>',
    };
    const searchResults = [{ title: 'Compliance Office', url: `https://www.${domain}/`, snippet: 'Compliance Office', source: 'fake', rank: 1 }];
    const toolRegistry = buildRegistry({ pageMap, searchResults });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12, maxSearchPhaseSearches: 4 } });

    const homepageFetches = result.toolCallLog.filter((c) => c.toolName === 'fetch_web_page' && new URL(c.toolInput.url).hostname.replace(/^www\./, '') === domain);
    assert.strictEqual(homepageFetches.length, 1, 'expected the homepage to be fetched only once despite the www-variant search result');
    // Caught even earlier than the orchestrator's own duplicate guard —
    // selectSearchResults itself now rejects it (Part 4 precision fix),
    // since alreadyFetchedCanonicalUrls recognises the www-variant as the
    // exact same canonical URL as the already-fetched homepage.
    assert.ok(result.searchResultsRejected.some((r) => r.url === `https://www.${domain}/` && r.reason === 'url_already_fetched'));
  });

  test('two distinct paths on the same domain (Companies House overview vs officers) both get fetched — not over-deduplicated', async () => {
    const client = createFakeClient();
    const domain = 'dup-distinct.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const overviewUrl = 'https://find-and-update.company-information.service.gov.uk/company/09133668';
    const officersUrl = 'https://find-and-update.company-information.service.gov.uk/company/09133668/officers';
    const pageMap = {
      [`https://${domain}/`]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>',
      [overviewUrl]: '<html><head><title>THE COMPLIANCE OFFICE LTD overview - Find and update company information - GOV.UK</title></head><body><h1>THE COMPLIANCE OFFICE LTD</h1></body></html>',
      [officersUrl]: '<html><head><title>Officers - GOV.UK</title></head><body><h1>Officers</h1></body></html>',
    };
    // Two SEPARATE search calls (not one result set) — search-result-
    // selection.js's own per-query domain diversity check would otherwise
    // reject a second same-domain result within a single result set
    // regardless of path, which is a different (coarser, pre-existing)
    // mechanism from the canonical-URL dedup this test targets.
    let callCount = 0;
    const toolRegistry = buildRegistry({ pageMap, searchResults: [] });
    toolRegistry.get('search_web').execute = async (input) => {
      callCount += 1;
      const results = callCount === 1
        ? [{ title: 'Compliance Office overview', url: overviewUrl, snippet: 'Compliance Office Ltd', source: 'fake', rank: 1 }]
        : [{ title: 'Compliance Office officers', url: officersUrl, snippet: 'Compliance Office Ltd officers', source: 'fake', rank: 1 }];
      return { success: true, toolName: 'search_web', output: { query: input.query, results, provider: 'fake' } };
    };

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12, maxFetchedPerQuery: 2, maxSearchPhaseSearches: 4 } });

    assert.ok(result.externalSourcesFetched.some((s) => s.url === overviewUrl));
    assert.ok(result.externalSourcesFetched.some((s) => s.url === officersUrl));
  });

  test('a redirect merges two differently-requested URLs onto the same final destination — the second is skipped', async () => {
    const client = createFakeClient();
    const domain = 'dup-redirect.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const finalUrl = 'https://www.gov.uk/canonical-page';
    const pageMap = {
      [`https://${domain}/`]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>',
      'http://gov.uk/old-link': '<html><head><title>Old link</title></head><body>redirected content</body></html>',
      'https://gov.uk/another-link': '<html><head><title>Another link</title></head><body>redirected content</body></html>',
    };
    const searchResults = [
      { title: 'GOV.UK old link', url: 'http://gov.uk/old-link', snippet: 'Compliance Office guidance', source: 'fake', rank: 1 },
      { title: 'GOV.UK another link', url: 'https://gov.uk/another-link', snippet: 'Compliance Office guidance', source: 'fake', rank: 2 },
    ];
    // Both requested URLs redirect to the exact same final destination.
    const finalUrlOverrides = { 'http://gov.uk/old-link': finalUrl, 'https://gov.uk/another-link': finalUrl };
    const toolRegistry = buildRegistry({ pageMap, searchResults, finalUrlOverrides });

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12, maxFetchedPerQuery: 2 } });

    const finalUrlFetches = result.toolCallLog.filter((c) => c.toolName === 'fetch_web_page' && /old-link|another-link/.test(c.toolInput.url));
    assert.strictEqual(finalUrlFetches.length, 1, 'expected only the first requested URL to actually be fetched; the second should be recognised as redirect-equivalent');
  });
});

describe('orchestrator — repeated-action safety net still works for genuine (non-equivalent) repetition', () => {
  test('a planner that genuinely repeats the exact same non-fetch action still trips maxRepeatedActions', async () => {
    const client = createFakeClient();
    const domain = 'dup-genuine-repeat.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const pageMap = { [`https://${domain}/`]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>' };
    const toolRegistry = buildRegistry({ pageMap });

    // A deliberately broken planner that repeats the exact same search
    // query forever — the kind of genuine repetition the safety net exists
    // for, not something the URL-dedup guard is meant to catch (search_web
    // has no equivalent-URL concept).
    const decidePlannerAction = async () => ({
      action: 'use_tool', toolName: 'search_web', questionId: 'services-provided',
      toolInput: { query: 'same query every time', investigationId },
      reason: 'test', expectedInformationGain: 'low',
    });

    const result = await runResearchAgent(investigationId, {
      dryRun: true, deps: client, toolRegistry, decidePlannerAction,
      limits: { maxSteps: 12, maxRepeatedActions: 2 },
    });

    assert.strictEqual(result.stopReason, 'limit_reached:maxRepeatedActions');
  });
});

describe('orchestrator — dry-run zero writes preserved', () => {
  test('the duplicate-guard changes still perform zero database writes in dry-run', async () => {
    const client = createFakeClient();
    const domain = 'dup-zero-writes.co.uk';
    const investigationId = await setupInvestigation(client, domain);
    const homepage = `<html><head><title>Compliance Office</title></head><body>
      <h1>Compliance Office</h1>
      <p>See <a href="https://www.gov.uk/guidance-a">GOV.UK Guidance</a> and <a href="https://gov.uk/guidance-b">UK Government Guidance</a> for more.</p>
    </body></html>`;
    const pageMap = {
      [`https://${domain}/`]: homepage,
      'https://www.gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
      'https://gov.uk/': '<html><head><title>GOV.UK</title></head><body>Welcome</body></html>',
    };
    const toolRegistry = buildRegistry({ pageMap });

    await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12 } });

    const bundle = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundle.bundle.evidence.length, 0);
    assert.strictEqual(bundle.bundle.discoveries.length, 0);
    assert.strictEqual(bundle.bundle.relationshipObservations.length, 0);
    assert.strictEqual(bundle.bundle.claims.length, 0);
  });
});
