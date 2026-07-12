'use strict';

// renewalSubmissions.js — Renewal-owned submission state (ADR-SYS-010 OC-7).
// Deliberately not in infra/database.js: that module holds cross-cutting
// domain functions; renewal_submissions belongs to one Experience only, and
// keeping its access here makes that ownership visible rather than implicit.

const { getClient } = require('../../infra/database');

async function createSubmission(organisationId, cycleYear) {
  const { data, error } = await getClient()
    .from('renewal_submissions')
    .insert([{ organisation_id: organisationId, cycle_year: cycleYear }])
    .select('*')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, submission: data };
}

async function getSubmission(id) {
  const { data, error } = await getClient()
    .from('renewal_submissions')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, submission: data };
}

async function updateAnswers(id, answersPatch) {
  const existing = await getSubmission(id);
  if (!existing.ok) return existing;
  const merged = { ...existing.submission.answers, ...answersPatch };
  const { data, error } = await getClient()
    .from('renewal_submissions')
    .update({ answers: merged, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, submission: data };
}

module.exports = { createSubmission, getSubmission, updateAnswers };
