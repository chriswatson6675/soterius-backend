'use strict';
/**
 * HE Feed — imports UK higher education providers from data.ac.uk.
 *
 * Source: https://learning-provider.data.ac.uk/data/learning-providers-plus.csv
 * Population: 166 universities and specialist HE institutions
 * Identifier: UKPRN (UK Provider Reference Number)
 *
 * Usage:
 *   node scripts/feeds/he.js --file path/to/uk-learning-providers-YYYYMMDD.csv [--dry-run] [--limit N]
 *
 * Required env vars: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { log, warn, error } = require('../pipeline/lib/log');
const importModule          = require('../pipeline/import');

// ── Constants ─────────────────────────────────────────────────────────────────

const SECTOR      = 'higher-education';
const REGULATOR   = 'OfS';
const SOURCE      = 'ofs-register';
const SOURCE_DATE = new Date().toISOString().slice(0, 10);

// ── CSV helpers ───────────────────────────────────────────────────────────────

function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(content) {
  const cleaned = content.replace(/^﻿/, '');
  const lines   = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  const rows    = lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = splitCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()]));
    });

  return { headers, rows };
}

// ── Normalisation ─────────────────────────────────────────────────────────────

const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s[0-9][A-Z]{2}$/;

function normalisePostcode(raw) {
  if (!raw) return '';
  const stripped = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (stripped.length < 5) return '';
  const normalised = stripped.slice(0, -3) + ' ' + stripped.slice(-3);
  return UK_POSTCODE_RE.test(normalised) ? normalised : '';
}

// ── Record mapping ────────────────────────────────────────────────────────────
// Row keys are original-case from the source CSV (parseCSV preserves case).

function mapRecord(row) {
  const ukprn    = (row['UKPRN']         || '').trim();
  const firmName = (row['PROVIDER_NAME'] || '').trim();
  const website  = (row['WEBSITE_URL']   || '').trim();
  const town     = (row['TOWN']          || '').trim();
  const postcode = normalisePostcode(row['POSTCODE'] || '');

  return {
    firm_name:        firmName,
    website:          website,
    sector:           SECTOR,
    source:           SOURCE,
    source_date:      SOURCE_DATE,
    source_reference: ukprn
      ? `https://www.officeforstudents.org.uk/about/register/?ukprn=${ukprn}`
      : '',
    regulator:        REGULATOR,
    regulator_id:     ukprn,
    postcode,
    town,
    county:           '',
    country:          'United Kingdom',
    active_status:    'active',
    firm_confidence:  '95',
  };
}

// ── CSV export for import.js ──────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  'firm_name', 'website', 'sector', 'source', 'source_date', 'source_reference',
  'regulator', 'regulator_id', 'postcode', 'town', 'county', 'country',
  'active_status', 'firm_confidence',
];

function escapeCSV(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordsToCSV(records) {
  const header = EXPORT_COLUMNS.join(',');
  const rows   = records.map(r => EXPORT_COLUMNS.map(col => escapeCSV(r[col])).join(','));
  return [header, ...rows].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run({ file, limit = 0, dryRun = false } = {}) {
  if (!file) throw new Error('--file is required. Download from: https://learning-provider.data.ac.uk/data/learning-providers-plus.csv');

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  log(`HE Feed — parsing ${path.basename(filePath)}${dryRun ? ' (dry-run)' : ''}`);

  const content           = fs.readFileSync(filePath, 'utf8');
  const { headers, rows } = parseCSV(content);

  if (!rows.length) throw new Error('CSV is empty or has no data rows');
  log(`Parsed ${rows.length} rows`);

  const required = ['UKPRN', 'PROVIDER_NAME', 'WEBSITE_URL', 'TOWN', 'POSTCODE'];
  const missing  = required.filter(col => !headers.includes(col));
  if (missing.length) {
    throw new Error(
      `Missing required columns: ${missing.join(', ')}\n` +
      `First 8 headers found: ${headers.slice(0, 8).join(', ')}`
    );
  }

  let records = rows.map(mapRecord);

  const totalParsed = records.length;
  records = records.filter(r => r.firm_name && r.regulator_id);
  if (totalParsed - records.length > 0) {
    warn(`Dropped ${totalParsed - records.length} rows with no PROVIDER_NAME or UKPRN`);
  }

  if (limit > 0) {
    records = records.slice(0, limit);
    log(`Limit applied — processing ${records.length} records`);
  }

  if (!records.length) { warn('No records to import after filtering'); return; }

  const withWebsite  = records.filter(r => r.website).length;
  const withPostcode = records.filter(r => r.postcode).length;
  log(`Kept ${records.length} records`);
  log(`Website coverage:  ${withWebsite}/${records.length} (${Math.round(withWebsite / records.length * 100)}%)`);
  log(`Postcode coverage: ${withPostcode}/${records.length} (${Math.round(withPostcode / records.length * 100)}%)`);

  const tempFile = path.join(os.tmpdir(), `soterius-he-${Date.now()}.csv`);
  try {
    fs.writeFileSync(tempFile, recordsToCSV(records), 'utf8');

    const importStats = await importModule.run({
      file:      tempFile,
      dryRun,
      regulator: REGULATOR,
    });

    if (importStats) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(` HE FEED COMPLETE`);
      console.log(`${'═'.repeat(60)}`);
      console.log(`  Source file      : ${path.basename(filePath)}`);
      console.log(`  Parsed           : ${rows.length}`);
      console.log(`  Processed        : ${records.length}`);
      console.log(`  Inserted         : ${importStats.inserted}`);
      console.log(`  Skipped (exists) : ${importStats.skipped}`);
      console.log(`  Errors           : ${importStats.errors}`);
      console.log(`${'═'.repeat(60)}\n`);
    }

    return importStats;
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args   = process.argv.slice(2);
  const get    = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const file   = get('--file');
  const limit  = parseInt(get('--limit') || '0', 10);
  const dryRun = args.includes('--dry-run');

  run({ file, limit, dryRun }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
