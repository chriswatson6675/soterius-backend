'use strict';

// Organisation Provider — SRA Organisation Registry
//
// Concrete Organisation Provider that supplies organisations from the SRA
// Organisation Registry (runs/sra/registry.ndjson — POP-SRA-001),
// derived from the sealed SRA Collection Package by the Population Acquisition Layer.
// By default it reads that registry; set SRA_REGISTRY_PATH to read an immutable
// snapshot instead (see resolveRegistryPath). Selected at runtime by the provider
// factory (if001-full/organisation-provider.js) via ORG_PROVIDER=sra.
//
// It satisfies the SAME Organisation Provider contract as the FCA and IF providers:
//   loadOrganisations() → {
//     cohort_id, cohort_name, selection_id, n,
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }
// Only `domain` is required by the scanners; the other fields are carried for
// reporting and provenance.
//
// Responsibility boundary: this provider ONLY supplies organisations. It contains no
// scanning, persistence, scoring or reporting logic, and no Observatory-specific
// behaviour. Mapping registry records onto the organisation structure is the whole of
// its job.
//
// Eligibility: the SRA Organisation Registry IS the eligible population — the
// Population Acquisition step (derive-sra-registry.js) admitted only organisations
// with a valid scannable domain, so inclusion in the registry is the eligibility
// record. The domain filter below is retained for parity with the FCA provider and is
// a no-op against a well-formed registry. No re-gating is performed.
//
// Ordering: registry NDJSON order (derivation order) is preserved among records.

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

// The SRA Organisation Registry produced by the Population Acquisition Layer — the
// default source when no snapshot is configured.
const REGISTRY_PATH = path.join(__dirname, 'runs', 'sra', 'registry.ndjson');

// Registry source selection — mirrors the FCA provider's FCA_REGISTRY_PATH. An
// Operational Execution should run against an immutable snapshot: set
// SRA_REGISTRY_PATH to the snapshot file. Absent/empty → the default registry.
function resolveRegistryPath() {
  const override = (process.env.SRA_REGISTRY_PATH ?? '').trim();
  return override.length > 0 ? override : REGISTRY_PATH;
}

const COHORT_ID   = 'SRA-REG-001';
const COHORT_NAME = 'SRA Organisation Registry';

// Domain normalisation — identical rules to the FCA provider / IF cohort selection so
// every provider emits domains in the same shape. The registry already stores a
// normalised domain; re-applying here is idempotent and keeps the boundary consistent.
function normaliseDomain(raw) {
  if (!raw) return null;
  return String(raw).toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

// Map one registry record onto the organisation structure the Observatory expects.
function recordToOrganisation(record) {
  return {
    id:           record.sraNumber != null ? String(record.sraNumber) : null, // SRA number — the SRA organisation id (analogue of FCA frn; string)
    firm_name:    record.firmName ?? null,
    domain:       normaliseDomain(record.domain),
    last_scanned: null,                                                         // SRA organisations have not been scanned by the Observatory
  };
}

// Deterministic selection id bound to the exact registry contents, so a given frozen
// registry always yields the same selection_id (no time/random input).
function selectionIdFor(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `sra-registry-${hash}`;
}

function loadOrganisations() {
  const registryPath = resolveRegistryPath();
  if (!fs.existsSync(registryPath)) {
    const err = new Error(`SRA Organisation Registry not found (${registryPath})`);
    err.code = 'SRA_REGISTRY_NOT_FOUND';
    throw err;
  }

  const raw   = fs.readFileSync(registryPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  const eligible = lines
    .map(l => JSON.parse(l))
    .map(recordToOrganisation)
    .filter(o => o.domain && o.domain.length > 0);   // parity with FCA; no-op against a well-formed registry

  // Optional commissioning sample (parity with the FCA provider's FCA_SAMPLE_N):
  // SRA_SAMPLE_N caps the population to a deterministic head sample (ordering
  // preserved). Default (unset/0) returns the full eligible population — no
  // behavioural change. Random sampling for an operational pilot is a separate
  // concern handled by the pilot, not the provider.
  const sampleN     = Number.parseInt(process.env.SRA_SAMPLE_N ?? '', 10);
  const sampled     = Number.isInteger(sampleN) && sampleN > 0 ? eligible.slice(0, sampleN) : eligible;
  const selectionId = sampled.length === eligible.length
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
