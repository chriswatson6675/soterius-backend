'use strict';

// Conservative Material Change calculation — OBS-102. Compares only the
// signal-specific business fields of two Evidence (signal_facts_*) rows,
// excluding the shared envelope/bookkeeping columns every Evidence row
// carries (migrations 039/040) — a change in collected_at, collection_run_id,
// etc. is never itself a Material Change; only a genuine difference in the
// collector's own observed facts is.

const ENVELOPE_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'collected_at', 'domain',
  'collection_run_id', 'collection_programme_id', 'collector',
  'collector_version', 'collection_method', 'collection_outcome',
  'organisation_id', 'repository_authority_ref', 'run_id',
]);

function businessFields(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!ENVELOPE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * calculateMaterialChange(previousFactsRow, newFactsRow) → true | false | null
 *
 * null when there is no previous Evidence to compare against — the
 * first-ever observation is new knowledge, not itself "a change." Conservative
 * by construction: it never claims a change occurred against nothing, and it
 * only ever compares the collector's own observed fields, never bookkeeping.
 */
function calculateMaterialChange(previousFactsRow, newFactsRow) {
  if (!previousFactsRow) return null;
  const before = businessFields(previousFactsRow);
  const after = businessFields(newFactsRow);
  return JSON.stringify(before) !== JSON.stringify(after);
}

module.exports = { calculateMaterialChange, businessFields, ENVELOPE_FIELDS };
