'use strict';

// build-ods.js — builds a minimal, valid .ods buffer for tests only. Mirrors
// the real HMRC AML export's structure (a header row, data rows, and a
// trailing huge-repeat empty row/column pair representing the sheet's
// padded-out grid) without needing the real ~4.8MB file in the test suite.

const JSZip = require('jszip');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cellXml(value) {
  if (value === undefined || value === null || value === '') return '<table:table-cell/>';
  return `<table:table-cell office:value-type="string"><text:p>${xmlEscape(value)}</text:p></table:table-cell>`;
}

function rowXml(values) {
  return `<table:table-row>${values.map(cellXml).join('')}</table:table-row>`;
}

/**
 * @param {{headers: string[], rows: string[][], trailingRowRepeat?: number, trailingColRepeat?: number}} opts
 * @returns {Promise<Buffer>}
 */
async function buildOdsBuffer({ headers, rows, trailingRowRepeat = 5000, trailingColRepeat = 5000 }) {
  const paddedHeader = `${rowXml(headers)}`.replace(
    '</table:table-row>',
    `<table:table-cell table:number-columns-repeated="${trailingColRepeat}"/></table:table-row>`
  );
  const dataRowsXml = rows
    .map((r) => {
      const base = rowXml(r);
      return base.replace(
        '</table:table-row>',
        `<table:table-cell table:number-columns-repeated="${trailingColRepeat}"/></table:table-row>`
      );
    })
    .join('');
  const trailingEmptyRow = `<table:table-row table:number-rows-repeated="${trailingRowRepeat}"><table:table-cell table:number-columns-repeated="${headers.length + trailingColRepeat}"/></table:table-row>`;

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.4">
<office:body><office:spreadsheet>
<table:table table:name="Supervised_Business_Register">
${paddedHeader}${dataRowsXml}${trailingEmptyRow}
</table:table>
</office:spreadsheet></office:body>
</office:document-content>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file('content.xml', contentXml);
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/></manifest:manifest>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { buildOdsBuffer };
