'use strict';

// index.js — the HMRC AML Batch Adapter (ENG-024 WP-2), the first concrete
// implementation of the WP-1 Batch Adapter Contract
// (backend/pae/batch-adapter-contract.js). Confirmed against the real HMRC
// AML Supervised Business Register export (datasets/hmrc-aml/) — column
// headers are: MLR Registration Number, Business Start Date, Business Name,
// Agent Start Date, Trading Name, Postcode, Money Service Businesses, High
// Value Dealer, Accountancy Service Provider, Trust or Company Service
// Provider, Estate Agency Business, Bill Payment Service Providers, IT and
// Digital Payment Service Providers, Art Market Participant, Letting Agency
// Business, MSB Money Transmitter, MSB Currency Exchange, MSB Foreign
// Exchange, MSB Scrap Metal Dealer, MSB Cheque Casher, Status.
//
// Scope (per ENG-024 WP-2 / ENG-018 §3 / the WP-1 contract this implements):
// parse -> validate source structure -> normalise into canonical Organisation
// source records -> emit. It never merges into Repository Authority, never
// performs Domain Discovery, never infers or searches for a domain, and never
// filters or interprets the AML-sector flag columns — those columns exist in
// the source but are out of scope for a canonical Organisation record and are
// not read here. HMRC AML publishes no website for a supervised business, so
// every emitted record carries noDomainAsserted: true (ACQ-014 §8).
//
// The anchor is the MLR registration number, read verbatim, emitted as the
// canonical `hmrcAml` field (GCN-004 §E.1 namespace member; identity
// precedence implemented in organisation/identity.js per ENG-027). A row's
// anchor may be blank; mirroring the source's own field-poverty (a business
// can register in the file at all only via the register's own data entry), a
// blank anchor is preserved as null rather than inferred, and does not by
// itself reject the row (only a blank Business Name does — a record with no
// name at all cannot be displayed or matched). The register is known to
// carry the same registration number across many rows (one branch address
// per row) — this is expected source structure, not a duplicate to resolve;
// resolution/dedup is a Repository Authority concern, out of scope here.

const { readOdsTable } = require('./ods-table-reader');

const SOURCE_ID = 'hmrc-aml';
const NAME_PRIORITY = 8; // lower = more authoritative; see loaders.js header comment

const REQUIRED_HEADERS = ['MLR Registration Number', 'Business Name'];
const OPTIONAL_HEADERS = ['Trading Name', 'Postcode', 'Status'];

function toBuffer(rawInput) {
  if (Buffer.isBuffer(rawInput)) return rawInput;
  if (rawInput && Buffer.isBuffer(rawInput.buffer)) return rawInput.buffer;
  throw new Error(`${SOURCE_ID}.parse() expects a Buffer of raw ODS bytes (or { buffer: Buffer })`);
}

function trimmedOrNull(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  return t || null;
}

async function parse(rawInput) {
  const buffer = toBuffer(rawInput);
  const table = await readOdsTable(buffer);

  const headerIndex = (name) => table.headers.findIndex((h) => h.trim() === name);
  const missing = REQUIRED_HEADERS.filter((name) => headerIndex(name) === -1);
  if (missing.length) {
    throw new Error(`${SOURCE_ID} register missing required column(s): ${missing.join(', ')}`);
  }

  const regIdx = headerIndex('MLR Registration Number');
  const nameIdx = headerIndex('Business Name');
  const tradingIdx = headerIndex('Trading Name');
  const postcodeIdx = headerIndex('Postcode');
  const statusIdx = headerIndex('Status');

  return table.rows.map((cells, rowIndex) => ({
    rowIndex,
    registrationNumber: trimmedOrNull(cells[regIdx]),
    businessName: trimmedOrNull(cells[nameIdx]),
    tradingName: tradingIdx >= 0 ? trimmedOrNull(cells[tradingIdx]) : null,
    postcode: postcodeIdx >= 0 ? trimmedOrNull(cells[postcodeIdx]) : null,
    status: statusIdx >= 0 ? trimmedOrNull(cells[statusIdx]) : null,
  }));
}

function validateStructure(rows) {
  const valid = [];
  const rejected = [];
  rows.forEach((row, index) => {
    if (!row || !row.businessName) {
      rejected.push({ index, row, reason: 'missing required field "Business Name"' });
    } else {
      valid.push(row);
    }
  });
  return { valid, rejected };
}

function normalise(validRows, context = {}) {
  const sourceDate = context.sourceDate || (typeof context.now === 'function' ? context.now() : null);
  return validRows.map((row) => {
    const key = row.registrationNumber
      ? `MLR:${row.registrationNumber}#${row.rowIndex}`
      : `ROW:${row.rowIndex}`;
    return {
      source: SOURCE_ID,
      regulator: 'HMRC',
      name: row.businessName,
      namePriority: NAME_PRIORITY,
      frn: null,
      sraNumber: null,
      ukprn: null,
      companyNumber: null,
      lei: null,
      ifUuid: null,
      frcAudit: null,
      // GCN-004 §E.1 namespace member — the anchor per CCD-HMRCAML-001
      // CR-HMRCAML-15, verbatim, never inferred. A canonical field as of the
      // GCN-004 identity-layer implementation (ENG-027 §2/§3.2/§3.4) — no
      // longer an adapter-local extra field.
      hmrcAml: row.registrationNumber,
      pbsFirm: null,
      domainRaw: null,
      domainSource: null,
      domainPriority: null,
      noDomainAsserted: true,
      sourceDate,
      provenance: { file: 'hmrc-aml-register.ods', key },
      // Extra field beyond the canonical shape (permitted — the contract's
      // validateCanonicalRecord only requires the listed fields be present,
      // it does not reject additional ones). Not read by loaders.js today.
      tradingName: row.tradingName,
    };
  });
}

module.exports = {
  sourceId: SOURCE_ID,
  parse,
  validateStructure,
  normalise,
};
