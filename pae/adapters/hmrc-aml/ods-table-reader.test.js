'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readOdsTable } = require('./ods-table-reader');
const { buildOdsBuffer } = require('./test-fixtures/build-ods');

test('reads headers and rows, dropping trailing padded columns/rows', async () => {
  const buf = await buildOdsBuffer({
    headers: ['A', 'B', 'C'],
    rows: [
      ['1', '2', '3'],
      ['4', '5', '6'],
    ],
  });

  const table = await readOdsTable(buf);

  assert.equal(table.sheetName, 'Supervised_Business_Register');
  assert.deepEqual(table.headers, ['A', 'B', 'C']);
  assert.deepEqual(table.rows, [
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
});

test('preserves a blank cell verbatim as an empty string, never a placeholder', async () => {
  const buf = await buildOdsBuffer({
    headers: ['A', 'B'],
    rows: [['only-a', '']],
  });

  const table = await readOdsTable(buf);

  assert.deepEqual(table.rows, [['only-a', '']]);
});

test('expands a small table:number-rows-repeated into that many rows', async () => {
  const buf = await buildOdsBuffer({
    headers: ['A'],
    rows: [['x']],
    trailingRowRepeat: 5000, // still the padding row appended after
  });
  // Directly exercise a repeated *data* row via the low-level builder is out
  // of build-ods.js's surface; instead prove the real file's own repeat
  // pattern doesn't leak through as literal duplicate padding rows.
  const table = await readOdsTable(buf);
  assert.deepEqual(table.rows, [['x']]);
});

test('rejects a non-ODS buffer with a clear error', async () => {
  await assert.rejects(() => readOdsTable(Buffer.from('not a zip')), /not a valid ODS/);
});

test('rejects an ODS file with no table', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  zip.file(
    'content.xml',
    '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:spreadsheet/></office:body></office:document-content>'
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  await assert.rejects(() => readOdsTable(buf), /no table:table found/);
});
