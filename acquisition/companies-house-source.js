'use strict';

// companies-house-source.js — Companies House candidate source (streaming).
//
// Population Acquisition Layer. SOLE responsibility: supply candidates. It reads
// Companies House company records, selects financial candidates using the FROZEN
// SIC authority (candidate-sic.js), skips inactive companies, and yields
//   { companyNumber, companyName, sicCodes }
// one at a time as an async iterable, so a multi-million-row population streams with
// bounded memory. It performs NO FCA matching, eligibility, enrichment, lifecycle, or
// persistence, and it is independent of the Candidate Processor.
//
// SIC filtering is delegated to candidate-sic.js (the single authority) — not
// duplicated here. The record input is injectable: the default reader streams the
// Companies House Free Company Data Product CSV, but any async/sync iterable of raw
// records { companyNumber, companyName, status, sicCodes } can be supplied.

const fs = require('node:fs');
const readline = require('node:readline');

const { matchedApproved } = require('../collection/sources/companies-house/candidate-sic');

/** True iff a Companies House status string denotes an active company. */
function _isActive(status) { return String(status ?? '').trim().toLowerCase() === 'active'; }

/** Minimal CSV line parser handling double-quoted fields with escaped quotes. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Resolve the columns we need from a (trimmed) CH bulk header row. */
function _columnIndex(header) {
  return {
    name: header.indexOf('CompanyName'),
    number: header.indexOf('CompanyNumber'),
    status: header.indexOf('CompanyStatus'),
    sic: header.map((h, i) => (/^SICCode\.SicText_\d+$/.test(h) ? i : -1)).filter((i) => i >= 0),
  };
}

/**
 * Stream raw company records from the Companies House Free Company Data Product CSV.
 * Line-by-line (bounded memory). Yields { companyNumber, companyName, status, sicCodes }.
 * @param {string} file
 */
async function* streamBulkCsv(file, opts = {}) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const onRow = typeof opts.onRow === 'function' ? opts.onRow : null;
  let idx = null;
  let rows = 0;
  for await (const line of rl) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (!idx) { idx = _columnIndex(cols.map((h) => h.trim())); continue; }   // header row
    if (onRow) onRow(++rows);                                                // progress callback (data rows scanned)
    yield {
      companyName: idx.name >= 0 && cols[idx.name] != null ? cols[idx.name].trim() : '',
      companyNumber: idx.number >= 0 && cols[idx.number] != null ? cols[idx.number].trim() : '',
      status: idx.status >= 0 && cols[idx.status] != null ? cols[idx.status].trim() : '',
      sicCodes: idx.sic.map((i) => cols[i]).filter((v) => v != null && String(v).trim() !== ''),
    };
  }
}

/**
 * The Companies House candidate source: an async iterable yielding financial,
 * (by default) active candidates. Selection delegated to candidate-sic.
 * @param {Object} opts
 * @param {Iterable|AsyncIterable} [opts.records] - raw records; defaults to streamBulkCsv(opts.path)
 * @param {string} [opts.path] - CH bulk CSV path (used when records is not supplied)
 * @param {boolean} [opts.activeOnly=true] - skip non-active companies
 * @returns {AsyncGenerator<{companyNumber:string, companyName:string, sicCodes:string[]}>}
 */
async function* companiesHouseCandidateSource(opts = {}) {
  const records = opts.records || streamBulkCsv(opts.path);
  const activeOnly = opts.activeOnly !== false;
  for await (const rec of records) {
    if (activeOnly && !_isActive(rec.status)) continue;
    const sicCodes = matchedApproved(rec.sicCodes);     // frozen SIC authority; [] ⇒ not a candidate
    if (sicCodes.length === 0) continue;
    yield { companyNumber: String(rec.companyNumber), companyName: rec.companyName, sicCodes };
  }
}

module.exports = { companiesHouseCandidateSource, streamBulkCsv, parseCsvLine };
