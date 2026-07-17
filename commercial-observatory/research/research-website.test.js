'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('../persistence/fake-client');
const persistence = require('../persistence/db');
const { researchWebsite } = require('./research-website');

const HOMEPAGE_HTML = `
<html><head><title>Compliance Office | Home</title></head>
<body>
  <header><nav>
    <a href="/about">About Us</a>
    <a href="/services">Our Services</a>
    <a href="/team">Our Team</a>
    <a href="/privacy-policy">Privacy Policy</a>
  </nav></header>
  <h1>Compliance Office</h1>
  <p>We are authorised and regulated by the Financial Conduct Authority (FCA).</p>
  <p>We are an official partner of <a href="https://acmecompliance.example/">Acme Compliance Software</a>.</p>
  <footer>Member of the ICAEW.</footer>
</body></html>
`;

const ABOUT_HTML = `
<html><head><title>About | Compliance Office</title></head>
<body>
  <h1>About Compliance Office</h1>
  <p>We are authorised and regulated by the Financial Conduct Authority (FCA).</p>
  <p>We work in partnership with the National Cyber Security Centre (NCSC).</p>
</body></html>
`;

const SERVICES_HTML = `<html><head><title>Services</title></head><body><h1>Our Services</h1><p>Compliance advisory services.</p></body></html>`;
const TEAM_HTML = `<html><head><title>Our Team</title></head><body><h1>Our Team</h1><p>Led by experienced compliance professionals.</p></body></html>`;

function makeFetchUrl(pageMap) {
  return async (url) => {
    const entry = pageMap[url];
    if (!entry) {
      return { success: false, requestedUrl: url, errorType: 'http_error', status: 404, error: 'Not Found', retryable: false };
    }
    return {
      success: true, requestedUrl: url, finalUrl: url, status: 200,
      contentType: 'text/html', body: entry, retrievedAt: '2026-07-14T12:00:00.000Z', headers: {},
    };
  };
}

async function setupInvestigation(client, { name = 'Compliance Office', domain = 'example.com' } = {}) {
  const created = await persistence.createInvestigation({ name, domain, normalisedDomain: domain }, { client });
  await persistence.createInitialDossier(created.investigation.id, { name, domain }, { client });
  return created.investigation.id;
}

describe('researchWebsite — complete deterministic run with mocked pages', () => {
  test('fetches homepage + selected pages, records evidence, relationships and discoveries, updates dossier, completes', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client);

    const fetchUrl = makeFetchUrl({
      'https://example.com/': HOMEPAGE_HTML,
      'https://example.com/about': ABOUT_HTML,
      'https://example.com/services': SERVICES_HTML,
      'https://example.com/team': TEAM_HTML,
    });

    const result = await researchWebsite(investigationId, { client, fetchUrl });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.failures.length, 0);

    // Homepage + 3 selected pages visited; privacy-policy rejected.
    assert.strictEqual(result.pagesVisited.length, 4);
    assert.ok(result.pagesRejected.some((r) => r.url.endsWith('/privacy-policy')));

    // Evidence: one per fetched page.
    assert.strictEqual(result.evidenceCreated, 4);

    // FCA relationship observed and corroborated across homepage + about page (2 evidence refs).
    const fca = result.relationshipObservationsCreated.find((r) => r.thirdPartyName.includes('FCA') || r.thirdPartyName.includes('Financial Conduct Authority'));
    assert.ok(fca);
    assert.strictEqual(fca.relationshipType, 'regulator');
    assert.strictEqual(fca.evidenceReferences.length, 2);
    assert.strictEqual(fca.relationshipConfidenceState, 'verified'); // "authorised and regulated by" is verified from the first mention already

    // NCSC partnership observed from the about page.
    const ncsc = result.relationshipObservationsCreated.find((r) => r.thirdPartyName.includes('NCSC') || r.thirdPartyName.includes('National Cyber Security Centre'));
    assert.ok(ncsc);
    assert.strictEqual(ncsc.relationshipType, 'strategic_partner');

    // Acme (linked, phrase-backed) also observed.
    const acme = result.relationshipObservationsCreated.find((r) => r.thirdPartyName.includes('Acme'));
    assert.ok(acme);

    // The investigation bundle reflects everything persisted.
    const bundleResult = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundleResult.bundle.investigation.status, 'completed');
    assert.ok(bundleResult.bundle.evidence.length >= 4);
    assert.ok(bundleResult.bundle.dossier.workingState.pagesVisited.length >= 4);
    assert.ok(bundleResult.bundle.dossier.version > 1);
  });
});

