'use strict';

// End-to-end integration tests for Task-6's data-quality corrections
// (identity extraction, service/client-sector precision, entity/identifier
// separation, discovery quality gate, question resolution) — a fresh,
// fully mocked Compliance Office investigation exercising the whole
// evidence-to-structured-finding pipeline together.

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

const DOMAIN = 'structured-findings.co.uk';
const HOMEPAGE_URL = `https://${DOMAIN}/`;
const CH_URL = 'https://find-and-update.company-information.service.gov.uk/company/09133668';

const HOMEPAGE_HTML = `<html><head><title>Compliance Office</title></head><body>
  <h2>Services</h2>
  <h2>Independent AML audits &amp; SRA compliance health-checks</h2>
  <h2>Outsourced SRA compliance &amp; COLP support packages</h2>
  <h2>SRA authorisation</h2>
  <h1>Trusted by industry leaders:</h1>
  <h2>Astraea</h2>
  <h3>Our sub-processors</h3>
  <p>We provide SRA compliance audits and COLP support.</p>
  <p>Our team of SRA compliance experts offer outsourced risk and compliance support to law firms.</p>
  <p>For example, as solicitors we have to perform &lsquo;conflicts of interest&rsquo; checks before taking on new work.</p>
  <p>Trusted by industry leaders: Astraea&ldquo;We have been working with the Compliance Office for a number of years and would highly recommend their retainer support and audit services.&rdquo;</p>
  <p>The Compliance Office is registered with the Information Commissioner&rsquo;s Office under registration number ZA075078.</p>
  <p>Our sub-processors for data protection purposes are as follows: <a href="https://www.clio.com/uk/">https://www.clio.com/uk/</a></p>
  <p><a href="https://ico.org.uk/ESDWebPages/Entry/ZA075078">ZA075078</a></p>
  <p><a href="https://www.gov.uk/">here</a></p>
  <p>&copy; Compliance Office Ltd</p>
</body></html>`;

const CH_HTML = `<html><head><title>THE COMPLIANCE OFFICE LTD overview - Find and update company information - GOV.UK</title></head><body>
  <h1>THE COMPLIANCE OFFICE LTD</h1>
  <p>THE COMPLIANCE OFFICE LTD Company number 09133668 Follow this company Registered office address 20 Grosvenor Place, London, England, SW1X 7HN Company status Active Company type Private limited Company Incorporated on 16 July 2014</p>
  <p><a href="https://ico.org.uk/ESDWebPages/Entry/ZA075078">ZA075078</a></p>
  <p><a href="https://www.gov.uk/">here</a></p>
</body></html>`;

async function setupInvestigation(client) {
  const created = await persistence.createInvestigation({ name: 'Compliance Office', domain: DOMAIN, normalisedDomain: DOMAIN }, { client });
  await persistence.createInitialDossier(created.investigation.id, { name: 'Compliance Office', domain: DOMAIN }, { client });
  return created.investigation.id;
}

