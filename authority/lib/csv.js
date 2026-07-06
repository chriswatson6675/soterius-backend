'use strict';

// Minimal, dependency-free CSV parser sufficient for the regulator source
// files (quoted fields, embedded commas, doubled "" escapes, CRLF). Not a
// general RFC-4180 implementation — deliberately small and deterministic.

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

// Parse a full CSV string into rows of arrays. Blank lines are skipped.
function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map(parseCsvLine);
}

// Parse CSV where the header may sit below a preamble (the PRA downloads).
// `matchHeader(cells)` returns true for the real header row. Returns
// { header, rows } where rows are objects keyed by header cell.
function parseCsvWithHeader(text, matchHeader) {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    const cells = parseCsvLine(lines[i]);
    if (matchHeader(cells)) { headerIdx = i; header = cells; break; }
  }
  if (headerIdx === -1) return { header: null, rows: [] };
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    const cells = parseCsvLine(lines[i]);
    const obj = {};
    header.forEach((h, j) => { obj[h] = cells[j] !== undefined ? cells[j] : ''; });
    rows.push(obj);
  }
  return { header, rows };
}

module.exports = { parseCsvLine, parseCsv, parseCsvWithHeader };
