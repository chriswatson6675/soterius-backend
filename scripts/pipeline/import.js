'use strict';
/**
 * Pipeline Stage 1 — Prospect Acquisition
 *
 * Imports firms from a CSV file into the prospects table.
 * Normalises domains, skips existing records, flags potential name duplicates.
 *
 * CSV columns (required): firm_name
 * CSV columns (optional): website, sector, location, source, source_date, source_reference,
 *                          firm_confidence, domain_confidence, notes,
 *                          regulator, regulator_id, town, county, country, active_status
 *
 * Usage:
 *   node scripts/pipeline/import.js --file path/to/firms.csv [--dry-run] [--regulator NAME]
 *
 * Exports run(options) for use by feed scripts.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const { log, warn, error } = require('./lib/log');
const { normaliseDomain, normaliseFirmName, levenshtein } = require('./lib/domain');
const { getClient, updatePipelineStatus } = require('./lib/db');

// ── CSV parsing (no external dependency — handle quoted fields manually) ──────

function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = splitCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()]));
    });
}

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

// ── Known authoritative sources — get a higher baseline firm confidence ───────
const REGISTER_SOURCES = ['sra-register', 'fca-register', 'icaew-register', 'acca-register', 'rics-register', 'ofs-register'];

function computeFirmConfidence(row, nameTooClose) {
  if (row.firm_confidence && !isNaN(parseInt(row.firm_confidence, 10))) {
    return Math.min(100, Math.max(0, parseInt(row.firm_confidence, 10)));
  }
  if (nameTooClose)                                    return 70;
  if (REGISTER_SOURCES.includes(row.source || ''))     return 95;
  return 90;
}

function computeDomainConfidence(row) {
  if (row.domain_confidence && !isNaN(parseInt(row.domain_confidence, 10))) {
    return Math.min(100, Math.max(0, parseInt(row.domain_confidence, 10)));
  }
  return row.website ? 95 : 0;
}

// ── Postcode helpers ──────────────────────────────────────────────────────────

// Column names accepted as postcode input from CSV.
const POSTCODE_COLUMNS = ['postcode', 'post_code', 'postal_code', 'address_postcode'];

const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s[0-9][A-Z]{2}$/;

function normalisePostcode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (stripped.length < 5) return null;
  const normalised = stripped.slice(0, -3) + ' ' + stripped.slice(-3);
  return UK_POSTCODE_RE.test(normalised) ? normalised : null;
}

function extractPostcodeFromRow(row) {
  for (const col of POSTCODE_COLUMNS) {
    const pc = normalisePostcode(row[col]);
    if (pc) return pc;
  }
  return null;
}

// ── Regulator ID extraction ───────────────────────────────────────────────────

const REGULATOR_ID_COLUMNS = [
  'regulator_id', 'sra_id', 'sra_number', 'sra_firm_id', 'authorisation_number',
  'fca_frn', 'frn', 'firm_reference_number', 'firm_reference',
  'icaew_number', 'acca_number', 'rics_number',
  'membership_number', 'member_id', 'register_id', 'register_reference',
];

function extractRegulatorId(row) {
  for (const col of REGULATOR_ID_COLUMNS) {
    if (row[col] && row[col].trim()) return row[col].trim();
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run({ file, dryRun = false, regulator: regulatorFlag = null } = {}) {
  if (!file) throw new Error('--file <path> is required');

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  log(`Importing from ${filePath}${dryRun ? ' (dry-run)' : ''}`);

  const content = fs.readFileSync(filePath, 'utf8');
  const rows    = parseCSV(content);

  if (!rows.length) { warn('CSV is empty or has no data rows'); return; }

  const required = ['firm_name'];
  const missing  = required.filter(h => !(h in rows[0]));
  if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);

  const supabase = getClient();

  const { data: existing, error: fetchErr } = await supabase
    .from('prospects')
    .select('id, firm_name, website, regulator, regulator_id');
  if (fetchErr) throw new Error(`Failed to fetch existing prospects: ${fetchErr.message}`);

  const existingDomains = new Set(
    (existing || []).filter(p => p.website).map(p => p.website.toLowerCase())
  );
  const existingRegIds = new Set(
    (existing || []).filter(p => p.regulator && p.regulator_id).map(p => `${p.regulator}:${p.regulator_id}`)
  );
  const existingNames = (existing || []).map(p => normaliseFirmName(p.firm_name));

  const stats = { total: rows.length, skipped: 0, inserted: 0, flagged: 0, errors: 0 };

  for (const row of rows) {
    const domain      = normaliseDomain(row.website);
    const firmName    = row.firm_name.trim();
    const regulator   = row.regulator   || regulatorFlag || null;
    const regulatorId = extractRegulatorId(row);
    const regKey      = regulator && regulatorId ? `${regulator}:${regulatorId}` : null;

    // Primary dedup for register imports: (regulator, regulator_id) pair
    if (regKey && existingRegIds.has(regKey)) {
      warn(`Skip (regulator_id exists): ${regKey} (${firmName})`);
      stats.skipped++;
      continue;
    }

    // Domain dedup: only when a domain is present
    if (domain && existingDomains.has(domain)) {
      warn(`Skip (domain exists): ${domain}`);
      stats.skipped++;
      continue;
    }

    // Fuzzy name duplicate check
    const normName     = normaliseFirmName(firmName);
    const nameTooClose = existingNames.find(n => n && levenshtein(normName, n) <= 2 && normName.length > 3);
    if (nameTooClose) {
      warn(`Possible duplicate name: "${firmName}" ≈ existing "${nameTooClose}" — will import with flag`);
    }

    const postcode   = extractPostcodeFromRow(row);
    const sourceDate = row.source_date || new Date().toISOString().slice(0, 10);
    const hasWebsite = !!domain;

    const record = {
      firm_name:           firmName,
      website:             domain || null,
      sector:              row.sector            || null,
      location:            row.location          || null,
      source:              row.source            || 'csv-import',
      source_date:         sourceDate,
      source_reference:    row.source_reference  || null,
      firm_confidence:     computeFirmConfidence(row, nameTooClose),
      domain_confidence:   computeDomainConfidence(row),
      postcode:            postcode,
      postcode_source:     postcode ? 'csv'  : null,
      postcode_confidence: postcode ? 98     : null,
      notes:               row.notes             || null,
      pipeline_status:     hasWebsite ? 'pending_validate' : 'pending_enrichment',
      pipeline_flags:      nameTooClose
        ? [{ code: 'POSSIBLE_DUPLICATE_NAME', detail: `Name close to existing: "${nameTooClose}"`, ts: new Date().toISOString() }]
        : [],
      regulator:           regulator,
      regulator_id:        regulatorId,
      town:                row.town    || null,
      county:              row.county  || null,
      country:             row.country || null,
      active_status:       row.active_status || 'active',
      first_discovered_at: new Date(sourceDate).toISOString(),
    };

    if (dryRun) {
      log(`[dry-run] Would insert: ${domain || '(no website)'} (${firmName}) firm:${record.firm_confidence} domain:${record.domain_confidence}${postcode ? ` postcode:${postcode}` : ''}${regKey ? ` [${regKey}]` : ''}`);
      if (nameTooClose) stats.flagged++;
      stats.inserted++;
      if (domain) existingDomains.add(domain);
      if (regKey)  existingRegIds.add(regKey);
      existingNames.push(normName);
      continue;
    }

    const { error: insertErr } = await supabase
      .from('prospects')
      .insert([record]);

    if (insertErr) {
      if (insertErr.code === '23505') {
        warn(`Skip (race-duplicate): ${domain || regulatorId}`);
        stats.skipped++;
      } else {
        error(`Insert failed for ${domain || firmName}: ${insertErr.message}`);
        stats.errors++;
      }
    } else {
      log(`Inserted: ${domain || '(no website)'} (${firmName}) firm:${record.firm_confidence} domain:${record.domain_confidence}${postcode ? ` postcode:${postcode}` : ''}${regKey ? ` [${regKey}]` : ''}${nameTooClose ? ' [POSSIBLE_DUPLICATE_NAME]' : ''}`);
      if (nameTooClose) stats.flagged++;
      stats.inserted++;
      if (domain) existingDomains.add(domain);
      if (regKey)  existingRegIds.add(regKey);
      existingNames.push(normName);
    }
  }

  log(`Import complete — total: ${stats.total}, inserted: ${stats.inserted}, skipped: ${stats.skipped}, flagged: ${stats.flagged}, errors: ${stats.errors}`);
  return stats;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args      = process.argv.slice(2);
  const get       = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const fileIdx   = args.indexOf('--file');
  const file      = fileIdx !== -1 ? args[fileIdx + 1] : args[0];
  const dryRun    = args.includes('--dry-run');
  const regulator = get('--regulator') || null;

  run({ file, dryRun, regulator }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
