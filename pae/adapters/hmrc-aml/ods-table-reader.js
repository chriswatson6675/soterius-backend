'use strict';

// ods-table-reader.js — reads a single-sheet OpenDocument Spreadsheet (.ods)
// into a plain { sheetName, headers, rows } table. Not a Signal Lab collector
// (no byte-preservation, sealing, or provenance) — a narrow parsing utility
// for the PAE HMRC AML batch adapter (index.js), which needs cell text only.
//
// LibreOffice/Excel pad an exported sheet out to its full grid with one
// trailing cell/row carrying a huge table:number-columns-repeated /
// table:number-rows-repeated count (confirmed against the real HMRC AML
// register export: a final row repeated 980606 times). That padding is
// recognised by its size and dropped rather than materialised — expanding it
// literally would mean allocating tens of thousands of empty array entries
// per row for the whole file.

const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const TRAILING_REPEAT_THRESHOLD = 1000;

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function cellText(cell) {
  if (cell == null) return '';
  const p = cell['text:p'];
  if (p == null) return '';
  const paras = asArray(p);
  return paras
    .map((x) => (typeof x === 'string' ? x : (x && x['#text'] != null ? String(x['#text']) : '')))
    .join('\n');
}

function repeatCount(node, attr) {
  const n = node && node[attr];
  const parsed = n != null ? parseInt(n, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * @param {Buffer} buffer - raw ODS file bytes
 * @returns {Promise<{sheetName: string|null, headers: string[], rows: string[][]}>}
 */
async function readOdsTable(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new Error(`not a valid ODS (zip) file: ${err.message}`);
  }
  const contentFile = zip.file('content.xml');
  if (!contentFile) throw new Error('not a valid ODS file: content.xml missing');
  const xml = await contentFile.async('string');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => name === 'table:table-row' || name === 'table:table-cell' || name === 'text:p',
  });

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`not a valid ODS file: content.xml is not well-formed XML: ${err.message}`);
  }

  const body = doc['office:document-content'] && doc['office:document-content']['office:body'];
  const spreadsheet = body && body['office:spreadsheet'];
  const table = spreadsheet && spreadsheet['table:table'];
  if (!table) throw new Error('not a valid ODS register: no table:table found in content.xml');
  const tableNode = Array.isArray(table) ? table[0] : table;
  const sheetName = tableNode['@_table:name'] || null;

  const xmlRows = asArray(tableNode['table:table-row']);
  if (!xmlRows.length) throw new Error('not a valid ODS register: sheet has no rows');

  // The header row fixes the register's real column width (§7.2 — mapping is
  // by header, not position); anything beyond it is trailing grid padding.
  const headerCells = asArray(xmlRows[0]['table:table-cell']);
  const headers = [];
  for (const cell of headerCells) {
    const rep = repeatCount(cell, '@_table:number-columns-repeated');
    if (rep >= TRAILING_REPEAT_THRESHOLD) break;
    const text = cellText(cell);
    for (let i = 0; i < rep; i++) headers.push(text);
  }
  if (!headers.length) throw new Error('not a valid ODS register: header row is empty');

  const rows = [];
  for (let r = 1; r < xmlRows.length; r++) {
    const xmlRow = xmlRows[r];
    const repeat = repeatCount(xmlRow, '@_table:number-rows-repeated');
    const cells = asArray(xmlRow['table:table-cell']);

    const values = [];
    for (const cell of cells) {
      if (values.length >= headers.length) break;
      const rep = repeatCount(cell, '@_table:number-columns-repeated');
      const text = cellText(cell);
      const take = Math.min(rep, headers.length - values.length);
      for (let i = 0; i < take; i++) values.push(text);
    }
    while (values.length < headers.length) values.push('');

    const rowIsEmpty = values.every((v) => v === '');
    if (rowIsEmpty && repeat >= TRAILING_REPEAT_THRESHOLD) {
      // Trailing empty-row padding out to the sheet's full grid — stop.
      break;
    }
    for (let i = 0; i < repeat; i++) rows.push(values);
  }

  return { sheetName, headers, rows };
}

module.exports = { readOdsTable, TRAILING_REPEAT_THRESHOLD };
