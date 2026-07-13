'use strict';

// Trust Profile store — ENG-014 WP-9 engineering decision (migration 047),
// constrained by the frozen architecture (ENG-023 §3/§9/§12, TI-CONST-001
// TI-P-4/TI-P-5/TI-P-8). Implements the current-resolution *contract*
// ENG-023 §12 already defines (latest generatedAt, or an honest "none yet"
// state) — this module owns no scoring, provenance, or assembly logic, and
// introduces no new architectural concept: it is the storage mechanism
// TI-P-8 explicitly reserves to a layer beneath the Constitution's own
// authority.
//
// Append-only: save() only ever INSERTs; there is no update()/delete() in
// this module's surface at all (TI-P-4/TI-P-5).

function getClient() {
  return require('../infra/database').getClient();
}

/**
 * save(instance, deps) — persists one Trust Profile Instance (ENG-023 §6's
 * nine fields), verbatim, as a new row. Never updates or overwrites an
 * existing row for the same Organisation.
 */
async function save(instance, deps = {}) {
  const client = deps.client || getClient();
  const { error } = await client.from('trust_profile_instances').insert({
    organisation_id: instance.organisationId,
    generated_at: instance.generatedAt,
    trigger: instance.trigger,
    instance,
  });
  if (error) throw new Error(`trust_profile_instances insert failed: ${error.message}`);
}

/**
 * getCurrent(organisationId, deps) → { exists: true, generatedAt, instance }
 *                                   | { exists: false }
 *
 * Implements ENG-023 §12's default resolution rule: the instance with the
 * latest generatedAt in the Organisation's History, or the honest "none
 * generated yet" state — never an error, never a default/zero instance.
 */
async function getCurrent(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('trust_profile_instances')
    .select('generated_at, instance')
    .eq('organisation_id', organisationId)
    .order('generated_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`trust_profile_instances read failed: ${error.message}`);
  if (!data || !data.length) return { exists: false };
  return { exists: true, generatedAt: data[0].generated_at, instance: data[0].instance };
}

/**
 * getHistory(organisationId, deps) → Array<{ generatedAt, instance }>
 * ordered oldest-first (ENG-023 §11's Trust Profile History definition).
 */
async function getHistory(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('trust_profile_instances')
    .select('generated_at, instance')
    .eq('organisation_id', organisationId)
    .order('generated_at', { ascending: true });

  if (error) throw new Error(`trust_profile_instances history read failed: ${error.message}`);
  return (data || []).map((row) => ({ generatedAt: row.generated_at, instance: row.instance }));
}

module.exports = { save, getCurrent, getHistory };
