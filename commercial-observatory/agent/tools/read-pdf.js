'use strict';

// read_pdf — fetches a public PDF (SSRF-safe, via web-fetch.js) and
// extracts its text (via `pdf-parse` — the smallest suitable PDF-text
// library; none existed in this backend before this task, added as a
// backend-only dependency, see the final response's Dependencies section).

const { fetchUrl: defaultFetchUrl } = require('../../sources/web-fetch');
const { contentHash } = require('../../domain/evidence');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const DEFAULT_MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB

const INPUT_SCHEMA = {
  required: ['url', 'investigationId'],
  properties: { url: { type: 'string' }, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function createReadPdfTool(deps = {}) {
  const fetchUrl = deps.fetchUrl || defaultFetchUrl;
  const maxBytes = deps.maxBytes || DEFAULT_MAX_PDF_BYTES;

  // Lazily required so the dependency is only loaded when this tool is
  // actually used, and so tests can inject a fake parser without needing
  // the real library to be present.
  function loadParser() {
    if (deps.PDFParse) return deps.PDFParse;
    // eslint-disable-next-line global-require
    return require('pdf-parse').PDFParse;
  }

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('read_pdf', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const fetchResult = await fetchUrl(input.url, { maxContentBytes: maxBytes });
    if (!fetchResult.success) {
      return failureResult('read_pdf', { errorType: fetchResult.errorType, error: fetchResult.error, retryable: fetchResult.retryable });
    }

    const contentType = fetchResult.contentType || '';
    if (!contentType.includes('pdf') && !fetchResult.finalUrl.toLowerCase().endsWith('.pdf')) {
      return failureResult('read_pdf', { errorType: 'not_pdf', error: `URL did not return a PDF (content-type: ${contentType || 'unknown'})`, retryable: false });
    }

    const buffer = Buffer.isBuffer(fetchResult.body) ? fetchResult.body : Buffer.from(fetchResult.body, 'binary');
    if (buffer.byteLength > maxBytes) {
      return failureResult('read_pdf', { errorType: 'response_too_large', error: 'PDF exceeds maximum allowed size', retryable: false });
    }

    let PDFParse;
    try {
      PDFParse = loadParser();
    } catch (err) {
      return failureResult('read_pdf', { errorType: 'pdf_library_unavailable', error: err.message, retryable: false });
    }

    let parser;
    try {
      parser = new PDFParse({ data: buffer });
      const info = await parser.getInfo();
      const textResult = await parser.getText();
      return successResult('read_pdf', {
        sourceUrl: fetchResult.finalUrl,
        pageCount: info?.total ?? null,
        text: textResult?.text ?? '',
        contentHash: contentHash(buffer),
        retrievedAt: fetchResult.retrievedAt,
      }, {
        provenance: { sourceUrl: fetchResult.finalUrl, retrievedAt: fetchResult.retrievedAt, contentHash: contentHash(buffer), pageCount: info?.total ?? null },
      });
    } catch (err) {
      const encrypted = /password|encrypt/i.test(err.message || '');
      return failureResult('read_pdf', { errorType: encrypted ? 'encrypted_or_unsupported' : 'pdf_parse_failed', error: err.message, retryable: false });
    } finally {
      if (parser && typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch { /* best-effort cleanup */ }
      }
    }
  }

  return {
    name: 'read_pdf',
    description: 'Fetches a public PDF (SSRF-safe, size-bounded) and extracts its text and page count.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 30000,
    maxRetries: 1,
    execute: rawExecute,
  };
}

module.exports = { createReadPdfTool, DEFAULT_MAX_PDF_BYTES };
