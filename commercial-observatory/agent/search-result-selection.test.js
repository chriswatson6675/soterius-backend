'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { selectSearchResults } = require('./search-result-selection');

const OPTS = { targetName: 'Compliance Office', targetDomain: 'complianceoffice.co.uk' };

describe('selectSearchResults', () => {
  test('selects the official target page with the highest score', () => {
    const results = [
      { title: 'Compliance Office | Home', url: 'https://complianceoffice.co.uk/', snippet: 'Compliance consultancy' },
      { title: 'Some unrelated blog', url: 'https://randomblog.example/post', snippet: 'nothing relevant' },
    ];
    const { selected, rejected } = selectSearchResults(results, { ...OPTS, maxSelected: 2 });
    assert.strictEqual(selected[0].url, 'https://complianceoffice.co.uk/');
    assert.strictEqual(selected[0].category, 'first_party');
    assert.ok(rejected.some((r) => r.url === 'https://randomblog.example/post'));
  });

  test('selects a regulator/register page', () => {
    const results = [{ title: 'Compliance Office - Companies House', url: 'https://find-and-update.company-information.service.gov.uk/company/123', snippet: 'Compliance Office Ltd' }];
    const { selected } = selectSearchResults(results, OPTS);
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0].category, 'register');
  });

  test('rejects an unrelated similarly-named firm with no relevance signal', () => {
    const results = [{ title: 'Office Supplies Direct', url: 'https://officesupplies.example/', snippet: 'Buy office chairs and desks' }];
    const { rejected } = selectSearchResults(results, OPTS);
    assert.strictEqual(rejected[0].reason, 'low_relevance');
  });

  test('rejects a duplicate URL/domain within one result set (diversity preserved)', () => {
    const results = [
      { title: 'Compliance Office', url: 'https://complianceoffice.co.uk/', snippet: 'x' },
      { title: 'Compliance Office About', url: 'https://complianceoffice.co.uk/about', snippet: 'y' },
    ];
    const { selected, rejected } = selectSearchResults(results, OPTS);
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(rejected[0].reason, 'duplicate_domain_in_result_set');
  });

  test('rejects a low-quality aggregator domain', () => {
    const results = [{ title: 'Compliance Office reviews', url: 'https://yell.com/biz/compliance-office', snippet: 'Compliance Office reviews and ratings' }];
    const { rejected } = selectSearchResults(results, OPTS);
    assert.strictEqual(rejected[0].reason, 'low_quality_aggregator');
  });

  test('rejects a login page', () => {
    const results = [{ title: 'Login', url: 'https://someportal.example/login', snippet: 'Compliance Office client login' }];
    const { rejected } = selectSearchResults(results, OPTS);
    assert.strictEqual(rejected[0].reason, 'login_page');
  });

  test('rejects a social-media result', () => {
    const results = [{ title: 'Compliance Office on LinkedIn', url: 'https://linkedin.com/company/compliance-office', snippet: 'Compliance Office' }];
    const { rejected } = selectSearchResults(results, OPTS);
    assert.strictEqual(rejected[0].reason, 'social_platform');
  });

  test('rejects a third-party URL already fetched this run', () => {
    const results = [{ title: 'Compliance Office mentioned on Acme Consultants', url: 'https://acme-consultants.example/', snippet: 'Compliance Office' }];
    const { rejected } = selectSearchResults(results, { ...OPTS, alreadyFetchedCanonicalUrls: new Set(['https://acme-consultants.example']) });
    assert.strictEqual(rejected[0].reason, 'url_already_fetched');
  });

  test('the target\'s own homepage is exempt from re-selection, but a genuinely new subpage on the SAME domain is still selected', () => {
    const results = [{ title: 'Compliance Office Services', url: 'https://complianceoffice.co.uk/services', snippet: 'Compliance Office services' }];
    const { selected } = selectSearchResults(results, { ...OPTS, alreadyFetchedCanonicalUrls: new Set(['https://complianceoffice.co.uk']) });
    assert.strictEqual(selected.length, 1);
  });

  test('a third-party domain already fetched at a DIFFERENT path is not rejected — only the exact already-fetched URL is (Part 4 precision)', () => {
    const results = [{ title: 'Compliance Office Ltd officers', url: 'https://find-and-update.company-information.service.gov.uk/company/09133668/officers', snippet: 'Compliance Office Ltd' }];
    const { selected } = selectSearchResults(results, { ...OPTS, alreadyFetchedCanonicalUrls: new Set(['https://find-and-update.company-information.service.gov.uk/company/09133668']) });
    assert.strictEqual(selected.length, 1);
  });

  test('a selected/rejected result never itself carries an evidence id — it is never itself evidence', () => {
    const results = [{ title: 'Compliance Office', url: 'https://complianceoffice.co.uk/', snippet: 'x' }];
    const { selected } = selectSearchResults(results, OPTS);
    assert.strictEqual(selected[0].evidenceId, undefined);
    assert.strictEqual(selected[0].persisted, undefined);
  });

  test('bounds the number selected via maxSelected, rejecting overflow with a clear reason', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ title: `Compliance Office page ${i}`, url: `https://complianceoffice.co.uk/page-${i}`, snippet: 'Compliance Office' }));
    // each has a distinct path but SAME domain, so only the first is kept as diverse; to exercise maxSelected specifically use distinct domains
    const distinctDomainResults = Array.from({ length: 5 }, (_, i) => ({ title: `Compliance Office mentioned`, url: `https://site${i}.example/`, snippet: 'Compliance Office' }));
    const { selected, rejected } = selectSearchResults(distinctDomainResults, { ...OPTS, maxSelected: 2 });
    assert.strictEqual(selected.length, 2);
    assert.ok(rejected.some((r) => r.reason === 'exceeded_max_selected'));
  });
});
