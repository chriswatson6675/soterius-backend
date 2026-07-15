'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchCandidatePages } = require('./fetch-candidate-pages');

const HOMEPAGE_HTML = `
  <html><body>
    <nav>
      <a href="/contact-us">Contact Us</a>
      <a href="/about">About</a>
      <a href="/terms-and-conditions">Terms</a>
      <a href="/blog">Blog</a>
    </nav>
    <h1>Acme Widgets</h1>
  </body></html>
`;

function fakeFetch(bodiesByUrl) {
  return async (url) => {
    const body = bodiesByUrl[url];
    if (body === undefined) return { success: false, requestedUrl: url, errorType: 'http_error', error: 'HTTP 404' };
    return { success: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', body };
  };
}

test('fetchCandidatePages: fetches homepage then up to 2 more matching contact/about/legal, priority order', async () => {
  const fetchUrl = fakeFetch({
    'https://acme.com': HOMEPAGE_HTML,
    'https://acme.com/contact-us': '<html><body>Contact page</body></html>',
    'https://acme.com/about': '<html><body>About page</body></html>',
    'https://acme.com/terms-and-conditions': '<html><body>Terms page</body></html>',
  });
  const pages = await fetchCandidatePages('acme.com', { fetchUrl });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].pageRole, 'homepage');
  assert.equal(pages[1].pageRole, 'contact');
  assert.equal(pages[2].pageRole, 'about');
});

test('fetchCandidatePages: max 3 pages total per candidate domain', async () => {
  const fetchUrl = fakeFetch({
    'https://acme.com': HOMEPAGE_HTML,
    'https://acme.com/contact-us': '<html><body>Contact</body></html>',
    'https://acme.com/about': '<html><body>About</body></html>',
    'https://acme.com/terms-and-conditions': '<html><body>Terms</body></html>',
  });
  const pages = await fetchCandidatePages('acme.com', { fetchUrl });
  assert.ok(pages.length <= 3);
});

test('fetchCandidatePages: homepage fetch failure returns just the failed homepage entry', async () => {
  const fetchUrl = fakeFetch({});
  const pages = await fetchCandidatePages('doesnotexist.example', { fetchUrl });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].fetchResult.success, false);
});

test('fetchCandidatePages: no matching contact/about/legal links means only the homepage is fetched', async () => {
  const fetchUrl = fakeFetch({ 'https://acme.com': '<html><body><nav><a href="/blog">Blog</a></nav></body></html>' });
  const pages = await fetchCandidatePages('acme.com', { fetchUrl });
  assert.equal(pages.length, 1);
});
