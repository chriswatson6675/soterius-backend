'use strict';

// observatoryLookup.js — read access to Soterius's own Observatory signal data.
//
// The signal_quality_* tables (migrations 026-035) are the write side of the
// Observatory's national scanning runs (Signal Lab) — keyed by domain, one row
// per scoring run. This is the first READ path against them for the product:
// given a domain, return the latest scored row per signal, plus a rollup.
//
// Deliberately does not trigger a fresh scan when a domain has no rows — that's
// a separate (heavier, async) capability. This only reads what's already there.

const { getClient } = require('../../infra/database');
const { getGrade } = require('../../infra/utils/trust-score-bands');

const SIGNAL_TABLES = [
  { key: 'spf', table: 'signal_quality_spf', category: 'Email Trust' },
  { key: 'dkim', table: 'signal_quality_dkim', category: 'Email Trust' },
  { key: 'dmarc', table: 'signal_quality_dmarc', category: 'Email Trust' },
  { key: 'mtasts', table: 'signal_quality_mtasts', category: 'Email Trust' },
  { key: 'dnssec', table: 'signal_quality_dnssec', category: 'Domain Trust' },
  { key: 'caa', table: 'signal_quality_caa', category: 'Domain Trust' },
  { key: 'tls', table: 'signal_quality_tls', category: 'Certificate & TLS Trust' },
  { key: 'certificate', table: 'signal_quality_certificate', category: 'Certificate & TLS Trust' },
  { key: 'securitytxt', table: 'signal_quality_securitytxt', category: 'Disclosure' },
  { key: 'securityheaders', table: 'signal_quality_securityheaders', category: 'Disclosure' },
];

/**
 * Fetch the latest scored row per signal table for a domain.
 * @param {string} domain
 * @returns {Promise<Array<{key: string, category: string, observed: boolean, score?: number, label?: string|null, collectedAt?: string, error?: string}>>}
 */
async function getSignalsForDomain(domain) {
  const sb = getClient();
  return Promise.all(SIGNAL_TABLES.map(async (def) => {
    const { data, error } = await sb
      .from(def.table)
      .select('final_score, primary_label, collected_at')
      .eq('domain', domain)
      .order('collected_at', { ascending: false })
      .limit(1);

    if (error) return { key: def.key, category: def.category, observed: false, error: error.message };
    if (!data || !data.length) return { key: def.key, category: def.category, observed: false };

    return {
      key: def.key,
      category: def.category,
      observed: true,
      score: data[0].final_score,
      label: data[0].primary_label ?? null,
      collectedAt: data[0].collected_at,
    };
  }));
}

// Delegates to the one canonical threshold table (infra/utils/trust-score-
// bands.js, ADR-SYS-011 §"Canonical Presentation Model") instead of
// declaring a second, independently-cutoff ladder. Previously used its own
// 90/75/55/35 boundaries, which could disagree with getRiskBand's 90/75/60/40
// for the same score (regression audit finding C-5 — e.g. a score of 57 was
// simultaneously "High Risk" via the risk band and "C" via this function).
// Now aligned to the same 90/75/60/40 cutoffs, so a given score always
// produces a semantically consistent band and grade together.
const letterGrade = getGrade;

function summarize(signals) {
  const observed = signals.filter((s) => s.observed);
  const base = { signalsObserved: observed.length, signalsTotal: signals.length };
  if (!observed.length) return { ...base, overallScore: null, grade: null, categories: [] };

  const overallScore = Math.round(observed.reduce((sum, s) => sum + Number(s.score), 0) / observed.length);

  const byCategory = new Map();
  for (const s of observed) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }
  const categories = Array.from(byCategory.entries()).map(([category, items]) => ({
    category,
    averageScore: Math.round(items.reduce((a, s) => a + Number(s.score), 0) / items.length),
    signals: items.map(({ key, score, label, collectedAt }) => ({ key, score, label, collectedAt })),
  }));

  return { ...base, overallScore, grade: letterGrade(overallScore), categories };
}

/**
 * @param {string} domain
 * @returns {Promise<{ok: true, domain: string, overallScore: number|null, grade: string|null, signalsObserved: number, signalsTotal: number, categories: object[], source: string, fetchedAt: string} | {ok: false, error: string}>}
 */
async function getObservatoryProfile(domain) {
  if (!domain) return { ok: false, error: 'domain is required' };
  const signals = await getSignalsForDomain(domain);
  const summary = summarize(signals);
  return {
    ok: true,
    domain,
    ...summary,
    source: 'Soterius Observatory',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getObservatoryProfile, getSignalsForDomain, SIGNAL_TABLES, letterGrade };
