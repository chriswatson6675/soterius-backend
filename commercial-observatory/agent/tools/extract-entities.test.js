'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createExtractEntitiesTool } = require('./extract-entities');

describe('extract_entities', () => {
  test('returns contextual mentions and linked organisations from an already-fetched page', async () => {
    const tool = createExtractEntitiesTool();
    const result = await tool.execute({
      sourceUrl: 'https://complianceoffice.co.uk/',
      extractedPage: { visibleText: 'The FCA published new guidance this week.', headings: [], footerText: '', externalLinks: [], jsonLd: [] },
      subjectName: 'Compliance Office',
      investigationId: 'inv-1',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.contextualMentions.some((m) => m.rawName === 'FCA'));
  });

  test('rejects invalid input', async () => {
    const tool = createExtractEntitiesTool();
    const result = await tool.execute({ investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
  });
});
