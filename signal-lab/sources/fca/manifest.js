'use strict';

// manifest.js — collection manifest for an FCA run.
//
// Reference Collector v0.1 — PHASE 4 (IMP-FCA-001 §4; CCS-FCA-001 §15).
//
// The manifest DESCRIBES the collection (identity, versions, anchor, timing,
// endpoint/artefact tallies). It must NOT summarise or interpret the EVIDENCE:
// it carries counts about the collection process only — never anything derived
// from, or asserting meaning about, the firm's data [CR-FCA-01].
//
// Authority: CCS-FCA-001 §15; CCD-FCA-001 CR-FCA-01/10; IMP-FCA-001 §4.

const fs = require('node:fs');
const { manifestPath } = require('./evidence-path');

/**
 * Build a manifest object from run metadata and a Preserve tally.
 * @param {Object} meta - { runId, collectorVersion, apiVersion, family, anchor, scope, executionStart, executionEnd }
 * @param {Object} tally - from preserve.js (endpointsAttempted, endpointsPreserved, pagesPreserved, transportErrors, artefacts)
 */
function buildManifest(meta, tally) {
  return {
    artefactType: 'fca-collection-manifest',
    note: 'Describes the collection. Does NOT summarise or interpret the evidence.',
    runId: meta.runId ?? null,
    collectorVersion: meta.collectorVersion ?? null,
    apiVersion: meta.apiVersion ?? null,
    family: meta.family ?? null,
    anchor: meta.anchor ?? null,
    scope: meta.scope ?? null,
    executionStart: meta.executionStart ?? null,
    executionEnd: meta.executionEnd ?? null,
    endpointsAttempted: tally ? tally.endpointsAttempted : 0,
    endpointsPreserved: tally ? tally.endpointsPreserved : 0,
    pagesPreserved: tally ? tally.pagesPreserved : 0,
    transportErrors: tally ? tally.transportErrors : 0,
    artefacts: tally ? tally.artefacts : [],
  };
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
  return manifestPath(dir);
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
}

module.exports = { buildManifest, writeManifest, readManifest };
