'use strict';

// sraLookup.js — read access to SRA firm data from the local sealed snapshot.
//
// IMPORTANT — this is NOT a live per-firm API call. The SRA Firm Data Web
// Service (see collection/sources/sra/sra-client.js) is a bulk "GetAll" feed,
// refreshed roughly every 24h by SRA — there is no live single-firm lookup
// endpoint to call per request. The Signal Lab has already sealed a full
// register snapshot to disk (collection/sources/sra/runs/<runId>/raw/snapshot.json,
// ~25k firms). This module loads the most recent one into memory once per
// process and serves fast in-process lookups against it.
//
// Practical effect: results are only as fresh as the last snapshot re-acquisition
// (`node backend/authority/reacquire-sra.js`), not real-time. Every response
// carries `asOf` — the snapshot's collection timestamp — so callers can show
// that honestly rather than implying a live check.

const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(__dirname, '..', '..', 'collection', 'sources', 'sra', 'runs');

let cache = null; // { firms, byNumber: Map, collectedAt, sourcePath, error }

function findLatestSnapshotPath() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const candidates = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(RUNS_DIR, d.name, 'raw', 'snapshot.json'))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function loadSnapshot() {
  if (cache) return cache;

  const snapshotPath = process.env.SRA_SNAPSHOT_PATH || findLatestSnapshotPath();
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    cache = { firms: [], byNumber: new Map(), collectedAt: null, sourcePath: null, error: 'No local SRA snapshot found — run node backend/authority/reacquire-sra.js' };
    return cache;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    cache = { firms: [], byNumber: new Map(), collectedAt: null, sourcePath: snapshotPath, error: `Failed to parse snapshot: ${e.message}` };
    return cache;
  }

  const firms = Array.isArray(raw.Organisations) ? raw.Organisations : [];
  const byNumber = new Map();
  for (const f of firms) {
    if (f && f.SraNumber != null) byNumber.set(String(f.SraNumber), f);
  }
  const collectedAt = fs.statSync(snapshotPath).mtime.toISOString();

  cache = { firms, byNumber, collectedAt, sourcePath: snapshotPath, error: null };
  return cache;
}

function normalizeFirm(f) {
  const offices = Array.isArray(f.Offices) ? f.Offices : [];
  const principal = offices.find((o) => o.OfficeType === 'HO') || offices[0] || {};
  return {
    sraNumber: f.SraNumber != null ? String(f.SraNumber) : null,
    name: f.PracticeName || null,
    tradingNames: f.TradingNames || null,
    organisationType: f.OrganisationType || null,
    authorisationType: f.AuthorisationType || null,
    authorisationStatus: f.AuthorisationStatus || null,
    authorisationDate: f.AuthorisationDate || null,
    constitution: f.Constitution || null,
    companiesHouseNumber: f.CompanyRegNo || null,
    numberOfOffices: f.NoOfOffices != null ? f.NoOfOffices : offices.length,
    principalOffice: {
      name: principal.Name || null,
      address1: principal.Address1 || null,
      address2: principal.Address2 || null,
      town: principal.Town || null,
      postcode: principal.Postcode || null,
      country: principal.Country || null,
      phone: principal.PhoneNumber || null,
      email: principal.Email || null,
      website: principal.Website || null,
    },
    offices: offices.map((o) => ({
      name: o.Name || null,
      address1: o.Address1 || null,
      town: o.Town || null,
      postcode: o.Postcode || null,
      officeType: o.OfficeType || null,
    })),
  };
}

/**
 * @param {string|number} sraNumber
 * @returns {{ok: true, firm: object, asOf: string, source: string} | {ok: false, error: string}}
 */
function findBySraNumber(sraNumber) {
  const { byNumber, collectedAt, error, sourcePath } = loadSnapshot();
  if (error) return { ok: false, error };
  const match = byNumber.get(String(sraNumber));
  if (!match) return { ok: false, error: `SRA number ${sraNumber} not found in snapshot (as of ${collectedAt})` };
  return { ok: true, firm: normalizeFirm(match), asOf: collectedAt, source: `SRA register (local snapshot, ${path.basename(path.dirname(path.dirname(sourcePath)))})` };
}

/**
 * Substring match on practice name (case-insensitive). Linear scan — fine at ~25k rows.
 * @param {string} query
 * @returns {{ok: true, results: object[], asOf: string} | {ok: false, error: string}}
 */
function searchByName(query, { limit = 8 } = {}) {
  const { firms, collectedAt, error } = loadSnapshot();
  if (error) return { ok: false, error };
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [], asOf: collectedAt };

  const results = [];
  for (const f of firms) {
    const name = (f.PracticeName || '').toLowerCase();
    if (name.includes(q)) {
      results.push(normalizeFirm(f));
      if (results.length >= limit) break;
    }
  }
  return { ok: true, results, asOf: collectedAt, source: 'SRA register (local snapshot)' };
}

/** Diagnostic: what snapshot is currently loaded, and how many firms it has. */
function snapshotInfo() {
  const { collectedAt, sourcePath, error, firms } = loadSnapshot();
  return { collectedAt, sourcePath, error, firmCount: firms ? firms.length : 0 };
}

/**
 * Every firm in the snapshot, normalized. Used by the Organisation layer's
 * identity index (organisation/resolve.js) to compute a canonical id per firm
 * without a persisted store — still just an observation read, not an
 * interpretation, so this stays within the adapter's OC-1 remit.
 * @returns {{ok: true, firms: object[], asOf: string} | {ok: false, error: string}}
 */
function listAll() {
  const { firms, collectedAt, error } = loadSnapshot();
  if (error) return { ok: false, error };
  return { ok: true, firms: firms.map(normalizeFirm), asOf: collectedAt };
}

module.exports = { findBySraNumber, searchByName, snapshotInfo, listAll };
