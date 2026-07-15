'use strict';

// match-classify.js — classifies a Repository Authority lookup result set
// against an HMRC AML candidate: NO_MATCH / SINGLE_PROBABLE_MATCH /
// MULTIPLE_OR_AMBIGUOUS_MATCHES. Pure function of its inputs, no I/O.

const { normaliseName } = require('../../authority/lib/normalise');
const { normalisePostcode } = require('./postcode-normalise');

function tokenSet(name) {
  const n = normaliseName(name);
  return new Set(n ? n.split(' ').filter(Boolean) : []);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Token-set Jaccard between the candidate's name and the RA row's name(s) — the HIGHER of name-vs-name and name-vs-tradingName. */
function nameSimilarity(candidateName, raRow) {
  const candidateTokens = tokenSet(candidateName);
  const nameScore = jaccard(candidateTokens, tokenSet(raRow.name));
  const tradingScore = raRow.tradingName ? jaccard(candidateTokens, tokenSet(raRow.tradingName)) : 0;
  return Math.max(nameScore, tradingScore);
}

function postcodeCorroboration(candidatePostcode, raRow) {
  const cp = normalisePostcode(candidatePostcode);
  const rp = normalisePostcode(raRow.postcode);
  if (!cp || !rp) return 'POSTCODE_UNAVAILABLE';
  return cp === rp ? 'POSTCODE_MATCH' : 'POSTCODE_MISMATCH';
}

/**
 * classifyMatch(candidate, raRows) -> {
 *   classification, scoredRows: [{ row, similarity, postcodeCorroboration }]
 * }
 */
function classifyMatch(candidate, raRows) {
  const scoredRows = (raRows || []).map((row) => ({
    row,
    similarity: nameSimilarity(candidate.businessName, row),
    postcodeCorroboration: postcodeCorroboration(candidate.postcode, row),
  }));

  const above05 = scoredRows.filter((r) => r.similarity >= 0.5);
  const above08 = scoredRows.filter((r) => r.similarity >= 0.8);

  if (above05.length === 0) {
    return { classification: 'NO_MATCH', scoredRows, matched: null };
  }

  if (above08.length === 1) {
    const top = above08[0];
    const corroborated = top.postcodeCorroboration === 'POSTCODE_MATCH' || top.postcodeCorroboration === 'POSTCODE_UNAVAILABLE';
    const onlyOneAbove05 = above05.length === 1;
    if (corroborated && onlyOneAbove05) {
      return { classification: 'SINGLE_PROBABLE_MATCH', scoredRows, matched: top };
    }
  }

  return { classification: 'MULTIPLE_OR_AMBIGUOUS_MATCHES', scoredRows, matched: null };
}

module.exports = { classifyMatch, nameSimilarity, postcodeCorroboration, jaccard, tokenSet };
