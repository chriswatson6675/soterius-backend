'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFetchWebPageTool } = require('./fetch-web-page');

const SAMPLE_HTML = '<html><head><title>Regulator Page</title></head><body><h1>About</h1><p>We regulate firms.</p></body></html>';

describe('fetch_web_page', () => {
  test('fetches and extracts a public page beyond the target domain', async () => {
    const fetchUrl = async (url) => ({ success: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', body: SAMPLE_HTML, retrievedAt: '2026-07-15T00:00:00.000Z', headers: {} });
    const tool = createFetchWebPageTool({ fetchUrl });
    const result = await tool.execute({ url: 'https://www.fca.org.uk/firms/example', investigationId: 'inv-1' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.title, 'Regulator Page');
    assert.ok(result.provenance.finalUrl);
    assert.ok(result.provenance.retrievedAt);
  });

  test('propagates a structured failure from the underlying fetch, never throws', async () => {
    const fetchUrl = async () => ({ success: false, requestedUrl: 'x', errorType: 'ssrf_blocked', error: 'blocked', retryable: false });
    const tool = createFetchWebPageTool({ fetchUrl });
    const result = await tool.execute({ url: 'http://169.254.169.254/', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'ssrf_blocked');
  });

  test('rejects a PDF content-type in favour of read_pdf', async () => {
    const fetchUrl = async () => ({ success: true, finalUrl: 'x', status: 200, contentType: 'application/pdf', body: '%PDF', retrievedAt: '2026-07-15T00:00:00.000Z', headers: {} });
    const tool = createFetchWebPageTool({ fetchUrl });
    const result = await tool.execute({ url: 'https://example.com/doc.pdf', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'not_html');
  });

  test('rejects missing input fields', async () => {
    const tool = createFetchWebPageTool({});
    const result = await tool.execute({ investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'invalid_input');
  });
});
