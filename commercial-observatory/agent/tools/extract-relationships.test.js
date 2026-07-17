'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createExtractRelationshipsTool } = require('./extract-relationships');

describe('extract_relationships', () => {
  test('returns only deterministically-supported relationship candidates', async () => {
    const tool = createExtractRelationshipsTool();
    const result = await tool.execute({
      sourceUrl: 'https://complianceoffice.co.uk/',
      extractedPage: { visibleText: 'We are regulated by the FCA.', headings: [], footerText: '', externalLinks: [], jsonLd: [] },
      subjectName: 'Compliance Office',
      investigationId: 'inv-1',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.relationshipCandidates.length, 1);
    assert.strictEqual(result.output.relationshipCandidates[0].relationshipType, 'regulator');
  });

  test('a bare mention with no phrase yields zero relationship candidates', async () => {
    const tool = createExtractRelationshipsTool();
    const result = await tool.execute({
      sourceUrl: 'https://complianceoffice.co.uk/',
      extractedPage: { visibleText: 'The FCA published new guidance this week.', headings: [], footerText: '', externalLinks: [], jsonLd: [] },
      subjectName: 'Compliance Office',
      investigationId: 'inv-1',
    });
    assert.strictEqual(result.output.relationshipCandidates.length, 0);
  });
});
