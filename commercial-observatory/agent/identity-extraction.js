'use strict';

// Deterministic identity extraction (Part 1) — turns an already-fetched,
// already-preserved page into structured identity findings. Two sources:
//
//   1. A genuine Companies House "company overview" page (fetched directly,
//      e.g. surfaced via search — not only via the companies_house_lookup
//      tool, which requires an exact name match the register's own legal
//      form frequently defeats, e.g. "Compliance Office" vs "THE
//      COMPLIANCE OFFICE LTD").
//   2. A first-party page's own explicit legal-name self-statement (e.g. a
//      footer copyright line "© Compliance Office Ltd"), used ONLY as
//      corroboration for #1 — never accepted as identity on its own.
//
// Same "hold the conservative line" discipline as finding-extraction.js:
// no LLM, no inference beyond explicit phrasing. Identity carries higher
// stakes than any other finding category, so the match requirement here is
// intentionally the strictest in the module — a Companies House result is
// NEVER accepted merely for having a similar/generic name (per the task
// brief). Only an EXACT match, after normalising away legal-form noise
// (Ltd/Limited/The/&c. — authority/lib/normalise.js's normaliseName, the
// same normalisation the rest of Commercial Observatory already trusts
// for identity comparison), is treated as a defensible basis at all.

const { normaliseName } = require('../../authority/lib/normalise');

const CH_HOST = 'find-and-update.company-information.service.gov.uk';

const STATUS_VALUES = ['Active', 'Dissolved', 'Liquidation', 'In Administration', 'Administration', 'Voluntary Arrangement', 'Insolvency Proceedings', 'Converted/Closed', 'Receivership'];

