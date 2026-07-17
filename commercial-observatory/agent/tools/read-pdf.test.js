'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createReadPdfTool } = require('./read-pdf');

function fakePdfFetch(overrides = {}) {
  return async () => ({
    success: true, finalUrl: 'https://example.com/report.pdf', status: 200,
    contentType: 'application/pdf', body: Buffer.from('%PDF-fake'), retrievedAt: '2026-07-15T00:00:00.000Z', headers: {},
    ...overrides,
  });
}

class FakePDFParse {
  constructor() {}
  async getInfo() { return { total: 3 }; }
  async getText() { return { text: 'Extracted PDF text.' }; }
  async destroy() {}
}

describe('read_pdf', () => {
  test('extracts text and page count from a fetched PDF', async () => {
    const tool = createReadPdfTool({ fetchUrl: fakePdfFetch(), PDFParse: FakePDFParse });
    const result = await tool.execute({ url: 'https://example.com/report.pdf', investigationId: 'inv-1' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.pageCount, 3);
    assert.strictEqual(result.output.text, 'Extracted PDF text.');
    assert.ok(result.output.contentHash.startsWith('sha256:'));
    assert.ok(result.output.sourceUrl);
  });

  test('rejects a non-PDF content-type', async () => {
    const tool = createReadPdfTool({ fetchUrl: fakePdfFetch({ contentType: 'text/html', finalUrl: 'https://example.com/page' }), PDFParse: FakePDFParse });
    const result = await tool.execute({ url: 'https://example.com/page', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'not_pdf');
  });

  test('cleanly rejects an encrypted/password-protected PDF', async () => {
    class EncryptedParse {
      async getInfo() { throw new Error('PasswordException: document is password protected'); }
    }
    const tool = createReadPdfTool({ fetchUrl: fakePdfFetch(), PDFParse: EncryptedParse });
    const result = await tool.execute({ url: 'https://example.com/report.pdf', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'encrypted_or_unsupported');
  });

  test('propagates a structured fetch failure (e.g. SSRF-blocked)', async () => {
    const tool = createReadPdfTool({ fetchUrl: async () => ({ success: false, errorType: 'ssrf_blocked', error: 'blocked', retryable: false }), PDFParse: FakePDFParse });
    const result = await tool.execute({ url: 'http://169.254.169.254/report.pdf', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'ssrf_blocked');
  });

  test('rejects a response exceeding the configured size limit', async () => {
    const bigBuffer = Buffer.alloc(1000, 'a');
    const tool = createReadPdfTool({ fetchUrl: fakePdfFetch({ body: bigBuffer }), PDFParse: FakePDFParse, maxBytes: 100 });
    const result = await tool.execute({ url: 'https://example.com/report.pdf', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'response_too_large');
  });
});
