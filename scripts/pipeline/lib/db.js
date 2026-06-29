'use strict';
/**
 * Pipeline-specific Supabase helpers.
 * Wraps the shared getClient() from services/database.js with pipeline operations.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');

let _client;
function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    _client = createClient(url, key);
  }
  return _client;
}

// ── Pipeline status ───────────────────────────────────────────────────────────

/**
 * Transition a prospect to a new pipeline_status.
 * Optionally set additional fields (e.g. validation_status, rescan_due_at).
 */
async function updatePipelineStatus(id, status, extra = {}) {
  const { error } = await getClient()
    .from('prospects')
    .update({ pipeline_status: status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id);
  if (error) throw new Error(`updatePipelineStatus(${id}) → ${error.message}`);
}

/**
 * Append a flag object to the prospect's pipeline_flags JSONB array.
 * flag = { code: 'LOW_SCORE', detail: '...', ts: '...' }
 */
async function appendFlag(id, flag) {
  const { data: row, error: fetchErr } = await getClient()
    .from('prospects')
    .select('pipeline_flags')
    .eq('id', id)
    .single();
  if (fetchErr) throw new Error(`appendFlag fetch(${id}): ${fetchErr.message}`);

  const existing = Array.isArray(row?.pipeline_flags) ? row.pipeline_flags : [];
  const updated  = [...existing, { ...flag, ts: flag.ts || new Date().toISOString() }];

  const { error } = await getClient()
    .from('prospects')
    .update({ pipeline_flags: updated, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`appendFlag update(${id}): ${error.message}`);
}

// ── Latest scan per prospect ──────────────────────────────────────────────────

/**
 * Returns the most recent scan row for a given prospect_id, or null.
 */
async function getLatestScan(prospectId) {
  const { data, error } = await getClient()
    .from('scans')
    .select('*')
    .eq('prospect_id', prospectId)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestScan(${prospectId}): ${error.message}`);
  return data;
}

// ── Bulk prospect queries ─────────────────────────────────────────────────────

async function getProspectsByStatus(status) {
  const PAGE_SIZE = 1000;
  let all  = [];
  let from = 0;
  while (true) {
    const { data, error } = await getClient()
      .from('prospects')
      .select('*')
      .eq('pipeline_status', status)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`getProspectsByStatus(${status}): ${error.message}`);
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function getProspectsForRescan() {
  const PAGE_SIZE = 1000;
  const now = new Date().toISOString();
  let all  = [];
  let from = 0;
  while (true) {
    const { data, error } = await getClient()
      .from('prospects')
      .select('*')
      .eq('pipeline_status', 'scan_due')
      .lte('rescan_due_at', now)
      .order('rescan_due_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`getProspectsForRescan: ${error.message}`);
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function getAllProspects() {
  const PAGE_SIZE = 1000;
  let all  = [];
  let from = 0;
  while (true) {
    const { data, error } = await getClient()
      .from('prospects')
      .select('*')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`getAllProspects: ${error.message}`);
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

module.exports = {
  getClient,
  updatePipelineStatus,
  appendFlag,
  getLatestScan,
  getProspectsByStatus,
  getProspectsForRescan,
  getAllProspects,
};