const COMPANY_NUMBER_REGEX = /Company number\s+([0-9A-Za-z]{6,10})/;
const STATUS_REGEX = new RegExp(`Company status\\s+(${STATUS_VALUES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const TYPE_REGEX = /Company type\s+(.+?)\s+Incorporated on\b/i;
const INCORPORATED_REGEX = /Incorporated on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
const REGISTERED_OFFICE_REGEX = /Registered office address\s+(.+?)\s+Company status\b/i;

const COPYRIGHT_LEGAL_NAME_REGEX = /©\s*([A-Z][A-Za-z0-9&.,'-]+(?:\s+[A-Za-z0-9&.,'-]+){0,4}\s+(?:Ltd|Limited|LLP|plc|PLC))\b/;

function cleanExcerpt(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function evidencePreviewFor(sourceUrl, excerpt) {
  return `${sourceUrl} — "${excerpt.slice(0, 120)}${excerpt.length > 120 ? '…' : ''}"`;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// authority/lib/normalise.js's normaliseName only strips a trailing "THE"
// (it is shared, system-wide identity-matching code this module must not
// alter) — but a company's registered legal form very often carries a
// LEADING "The" ("THE COMPLIANCE OFFICE LTD") that the target's own
// trading name omits ("Compliance Office"). Stripped locally, on top of
// the shared normalisation, only for this module's own comparison.
function normaliseForIdentityMatch(name) {
  const normalised = normaliseName(name);
  return normalised ? normalised.replace(/^THE\s+/, '').trim() : null;
}

/** Is this a genuine Companies House company-overview page (not just any gov.uk page)? */
function isCompaniesHouseOverviewPage(sourceUrl) {
  const hostname = hostnameOf(sourceUrl);
  if (hostname !== CH_HOST) return false;
  try { return new URL(sourceUrl).pathname.startsWith('/company/'); } catch { return false; }
}

function companyNumberFromUrl(sourceUrl) {
  try {
    const match = new URL(sourceUrl).pathname.match(/\/company\/([0-9A-Za-z]{6,10})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Scans a fetched page for an explicit first-party legal-name statement
 * (footer copyright line). Used only as CORROBORATION for a Companies
 * House match, never as identity evidence on its own.
 */
function extractLegalNameCorroboration(page, { sourceUrl, evidenceId } = {}) {
  const haystack = `${page?.visibleText || ''} ${page?.footerText || ''}`;
  const match = COPYRIGHT_LEGAL_NAME_REGEX.exec(haystack);
  if (!match) return null;
  const value = cleanExcerpt(match[1]);
  return {
    category: 'identity', field: 'legalNameCorroboration', value, sourceUrl, evidenceId,
    contextExcerpt: cleanExcerpt(match[0]), evidencePreview: evidencePreviewFor(sourceUrl, match[0]),
    confidence: 'medium', reason: 'First-party copyright/footer legal-name statement.',
  };
}

/**
 * extractCompaniesHouseIdentity(page, opts) -> Finding[]
 *
 * opts: { sourceUrl, evidenceId, targetName, priorIdentityFindings }
 * `priorIdentityFindings`: findings.identity accumulated so far this run —
 * used only to look for a legalNameCorroboration finding that upgrades
 * confidence from 'medium' to 'high'.
 *
 * Returns [] (no findings at all) when the page is not a genuine Companies
 * House overview page, OR when the register's legal name does not exactly
 * match the target's name after normalisation — a "similar but not exact"
 * name is never accepted (the task's explicit requirement), not even at
 * low confidence.
 */
function extractCompaniesHouseIdentity(page, { sourceUrl, evidenceId, targetName, priorIdentityFindings = [] } = {}) {
  if (!isCompaniesHouseOverviewPage(sourceUrl)) return [];

  const headings = page?.headings || [];
  const h1 = headings.find((h) => h.level === 'h1');
  const titleFallback = (page?.title || '').replace(/\s+overview\s+-\s+Find and update company information\s+-\s+GOV\.UK\s*$/i, '');
  const legalName = cleanExcerpt(h1?.text || titleFallback);
  if (!legalName) return [];

  const normalisedChName = normaliseForIdentityMatch(legalName);
  const normalisedTarget = targetName ? normaliseForIdentityMatch(targetName) : null;
  if (!normalisedChName || !normalisedTarget || normalisedChName !== normalisedTarget) {
    // Not an exact match after normalisation — "similar generic name" is
    // exactly the failure mode this module must never accept. No identity
    // findings are produced from this page at all.
    return [];
  }

  const corroboration = priorIdentityFindings.find((f) => f.field === 'legalNameCorroboration' && normaliseForIdentityMatch(f.value) === normalisedChName);
  const confidence = corroboration ? 'high' : 'medium';
  const matchBasis = corroboration ? 'first_party_corroborated' : 'target_name_normalised_match';
  const corroboratingEvidenceIds = corroboration ? [corroboration.evidenceId] : [];

  const fullText = page?.visibleText || '';
  const findings = [];

  function push(field, value, contextExcerpt) {
    findings.push({
      category: 'identity', field, value, sourceUrl, evidenceId,
      contextExcerpt: cleanExcerpt(contextExcerpt), evidencePreview: evidencePreviewFor(sourceUrl, contextExcerpt),
      confidence, reason: 'Companies House register overview page.', matchBasis, corroboratingEvidenceIds,
    });
  }

  push('legalName', legalName, h1 ? h1.text : legalName);

  const numberMatch = COMPANY_NUMBER_REGEX.exec(fullText);
  const companyNumber = numberMatch ? numberMatch[1] : companyNumberFromUrl(sourceUrl);
  if (companyNumber) push('companyNumber', companyNumber, numberMatch ? numberMatch[0] : `Company number ${companyNumber}`);

  const statusMatch = STATUS_REGEX.exec(fullText);
  if (statusMatch) push('companyStatus', statusMatch[1], statusMatch[0]);

  const typeMatch = TYPE_REGEX.exec(fullText);
  if (typeMatch) push('companyType', cleanExcerpt(typeMatch[1]), typeMatch[0]);

  const incorporatedMatch = INCORPORATED_REGEX.exec(fullText);
  if (incorporatedMatch) push('incorporatedOn', incorporatedMatch[1], incorporatedMatch[0]);

  const registeredOfficeMatch = REGISTERED_OFFICE_REGEX.exec(fullText);
  if (registeredOfficeMatch) push('registeredOfficeAddress', cleanExcerpt(registeredOfficeMatch[1]), registeredOfficeMatch[0]);

  return findings;
}

module.exports = { extractCompaniesHouseIdentity, extractLegalNameCorroboration, isCompaniesHouseOverviewPage };
