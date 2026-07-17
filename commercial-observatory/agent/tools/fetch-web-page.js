'use strict';

// fetch_web_page — thin tool wrapper around the ALREADY-EXISTING,
// SSRF-safe fetch/extract pair (sources/web-fetch.js + sources/
// html-extract.js). Reused verbatim, not reimplemented — Part 1's "do not
// implement fake tools where a real repository capability already exists."
//
// Unlike inspect_target_website (which is scoped to the target's own
// domain), this tool fetches ANY public URL — regulator pages, third-party
// articles, discovered co-party sites, etc. SSRF protection (private/
// loopback/link-local rejection) is inherited unchanged from web-fetch.js.

const { fetchUrl: defaultFetchUrl } = require('../../sources/web-fetch');
const { extractHtml: defaultExtractHtml } = require('../../sources/html-extract');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['url', 'investigationId'],
  properties: { url: { type: 'string' }, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createFetchWebPageTool(deps = {}) {
  const fetchUrl = deps.fetchUrl || defaultFetchUrl;
  const extractHtml = deps.extractHtml || defaultExtractHtml;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('fetch_web_page', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const fetchResult = await fetchUrl(input.url, {});
    if (!fetchResult.success) {
      return failureResult('fetch_web_page', { errorType: fetchResult.errorType, error: fetchResult.error, retryable: fetchResult.retryable });
    }

    const contentType = fetchResult.contentType || '';
    if (contentType.includes('application/pdf')) {
      return failureResult('fetch_web_page', { errorType: 'not_html', error: 'URL returned a PDF — use read_pdf instead.', retryable: false });
    }

    const extracted = extractHtml(fetchResult.body, fetchResult.finalUrl);
    return successResult('fetch_web_page', {
      requestedUrl: input.url,
      finalUrl: fetchResult.finalUrl,
      status: fetchResult.status,
      title: extracted.title,
      visibleText: extracted.visibleText,
      headings: extracted.headings,
      internalLinks: extracted.internalLinks,
      externalLinks: extracted.externalLinks,
      jsonLd: extracted.jsonLd,
      footerText: extracted.footerText,
      rawBody: fetchResult.body,
      retrievedAt: fetchResult.retrievedAt,
    }, {
      provenance: { requestedUrl: input.url, finalUrl: fetchResult.finalUrl, retrievedAt: fetchResult.retrievedAt, status: fetchResult.status },
    });
  }

  return {
    name: 'fetch_web_page',
    description: 'Fetches and extracts any public HTML page (not restricted to the target\'s own domain). SSRF-safe.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 20000,
    maxRetries: 1,
    execute: rawExecute,
  };
}

module.exports = { createFetchWebPageTool };
