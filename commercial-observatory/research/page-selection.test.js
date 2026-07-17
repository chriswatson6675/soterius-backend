'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { selectResearchPages } = require('./page-selection');

const HOMEPAGE = 'https://complianceoffice.co.uk/';

function link(href, text) { return { href, text }; }

describe('selectResearchPages — prioritisation', () => {
  test('selects pages matching priority keywords and assigns a category', () => {
    const links = [
      link('/about', 'About Us'),
      link('/services', 'Our Services'),
      link('/team', 'Our Team'),
      link('/random-page', 'Random Page'),
    ];
    const { selected, rejected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    const selectedUrls = selected.map((s) => s.url);
    assert.ok(selectedUrls.includes('https://complianceoffice.co.uk/about'));
    assert.ok(selectedUrls.includes('https://complianceoffice.co.uk/services'));
    assert.ok(selectedUrls.includes('https://complianceoffice.co.uk/team'));
    assert.ok(rejected.some((r) => r.url === 'https://complianceoffice.co.uk/random-page' && r.reason === 'no_relevant_keyword_match'));
  });

  test('assigns the expected category to a matched page', () => {
    const { selected } = selectResearchPages(HOMEPAGE, [link('/services', 'Services')], { rootDomain: HOMEPAGE });
    assert.strictEqual(selected[0].category, 'services');
  });

  test('deterministic: identical input produces identical output and order across repeated calls', () => {
    const links = [link('/services', 'Services'), link('/about', 'About'), link('/team', 'Team')];
    const first = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    const second = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.deepStrictEqual(first.selected.map((s) => s.url), second.selected.map((s) => s.url));
  });
});

describe('selectResearchPages — rejection reasons', () => {
  test('rejects privacy, cookie and terms pages', () => {
    const links = [link('/privacy-policy', 'Privacy Policy'), link('/cookies', 'Cookie Policy'), link('/terms', 'Terms')];
    const { rejected, selected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.strictEqual(selected.length, 0);
    assert.ok(rejected.every((r) => r.reason === 'privacy_or_legal'));
  });

  test('rejects login/account/checkout pages', () => {
    const links = [link('/login', 'Login'), link('/basket', 'Basket'), link('/checkout', 'Checkout')];
    const { rejected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.ok(rejected.every((r) => r.reason === 'account_or_transactional'));
  });

  test('deprioritises careers pages', () => {
    const { rejected } = selectResearchPages(HOMEPAGE, [link('/careers', 'Careers')], { rootDomain: HOMEPAGE });
    assert.strictEqual(rejected[0].reason, 'careers_deprioritised');
  });

  test('rejects a generic contact page but keeps a team/leadership page', () => {
    const links = [link('/contact', 'Contact Us'), link('/team', 'Our Team')];
    const { selected, rejected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.ok(rejected.some((r) => r.reason === 'generic_contact_form'));
    assert.ok(selected.some((s) => s.url.endsWith('/team')));
  });

  test('rejects pagination/tag/search pages', () => {
    const links = [link('/tag/updates', 'Updates'), link('/page/2', 'Page 2'), link('/search?q=x', 'Search')];
    const { rejected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.ok(rejected.every((r) => r.reason === 'pagination_or_search'));
  });

  test('rejects an external domain even if the label matches a priority keyword', () => {
    const { rejected, selected } = selectResearchPages(HOMEPAGE, [link('https://otherdomain.com/about', 'About')], { rootDomain: HOMEPAGE });
    assert.strictEqual(selected.length, 0);
    assert.strictEqual(rejected[0].reason, 'external_domain');
  });

  test('rejects a non-HTML file extension', () => {
    const { rejected } = selectResearchPages(HOMEPAGE, [link('/brochure.pdf', 'Our Services Brochure')], { rootDomain: HOMEPAGE });
    assert.strictEqual(rejected[0].reason, 'unsupported_file_type');
  });

  test('rejects mailto/tel links', () => {
    const { rejected } = selectResearchPages(HOMEPAGE, [link('mailto:info@complianceoffice.co.uk', 'Email us about our services')], { rootDomain: HOMEPAGE });
    assert.strictEqual(rejected[0].reason, 'unsupported_protocol');
  });
});

describe('selectResearchPages — MVP-0 limits', () => {
  test('never selects more than maxAdditionalPages, rejecting the overflow with a clear reason', () => {
    const links = Array.from({ length: 12 }, (_, i) => link(`/services-${i}`, `Services ${i}`));
    const { selected, rejected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE, maxAdditionalPages: 8 });
    assert.strictEqual(selected.length, 8);
    assert.ok(rejected.some((r) => r.reason === 'exceeded_page_cap'));
  });

  test('never re-selects the homepage itself', () => {
    const links = [link('/', 'Home'), link('/about', 'About')];
    const { selected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.ok(!selected.some((s) => s.url === HOMEPAGE));
  });

  test('deduplicates the same link appearing twice', () => {
    const links = [link('/about', 'About'), link('/about', 'About Us Too')];
    const { selected } = selectResearchPages(HOMEPAGE, links, { rootDomain: HOMEPAGE });
    assert.strictEqual(selected.filter((s) => s.url.endsWith('/about')).length, 1);
  });
});
