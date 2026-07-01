'use strict';

// Organisation Provider — FCA Organisation Registry
//
// Concrete Organisation Provider that supplies organisations from the FCA
// Organisation Registry produced by the Population Acquisition Layer. By default it
// reads the live registry (runs/fca/registry.ndjson); set
// FCA_REGISTRY_PATH to read an immutable snapshot instead (see resolveRegistryPath).
// Selected at runtime by the provider factory (acquisition/providers/organisation-provider.js).
//
// It satisfies the same Organisation Provider contract as the IF provider:
//   loadOrganisations() → {
//     cohort_id, cohort_name, selection_id, n,
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }
// Only `domain` is required by the scanners; the other fields are carried for
// reporting and provenance.
//
// Responsibility boundary: this provider ONLY supplies organisations. It contains
// no scanning, persistence, scoring or reporting logic, and no Observatory-specific
// behaviour. Mapping registry records onto the organisation structure is the whole
// of its job.
//
// Eligibility: the registry is the population the Population Acquisition Layer
// admitted (its authorised-status gate decided admission at acquisition time —
// inclusion in the registry IS the eligibility record). The one scanning-eligibility
// fact the registry carries per record is the firm's Website Address: a record with
// no resolvable website cannot be scanned, so such records are excluded here. No
// authorisation re-gating is performed — that would second-guess the registry.
//
// Ordering: registry NDJSON order (acquisition order) is preserved among the
// eligible records.

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

// The live Organisation Registry the Population Acquisition Layer appends to — the
// default source when no snapshot is configured.
const REGISTRY_PATH = path.join(__dirname, '..', 'runs', 'fca', 'registry.ndjson');

// Registry source selection. An Operational Execution should run against an
// immutable snapshot so continuous acquisition need not stop: set FCA_REGISTRY_PATH
// to the snapshot file. Absent or empty → the live registry (unchanged default
// behaviour). Selection of the source is the only thing this controls; the
// provider contract, mapping, eligibility, and ordering are identical regardless.
function resolveRegistryPath() {
  const override = (process.env.FCA_REGISTRY_PATH ?? '').trim();
  return override.length > 0 ? override : REGISTRY_PATH;
}

const COHORT_ID   = 'FCA-REG-001';
const COHORT_NAME = 'FCA Organisation Registry';

// Domain normalisation — identical rules to the IF cohort selection
// (if001-full/select-cohort.js) so both providers emit domains in the same shape.
function normaliseDomain(raw) {
  if (!raw) return null;
  return raw.toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

// A registry record carries one or more FCA addresses under `firm.address`. The
// firm's website is recorded on its addresses; prefer the Principal Place of
// Business, then fall back to the first address that records a website.
function extractWebsite(record) {
  const addresses = Array.isArray(record['firm.address']) ? record['firm.address'] : [];
  const hasSite   = (a) => a && String(a['Website Address'] || '').trim().length > 0;
  const ppob      = addresses.find(a => hasSite(a) && /principal place of business/i.test(a['Address Type'] || ''));
  const fallback  = addresses.find(hasSite);
  const chosen    = ppob || fallback;
  return chosen ? chosen['Website Address'] : '';
}

// Map one registry record onto the organisation structure the Observatory expects.
function recordToOrganisation(record) {
  const firm = (Array.isArray(record.firm) && record.firm[0]) ? record.firm[0] : {};
  return {
    id:           record.frn,                                  // FCA Firm Reference Number — the FCA organisation id
    firm_name:    firm['Organisation Name'] || null,
    domain:       normaliseDomain(extractWebsite(record)),
    last_scanned: null,                                        // FCA organisations have not been scanned by the Observatory
  };
}

// Deterministic selection id bound to the exact registry contents, so a given
// frozen registry always yields the same selection_id (no time/random input).
function selectionIdFor(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `fca-registry-${hash}`;
}

function loadOrganisations() {
  const registryPath = resolveRegistryPath();
  if (!fs.existsSync(registryPath)) {
    const err = new Error(`FCA Organisation Registry not found (${registryPath})`);
    err.code = 'FCA_REGISTRY_NOT_FOUND';
    throw err;
  }

  const raw   = fs.readFileSync(registryPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  const eligible = lines
    .map(l => JSON.parse(l))
    .map(recordToOrganisation)
    .filter(o => o.domain && o.domain.length > 0);   // exclude records not eligible for scanning (no website/domain)

  // Optional commissioning sample: FCA_SAMPLE_N caps the population to a small,
  // deterministic head sample (ordering preserved) so the Observatory can be
  // exercised end-to-end without scanning the whole registry. Default (unset/0)
  // returns the full eligible population — no behavioural change.
  const sampleN       = Number.parseInt(process.env.FCA_SAMPLE_N ?? '', 10);
  const sampled       = Number.isInteger(sampleN) && sampleN > 0 ? eligible.slice(0, sampleN) : eligible;
  const selectionId   = sampled.length === eligible.length
    ? selectionIdFor(raw)
    : `${selectionIdFor(raw)}-sample${sampled.length}`;

  return {
    cohort_id:     COHORT_ID,
    cohort_name:   COHORT_NAME,
    selection_id:  selectionId,
    n:             sampled.length,
    organisations: sampled,
  };
}

module.exports = { loadOrganisations, REGISTRY_PATH, resolveRegistryPath };