describe('researchWebsite — total homepage failure', () => {
  test('marks the investigation failed, preserves the structured failure, never fabricates evidence', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'unreachable.invalid' });

    const fetchUrl = async () => ({ success: false, requestedUrl: 'x', errorType: 'connection_error', error: 'ECONNREFUSED', retryable: true });

    const result = await researchWebsite(investigationId, { client, fetchUrl });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.evidenceCreated, 0);

    const bundleResult = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundleResult.bundle.investigation.status, 'failed');
    assert.strictEqual(bundleResult.bundle.evidence.length, 0);
    // Existing dossier state (created at setup) is untouched, not erased.
    assert.deepStrictEqual(bundleResult.bundle.dossier.workingState.pagesVisited, []);
  });
});

describe('researchWebsite — partial page failure', () => {
  test('continues past one failed secondary page and finishes partial, not failed', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'partial-example.com' });

    const fetchUrl = makeFetchUrl({
      'https://partial-example.com/': HOMEPAGE_HTML.replace(/example\.com/g, 'partial-example.com'),
      // /services deliberately omitted -> 404
      'https://partial-example.com/about': ABOUT_HTML,
      'https://partial-example.com/team': TEAM_HTML,
    });

    const result = await researchWebsite(investigationId, { client, fetchUrl });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'partial');
    assert.ok(result.failures.some((f) => f.stage === 'fetch'));
    // Homepage + about + team fetched; services failed but did not stop the run.
    assert.strictEqual(result.pagesVisited.length, 3);
    assert.ok(result.pagesRejected.some((r) => r.reason.startsWith('fetch_failed:')));
  });
});

describe('researchWebsite — rerun duplicate-evidence handling', () => {
  test('rerunning the same investigation with identical pages creates no duplicate evidence, and never deletes prior evidence', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'rerun-example.com' });

    const fetchUrl = makeFetchUrl({
      'https://rerun-example.com/': HOMEPAGE_HTML.replace(/example\.com/g, 'rerun-example.com'),
      'https://rerun-example.com/about': ABOUT_HTML,
      'https://rerun-example.com/services': SERVICES_HTML,
      'https://rerun-example.com/team': TEAM_HTML,
    });

    const first = await researchWebsite(investigationId, { client, fetchUrl });
    assert.strictEqual(first.evidenceCreated, 4);

    const second = await researchWebsite(investigationId, { client, fetchUrl });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.evidenceCreated, 0); // identical content — nothing new to persist

    const bundleResult = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundleResult.bundle.evidence.length, 4); // not duplicated, not deleted
  });

  test('rerunning does not duplicate discoveries or relationship observations (the real-world bug this fix addresses)', async () => {
    const client = createFakeClient();
    const investigationId = await setupInvestigation(client, { domain: 'rerun2-example.com' });

    const homepageWithDiscovery = HOMEPAGE_HTML.replace(/example\.com/g, 'rerun2-example.com').replace(
      '<footer>Member of the ICAEW.</footer>',
      '<footer>Member of the ICAEW. See our <a href="https://otherfirm.example/case-studies">case studies</a> for details.</footer>',
    );

    const fetchUrl = makeFetchUrl({
      'https://rerun2-example.com/': homepageWithDiscovery,
      'https://rerun2-example.com/about': ABOUT_HTML,
      'https://rerun2-example.com/services': SERVICES_HTML,
      'https://rerun2-example.com/team': TEAM_HTML,
    });

    const first = await researchWebsite(investigationId, { client, fetchUrl });
    assert.ok(first.discoveriesCreated.length > 0);
    assert.ok(first.relationshipObservationsCreated.length > 0);

    const second = await researchWebsite(investigationId, { client, fetchUrl });
    assert.strictEqual(second.discoveriesCreated.length, 0);
    assert.strictEqual(second.relationshipObservationsCreated.length, 0);

    const bundleResult = await persistence.getInvestigationBundle(investigationId, { client });
    assert.strictEqual(bundleResult.bundle.discoveries.length, first.discoveriesCreated.length);
    assert.strictEqual(bundleResult.bundle.relationshipObservations.length, first.relationshipObservationsCreated.length);
  });
});

describe('researchWebsite — setup failures', () => {
  test('a missing investigation id returns a structured failure', async () => {
    const client = createFakeClient();
    const result = await researchWebsite('does-not-exist', { client });
    assert.strictEqual(result.success, false);
  });

  test('an investigation with no target domain fails honestly, without touching the dossier', async () => {
    const client = createFakeClient();
    const created = await persistence.createInvestigation({ name: 'No Domain Ltd' }, { client });
    await persistence.createInitialDossier(created.investigation.id, { name: 'No Domain Ltd' }, { client });

    const result = await researchWebsite(created.investigation.id, { client });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /target domain/i);
  });
});
