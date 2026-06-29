'use strict';
/**
 * FCA Feed — imports firms from the FCA Financial Services Register CSV.
 *
 * Download the bulk data from:
 *   https://register.fca.org.uk → Data → Download the Financial Services Register data
 *   Select "Firms" and download the CSV.
 *
 * Usage:
 *   node scripts/feeds/fca.js --file path/to/fca-register.csv [--limit N] [--dry-run] [--include-inactive]
 *
 * Required env vars (same as the pipeline):
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Prerequisites:
 *   1. migrate_v3.sql applied (adds regulator, regulator_id, town, country, active_status, first_discovered_at)
 *   2. migrate_v4.sql applied (makes website nullable, adds regulator uniqueness index)
 *
 * Per imported firm:
 *   regulator='FCA', regulator_id=FRN, pipeline_status='pending_enrichment'
 *   first_discovered_at=effective_date, active_status='active'
 *   firm_confidence=95, source='fca-register'
 *   source_reference=https://register.fca.org.uk/s/firm?id=<FRN>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { log, warn, error } = require('../pipeline/lib/log');
const importModule          = require('../pipeline/import');

// ── FCA column detection ──────────────────────────────────────────────────────
// Ordered lists of header name variants to try (case-insensitive).
// First match wins. FCA have changed column names across CSV versions.

const COLUMN_VARIANTS = {
  firm_name: ['Organisation Name', 'Firm Name', 'Name'],
  frn:       ['FRN', 'Firm Reference Number', 'Firm Ref', 'FRN Number'],
  status:    ['Status', 'Firm Status', 'Authorisation Status', 'Current Status'],
  eff_date:  ['First Authorisation Date', 'Effective Date', 'Date Effective', 'Authorisation Date', 'Date Authorised'],
  address1:  ['Address 1', 'Registered Address 1', 'Address Line 1'],
  address2:  ['Address 2', 'Registered Address 2', 'Address Line 2'],
  address3:  ['Address 3', 'Registered Address 3', 'Address Line 3'],
  address4:  ['Address 4', 'Registered Address 4', 'Address Line 4'],
  town:      ['Town', 'Registered Town', 'City', 'Locality'],
  county:    ['County', 'Registered County', 'Region'],
  postcode:  ['Postcode', 'Registered Postcode', 'Post Code', 'Postal Code'],
  country:   ['Country', 'Registered Country'],
  website:   ['Website', 'Web Address', 'URL', 'Web Site', 'Website Address'],
};

// FCA status values that indicate the firm is currently active / authorised
const ACTIVE_FCA_STATUSES = new Set([
  'authorised',
  'eea authorised',
  'registered',
  'appointed representative',
  'authorised - in run off',
]);

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
  // Strip BOM — common in Microsoft CSV exports
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

// ── Column mapping ────────────────────────────────────────────────────────────

function buildColumnMap(headers) {
  const map = {};
  for (const [field, variants] of Object.entries(COLUMN_VARIANTS)) {
    const match = variants.find(v =>
      headers.some(h => h.toLowerCase() === v.toLowerCase())
    );
    if (match) {
      map[field] = headers.find(h => h.toLowerCase() === match.toLowerCase());
    }
  }
  return map;
}

function getField(row, colMap, field) {
  const col = colMap[field];
  return col ? (row[col] || '').trim() : '';
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

function normaliseCountry(raw) {
  if (!raw) return 'United Kingdom';
  const lower = raw.toLowerCase().trim();
  if (lower.includes('england'))          return 'England';
  if (lower.includes('scotland'))         return 'Scotland';
  if (lower.includes('wales'))            return 'Wales';
  if (lower.includes('northern ireland')) return 'Northern Ireland';
  if (lower.includes('united kingdom') || lower === 'uk' || lower === 'gb') return 'United Kingdom';
  return raw.trim() || 'United Kingdom';
}

function normaliseDate(raw) {
  if (!raw) return '';
  // DD/MM/YYYY → YYYY-MM-DD
  const ddmm = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmm) return `${ddmm[3]}-${ddmm[2]}-${ddmm[1]}`;
  // Already ISO
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  return '';
}

// ── Record mapping ────────────────────────────────────────────────────────────

function mapRecord(row, colMap) {
  const firmName   = getField(row, colMap, 'firm_name');
  const frn        = getField(row, colMap, 'frn');
  const status     = getField(row, colMap, 'status');
  const effDate    = getField(row, colMap, 'eff_date');
  const town       = getField(row, colMap, 'town');
  const county     = getField(row, colMap, 'county');
  const postcode   = normalisePostcode(getField(row, colMap, 'postcode'));
  const country    = normaliseCountry(getField(row, colMap, 'country'));
  const website    = getField(row, colMap, 'website');
  const sourceDate = normaliseDate(effDate) || new Date().toISOString().slice(0, 10);

  return {
    firm_name:        firmName,
    website:          website,
    sector:           'financial-services',
    subsector:        'investment-management',
    source:           'fca-register',
    source_date:      sourceDate,
    source_reference: frn ? `https://register.fca.org.uk/s/firm?id=${frn}` : '',
    regulator:        'FCA',
    regulator_id:     frn,
    postcode,
    town,
    county,
    country,
    active_status:    'active',
    firm_confidence:  '95',
    _fca_status:      status,   // kept for filtering; not written to DB
  };
}

// ── CSV export for import.js ──────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  'firm_name', 'website', 'sector', 'subsector', 'source', 'source_date', 'source_reference',
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

async function run({ file, limit = 0, dryRun = false, includeInactive = false } = {}) {
  if (!file) throw new Error('--file is required. Download the FCA CSV from register.fca.org.uk');

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  log(`FCA Feed — parsing ${path.basename(filePath)}${dryRun ? ' (dry-run)' : ''}`);

  const content            = fs.readFileSync(filePath, 'utf8');
  const { headers, rows }  = parseCSV(content);

  if (!rows.length) throw new Error('CSV is empty or has no data rows');

  log(`Parsed ${rows.length.toLocaleString()} rows`);

  const colMap = buildColumnMap(headers);

  if (!colMap.firm_name) {
    throw new Error(`Could not detect firm name column. First 8 headers: ${headers.slice(0, 8).join(', ')}`);
  }
  if (!colMap.frn) {
    throw new Error(`Could not detect FRN column. First 8 headers: ${headers.slice(0, 8).join(', ')}`);
  }

  log(`Columns — firm: "${colMap.firm_name}" | FRN: "${colMap.frn}" | town: "${colMap.town || '—'}" | postcode: "${colMap.postcode || '—'}"`);

  // Map all rows
  let records = rows.map(row => mapRecord(row, colMap));

  // Drop rows with no firm name or FRN
  const totalParsed = records.length;
  records = records.filter(r => r.firm_name && r.regulator_id);

  // Filter by active status unless --include-inactive
  if (!includeInactive) {
    records = records.filter(r => ACTIVE_FCA_STATUSES.has(r._fca_status.toLowerCase()));
  }

  log(`Kept ${records.length.toLocaleString()} records (dropped ${(totalParsed - records.length).toLocaleString()} — no FRN/name or inactive)`);

  if (limit > 0) {
    records = records.slice(0, limit);
    log(`Limit applied — processing ${records.length} records`);
  }

  if (!records.length) {
    warn('No records to import after filtering');
    return;
  }

  const withWebsite  = records.filter(r => r.website).length;
  const withPostcode = records.filter(r => r.postcode).length;
  log(`Website coverage:  ${withWebsite}/${records.length} (${Math.round(withWebsite / records.length * 100)}%)`);
  log(`Postcode coverage: ${withPostcode}/${records.length} (${Math.round(withPostcode / records.length * 100)}%)`);

  // Write temp CSV and call import.js
  const tempFile = path.join(os.tmpdir(), `soterius-fca-${Date.now()}.csv`);
  try {
    fs.writeFileSync(tempFile, recordsToCSV(records), 'utf8');

    const importStats = await importModule.run({
      file:      tempFile,
      dryRun,
      regulator: 'FCA',
    });

    if (importStats) {
      const noWebsite = records.length - withWebsite;
      console.log(`\n${'═'.repeat(60)}`);
      console.log(` FCA FEED COMPLETE`);
      console.log(`${'═'.repeat(60)}`);
      console.log(`  Source file      : ${path.basename(filePath)}`);
      console.log(`  FCA records      : ${rows.length.toLocaleString()} total in file`);
      console.log(`  Active firms     : ${records.length.toLocaleString()} processed`);
      console.log(`  Inserted         : ${importStats.inserted}`);
      console.log(`  Skipped (exists) : ${importStats.skipped}`);
      console.log(`  Errors           : ${importStats.errors}`);
      if (noWebsite > 0) {
        console.log(`  Pending enrich   : ${noWebsite} (no website in FCA CSV)`);
      }
      console.log(`${'═'.repeat(60)}\n`);
    }

    return importStats;
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args            = process.argv.slice(2);
  const get             = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const file            = get('--file');
  const limitRaw        = get('--limit');
  const dryRun          = args.includes('--dry-run');
  const includeInactive = args.includes('--include-inactive');
  const limit           = limitRaw ? parseInt(limitRaw, 10) : 0;

  run({ file, limit, dryRun, includeInactive }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
