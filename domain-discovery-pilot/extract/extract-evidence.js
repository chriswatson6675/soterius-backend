'use strict';

// extract-evidence.js — deterministic evidence extraction from an already
// html-extract'd page ({ title, visibleText, jsonLd, footerText, ... }).
// No LLM, no heuristics beyond fixed regex/keyword rules.

const { normaliseName } = require('../../authority/lib/normalise');

const COMPANY_NUMBER_NEAR_RE = /(company\s*(?:registration\s*)?number|company\s*no\.?|registration\s*number)[^0-9]{0,20}(\d{6,8})/i;
const POSTCODE_RE = /\b([A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2})\b/i;
const PHONE_RE = /\b(?:\+44\s?|0)(?:\d[\s-]?){9,10}\b/;
const STREET_KEYWORD_RE = /\b(STREET|ROAD|AVENUE|LANE|WAY|SQUARE|PLACE|COURT)\b/i;

function extractCompanyNumber(visibleText, jsonLd) {
  const m = COMPANY_NUMBER_NEAR_RE.exec(visibleText || '');
  if (m) return m[2];
  for (const node of jsonLd || []) {
    const type = node['@type'];
    const isOrg = type === 'Organization' || (Array.isArray(type) && type.includes('Organization'));
    if (isOrg && node.identifier) {
      const idStr = typeof node.identifier === 'string' ? node.identifier : (node.identifier.value || null);
      const digitsOnly = idStr ? String(idStr).replace(/\D/g, '') : null;
      if (digitsOnly && digitsOnly.length >= 6 && digitsOnly.length <= 8) return digitsOnly;
    }
  }
  return null;
}

function extractLegalOrTradingName(candidateName, page) {
  const candidateTokens = new Set((normaliseName(candidateName) || '').split(' ').filter(Boolean));
  const sources = [page.title, page.footerText];
  for (const node of page.jsonLd || []) {
    if (node.name) sources.push(node.name);
  }
  let best = null;
  let bestOverlap = 0;
  for (const source of sources) {
    if (!source) continue;
    const tokens = new Set((normaliseName(source) || '').split(' ').filter(Boolean));
    if (tokens.size === 0) continue;
    let overlap = 0;
    for (const t of tokens) if (candidateTokens.has(t)) overlap += 1;
    const ratio = overlap / Math.max(tokens.size, candidateTokens.size, 1);
    if (ratio > bestOverlap) { bestOverlap = ratio; best = source; }
  }
  return bestOverlap >= 0.5 ? best : null;
}

function extractPostcode(visibleText) {
  const m = POSTCODE_RE.exec(visibleText || '');
  return m ? m[1].toUpperCase() : null;
}

function extractAddress(visibleText, postcode) {
  if (!postcode) return null;
  const idx = String(visibleText || '').toUpperCase().indexOf(postcode.toUpperCase());
  if (idx === -1) return null;
  const window = visibleText.slice(Math.max(0, idx - 80), idx + postcode.length);
  return STREET_KEYWORD_RE.test(window) ? window.trim() : null;
}

function extractTelephone(visibleText) {
  const m = PHONE_RE.exec(visibleText || '');
  return m ? m[0].trim() : null;
}

function extractPrincipals(jsonLd) {
  const people = (jsonLd || []).filter((node) => {
    const type = node['@type'];
    return type === 'Person' || (Array.isArray(type) && type.includes('Person'));
  });
  if (people.length === 0) return null;
  return people.map((p) => ({ name: p.name || null, jobTitle: p.jobTitle || null }));
}

function categoryConsistency(visibleText, categoryKeywords) {
  const upper = String(visibleText || '').toUpperCase();
  return (categoryKeywords || []).some((kw) => upper.includes(kw));
}

/**
 * extractEvidence(page, candidate) -> {
 *   companyNumber, legalName, tradingNameFound, postcodeFound, addressFound,
 *   telephoneFound, principals, categoryConsistency, extractionRuleVersion
 * }
 *
 * page: extractHtml() output shape. candidate: { businessName,
 * categoryKeywords }.
 */
function extractEvidence(page, candidate) {
  const postcode = extractPostcode(page.visibleText);
  const legalOrTradingName = extractLegalOrTradingName(candidate.businessName, page);
  return {
    companyNumber: extractCompanyNumber(page.visibleText, page.jsonLd),
    legalName: legalOrTradingName,
    tradingNameFound: legalOrTradingName,
    postcodeFound: postcode,
    addressFound: extractAddress(page.visibleText, postcode),
    telephoneFound: extractTelephone(page.visibleText),
    principals: extractPrincipals(page.jsonLd),
    categoryConsistency: categoryConsistency(page.visibleText, candidate.categoryKeywords),
    extractionRuleVersion: 'DDP-EXTRACT-v1.0',
  };
}

module.exports = {
  extractEvidence,
  extractCompanyNumber,
  extractLegalOrTradingName,
  extractPostcode,
  extractAddress,
  extractTelephone,
  extractPrincipals,
  categoryConsistency,
};
