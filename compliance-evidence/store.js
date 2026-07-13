'use strict';

// Compliance Evidence store — Compliance Advisor MVP (Compliance Evidence
// architecture review, 2026-07-13). Deliberately lives outside
// backend/trust-intelligence/: this is Experience-layer (ADR-SYS-010)
// bookkeeping about an adviser's own workflow action, never a claim about
// an Organisation or a second evidence pipeline — it only ever reads
// backend/trust-intelligence/store.js's already-computed current instance
// to cite which snapshot a review was against (RD-1/RD-3-adjacent
// discipline, applied to this capability by analogy).
//
// Append-only: recordEvent() only ever INSERTs; there is no update()/
// delete() in this module's surface (mirrors trust-intelligence/store.js's
// own save()-only discipline). The table itself additionally enforces this
// at the database level (migration 049's triggers) — belt and braces.

function getClient() {
  return require('../infra/database').getClient();
}

/**
 * recordEvent({ organisationId, customerId, reviewedByUserId,
 *   trustProfileGeneratedAt, type, note }, deps) — persists one Compliance
 * Evidence Event. `type` defaults to 'review_completed' (the only value
 * this MVP ever writes — the column exists for future extension, RD-8-style
 * versioning discipline applied to this capability).
 */
async function recordEvent(event, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('compliance_evidence_events')
    .insert({
      organisation_id: event.organisationId,
      customer_id: event.customerId,
      reviewed_by_user_id: event.reviewedByUserId,
      trust_profile_generated_at: event.trustProfileGeneratedAt ?? null,
      type: event.type || 'review_completed',
      note: event.note ?? null,
    })
    .select('id, organisation_id, customer_id, reviewed_by_user_id, reviewed_at, trust_profile_generated_at, type, note')
    .single();

  if (error) throw new Error(`compliance_evidence_events insert failed: ${error.message}`);
  return toEventShape(data);
}

/**
 * getEvents(organisationId, deps) → Array<Event>, newest-first — the full
 * audit trail for one organisation (GET .../compliance-activity).
 */
async function getEvents(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('compliance_evidence_events')
    .select('id, organisation_id, customer_id, reviewed_by_user_id, reviewed_at, trust_profile_generated_at, type, note')
    .eq('organisation_id', organisationId)
    .order('reviewed_at', { ascending: false });

  if (error) throw new Error(`compliance_evidence_events read failed: ${error.message}`);
  return (data || []).map(toEventShape);
}

/**
 * getLastReviewedAt(organisationId, deps) → ISO timestamp string | null.
 * A pure, bounded read (LIMIT 1) — the derived value the Review Queue/
 * portfolio "due" indicator is computed from, never itself stored
 * (mirrors change-indicator.js's "derive at read time" discipline).
 */
async function getLastReviewedAt(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('compliance_evidence_events')
    .select('reviewed_at')
    .eq('organisation_id', organisationId)
    .order('reviewed_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`compliance_evidence_events last-reviewed read failed: ${error.message}`);
  if (!data || !data.length) return null;
  return data[0].reviewed_at;
}

function toEventShape(row) {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    customerId: row.customer_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    trustProfileGeneratedAt: row.trust_profile_generated_at,
    type: row.type,
    note: row.note,
  };
}

module.exports = { recordEvent, getEvents, getLastReviewedAt };