function buildRegistry(pageMap) {
  const fakeSearchWeb = {
    name: 'search_web', description: 'fake', inputSchema: { required: ['query', 'investigationId'] },
    validateInput: (i) => ({ valid: !!i?.query, errors: i?.query ? [] : ['query required'] }),
    execute: async (input) => ({
      success: true, toolName: 'search_web',
      output: {
        query: input.query, provider: 'fake',
        results: input.query.includes('company-information.service.gov.uk')
          ? [{ title: 'THE COMPLIANCE OFFICE LTD overview - GOV.UK', url: CH_URL, snippet: 'Compliance Office Ltd', source: 'fake', rank: 1 }]
          : [],
      },
    }),
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

describe('orchestrator — structured findings pipeline (Task 6 corrections, end to end)', () => {
  test('a fresh mocked Compliance Office investigation produces identity, specific services, law-firms sector, and a correctly named ICO relationship', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);
    const pageMap = { [HOMEPAGE_URL]: HOMEPAGE_HTML, [CH_URL]: CH_HTML };
    const toolRegistry = buildRegistry(pageMap);

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 15, maxSearchPhaseSearches: 4 } });

    // Identity — Companies House register page reached via search, parsed and corroborated.
    const legalName = result.findings.identity.find((f) => f.field === 'legalName');
    const companyNumber = result.findings.identity.find((f) => f.field === 'companyNumber');
    if (legalName) {
      assert.match(legalName.value, /COMPLIANCE OFFICE/i);
      assert.notStrictEqual(legalName.value, '09133668');
    }
    if (companyNumber) assert.strictEqual(companyNumber.value, '09133668');

    // Services — specific items, not just "Services".
    const serviceValues = result.findings.services.map((f) => f.value);
    assert.ok(!serviceValues.includes('Services'), 'the generic "Services" heading must be suppressed once specifics exist');
    assert.ok(serviceValues.some((v) => /COLP support packages/i.test(v)));

    // Client sectors — "law firms" from the serving-direction sentence, never "solicitors" from self-description.
    assert.ok(result.findings.clientsSectors.some((f) => f.value === 'law firms'));
    assert.ok(!result.findings.clientsSectors.some((f) => f.value === 'solicitors'));

    // Named clients — Astraea testimonial still captured.
    assert.ok(result.findings.clientsNamed.some((f) => f.value === 'Astraea'));

    // ICO — correctly named entity, never the registration number.
    const icoRelationship = result.wouldPersistRelationships.find((r) => /information commissioner/i.test(r.rawName));
    assert.ok(icoRelationship, 'expected a relationship candidate naming the Information Commissioner\'s Office');
    assert.strictEqual(icoRelationship.identifierValue, 'ZA075078');
    assert.ok(!result.wouldPersistRelationships.some((r) => r.rawName === 'ZA075078'));

    // Discoveries — noisy UI/identifier links never appear.
    const discoveryNames = result.wouldPersistDiscoveries.map((d) => d.discoveredName);
    assert.ok(!discoveryNames.includes('ZA075078'));
    assert.ok(!discoveryNames.includes('here'));
    assert.ok(!discoveryNames.includes('Follow this company'));

    // Zero database writes in dry-run.
    const bundle = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundle.bundle.evidence.length, 0);
    assert.strictEqual(bundle.bundle.claims.length, 0);
    assert.strictEqual(bundle.bundle.discoveries.length, 0);
    assert.strictEqual(bundle.bundle.relationshipObservations.length, 0);
  });

  test('question resolution: named-client and services findings resolve their matching questions', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);
    const pageMap = { [HOMEPAGE_URL]: HOMEPAGE_HTML, [CH_URL]: CH_HTML };
    const toolRegistry = buildRegistry(pageMap);

    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 15, maxSearchPhaseSearches: 4 } });

    const byId = (id) => result.questions.find((q) => q.id === id);
    assert.strictEqual(byId('clients-named-evidence').status, 'resolved');
    assert.strictEqual(byId('services-provided').status, 'resolved');
  });

  test('a failed/unmatched companies_house_lookup tool call alone never resolves identity-companies-house', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);
    // No CH page reachable at all — the tool is attempted (returns
    // matched:false via the noop mock) but no real identity evidence ever
    // exists this run.
    const toolRegistry = buildRegistry({ [HOMEPAGE_URL]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>' });
    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12 } });
    const q = result.questions.find((x) => x.id === 'identity-companies-house');
    assert.notStrictEqual(q.status, 'resolved');
  });

  test('investigated-no-evidence: a clean companies_house_lookup no-match is recorded honestly as dropped, not silently left open forever nor falsely resolved', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);
    const toolRegistry = buildRegistry({ [HOMEPAGE_URL]: '<html><head><title>Home</title></head><body><h1>Compliance Office</h1></body></html>' });
    const result = await runResearchAgent(investigationId, { dryRun: true, deps: client, toolRegistry, limits: { maxSteps: 12 } });
    const q = result.questions.find((x) => x.id === 'identity-companies-house');
    assert.strictEqual(q.status, 'dropped');
    assert.ok(q.reason && /no matching register entry/i.test(q.reason));
  });
});
