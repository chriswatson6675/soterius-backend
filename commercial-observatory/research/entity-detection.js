'use strict';

// Explicit entity and co-party detection (Relationship Discovery model,
// Observation Accumulation Model). Deterministic and evidence-conservative:
// a mention only becomes a relationship CANDIDATE when the relationship
// ASSERTION MODEL (relationship-assertion.js) can demonstrate a defensible
// structural connection between the investigation target, an explicit
// relationship phrase, and the detected entity — not merely because both
// appear somewhere in the same sentence (the class of bug the precision
// pass in relationship-assertion.js exists to prevent; see its header
// comment for the HMRC false positive this was built to fix).
//
// A bare mention of a known body's name in running text — or one whose
// sentence structure does not support a direct target relationship — is
// recorded as a contextual reference, carrying the assertion model's own
// classification and rejection reason, never silently promoted.

const { normaliseName, normaliseDomain } = require('../../authority/lib/normalise');
const { assessRelationshipAssertion } = require('./relationship-assertion');
const { assessDiscoveryCandidate } = require('../agent/discovery-quality');

// ── Known regulatory / professional-body vocabulary ──────────────────────────
// Not an exhaustive list (per the brief) — the starting vocabulary; other
// organisations are only ever detected via explicit link/phrase/structured
// data, never invented from an unbounded name-recognition model.
const KNOWN_BODIES = Object.freeze([
  { canonicalName: 'Financial Conduct Authority', aliases: ['Financial Conduct Authority', 'FCA'], category: 'regulator' },
  { canonicalName: 'Solicitors Regulation Authority', aliases: ['Solicitors Regulation Authority', 'SRA'], category: 'regulator' },
  { canonicalName: "Information Commissioner's Office", aliases: ["Information Commissioner's Office", 'Information Commissioners Office', 'ICO'], category: 'regulator' },
  { canonicalName: 'HM Revenue & Customs', aliases: ['HM Revenue & Customs', 'HM Revenue and Customs', 'HMRC'], category: 'regulator' },
  { canonicalName: 'The Law Society', aliases: ['The Law Society', 'Law Society'], category: 'professional_body' },
  { canonicalName: 'ICAEW', aliases: ['ICAEW', 'Institute of Chartered Accountants in England and Wales'], category: 'professional_body' },
  { canonicalName: 'ACCA', aliases: ['ACCA', 'Association of Chartered Certified Accountants'], category: 'professional_body' },
  { canonicalName: 'CIMA', aliases: ['CIMA', 'Chartered Institute of Management Accountants'], category: 'professional_body' },
  { canonicalName: 'Chartered Institute for Securities & Investment', aliases: ['Chartered Institute for Securities & Investment', 'Chartered Institute for Securities and Investment', 'CISI'], category: 'professional_body' },
  { canonicalName: 'British Standards Institution', aliases: ['British Standards Institution', 'BSI'], category: 'certification_body' },
  { canonicalName: 'UKAS', aliases: ['UKAS', 'United Kingdom Accreditation Service'], category: 'certification_body' },
  { canonicalName: 'National Cyber Security Centre', aliases: ['National Cyber Security Centre', 'NCSC'], category: 'regulator' },
]);

const STRUCTURED_DATA_FIELDS = Object.freeze([
  { field: 'memberOf', relationshipType: 'professional_body', relationshipDirection: 'outbound' },
  { field: 'parentOrganization', relationshipType: 'affiliated_organisation', relationshipDirection: 'mutual' },
  { field: 'subOrganization', relationshipType: 'affiliated_organisation', relationshipDirection: 'mutual' },
  { field: 'funder', relationshipType: 'strategic_partner', relationshipDirection: 'outbound' },
  { field: 'sponsor', relationshipType: 'strategic_partner', relationshipDirection: 'outbound' },
]);

const MAX_HEADING_FOOTER_CONTEXTUAL_MENTIONS = 5;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isShortAcronym(alias) {
  return /^[A-Z&]{2,6}$/.test(alias);
}

function buildAliasRegex(alias) {
  const escaped = escapeRegex(alias);
  return isShortAcronym(alias) ? new RegExp(`\\b${escaped}\\b`, 'g') : new RegExp(`\\b${escaped}\\b`, 'gi');
}

function cleanExcerpt(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function extractWindow(text, index, matchLength, window = 100) {
  return cleanExcerpt(text.slice(Math.max(0, index - window), Math.min(text.length, index + matchLength + window)));
}

// Naive sentence splitter — the relationship-assertion model is deliberately
// single-sentence-scoped, so this is what prevents one sentence's
// relationship language ("in partnership with NCSC") from being
// mis-attributed to an entity mentioned only in an adjacent sentence
// ("regulated by the FCA.").
function splitSentences(text) {
  return (text || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function getSentenceContaining(fullText, index) {
  if (index < 0) return fullText || '';
  const sentences = splitSentences(fullText);
  let cursor = 0;
  for (const s of sentences) {
    const start = fullText.indexOf(s, cursor);
    if (start === -1) continue;
    const end = start + s.length;
    if (index >= start && index < end) return s;
    cursor = end;
  }
  return fullText; // no sentence punctuation found — treat the whole block as one sentence
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// A registration/reference number cited alongside a known body ("...under
// registration number ZA075078") is IDENTIFIER metadata attached to that
// relationship — never a separate entity, never the entity's name (Part 4).
const IDENTIFIER_PATTERN = /\bunder\s+(?:registration\s+)?(?:number|reference)\s+([A-Z0-9-]{4,15})\b/i;

function isProperNounSequence(candidate) {
  const words = candidate.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Z][a-zA-Z&'.-]*$/.test(w));
}

/**
 * detectEntities(page, options) -> {
 *   relationshipCandidates: [{ rawName, normalisedName, domain, sourceUrl,
 *     contextExcerpt, detectionMethod, relationshipType, relationshipDirection,
 *     confidence, relationshipConfidenceState }],
 *   contextualMentions: [{ rawName, normalisedName, sourceUrl, contextExcerpt,
 *     detectionMethod, classification, rejectionReason }],
 *   linkedOrganisations: [{ rawName, domain, sourceUrl }],
 * }
 *
 * `page`: { sourceUrl, extracted: <html-extract.js output> }
 * `options.subjectName`: the investigation's own target name, excluded from
 * detection (a site mentioning its own name is not a co-party) and used as
 * the relationship-assertion model's target reference.
 * `options.subjectAliases`: optional safe name variants for the target.
 * `options.isTargetAuthored`: whether this page is the target's own
 * authored content (default true — every page this pipeline currently
 * fetches is on the investigation's own domain). When false, first-person
 * pronoun references ("we"/"our"/...) do not count as target references.
 */
function detectEntities(page, options = {}) {
  const sourceUrl = page.sourceUrl;
  const extracted = page.extracted || {};
  const subjectNormalised = options.subjectName ? normaliseName(options.subjectName) : null;
  const isTargetAuthored = options.isTargetAuthored ?? true;

  const relationshipCandidates = [];
  const contextualMentions = [];
  const linkedOrganisations = [];
  const seenRelationshipKeys = new Set();
  const seenContextualKeys = new Set();

  function isSubject(normalisedName) {
    return subjectNormalised && normalisedName === subjectNormalised;
  }

  function addRelationshipCandidate(candidate) {
    if (isSubject(candidate.normalisedName)) return;
    const key = `${candidate.normalisedName}|${candidate.relationshipType}|${candidate.relationshipDirection}`;
    if (seenRelationshipKeys.has(key)) return;
    seenRelationshipKeys.add(key);
    relationshipCandidates.push(candidate);
  }

  function addContextualMention(mention) {
    if (isSubject(mention.normalisedName)) return;
    const key = `${mention.normalisedName}|${mention.detectionMethod}|${mention.classification}`;
    if (seenContextualKeys.has(key)) return;
    seenContextualKeys.add(key);
    contextualMentions.push(mention);
  }

  function assess(sentence, entityText) {
    return assessRelationshipAssertion({
      sentence, entityText, targetName: options.subjectName, targetAliases: options.subjectAliases || [], isTargetAuthored,
    });
  }

  // ── 1. Known vocabulary, across body / heading / footer text ──────────────
  // Real page text very commonly uses a "smart"/curly apostrophe (’) where
  // KNOWN_BODIES' alias list uses a plain one — e.g. the real Compliance
  // Office privacy policy renders "Information Commissioner’s Office",
  // which a straight-apostrophe alias regex silently never matches at all.
  // Normalised once here so every downstream match (including sentence
  // extraction/context excerpts) works against the same text.
  const normaliseApostrophes = (s) => s.replace(/[‘’]/g, "'");
  const textBlocks = [
    normaliseApostrophes(extracted.visibleText || ''),
    normaliseApostrophes((extracted.headings || []).map((h) => h.text).join(' \n ')),
    normaliseApostrophes(extracted.footerText || ''),
  ];

  for (const body of KNOWN_BODIES) {
    for (const alias of body.aliases) {
      for (const blockText of textBlocks) {
        if (!blockText) continue;
        const regex = buildAliasRegex(alias);
        let match;
        while ((match = regex.exec(blockText)) !== null) {
          const rawName = match[0];
          const normalisedName = normaliseName(body.canonicalName);
          const sentence = getSentenceContaining(blockText, match.index);
          const assertion = assess(sentence, rawName);

          if (assertion.supported) {
            const identifierMatch = IDENTIFIER_PATTERN.exec(sentence);
            const identifierFields = identifierMatch
              ? { relationshipSubtype: assertion.matchedPattern || null, identifierType: `${body.canonicalName} registration number`, identifierValue: identifierMatch[1] }
              : {};
            addRelationshipCandidate({
              rawName, normalisedName, domain: null, sourceUrl,
              contextExcerpt: cleanExcerpt(sentence), detectionMethod: 'known_vocabulary',
              relationshipType: assertion.relationshipType, relationshipDirection: assertion.direction,
              confidence: assertion.confidence || 'medium', relationshipConfidenceState: assertion.relationshipConfidenceState,
              ...identifierFields,
            });
          } else {
            addContextualMention({
              rawName, normalisedName, sourceUrl,
              contextExcerpt: extractWindow(blockText, match.index, rawName.length),
              detectionMethod: 'known_vocabulary',
              classification: assertion.classification,
              rejectionReason: assertion.reason,
            });
          }
        }
      }
    }
  }

  // ── 2. Linked external organisation names ──────────────────────────────────
  for (const linkEntry of extracted.externalLinks || []) {
    const domain = hostnameOf(linkEntry.href);
    if (!domain || !linkEntry.text) continue;

    // Discovery Quality Gate, applied at the point of extraction (Part 4/5):
    // an anchor's TEXT is never trusted as an organisation name on its own
    // — "ZA075078" (an ICO registration-number lookup link) and
    // "https://www.clio.com/uk/" (a raw URL used as its own label) are
    // exactly the failure mode this rejects or safely renames.
    const assessment = assessDiscoveryCandidate({ rawName: linkEntry.text, domain, url: linkEntry.href, pageText: extracted.visibleText || '' });
    if (!assessment.accepted) continue;

    const rawName = assessment.name;
    const normalisedName = normaliseName(rawName);
    if (!normalisedName || isSubject(normalisedName)) continue;

    linkedOrganisations.push({ rawName, domain: normaliseDomain(domain), sourceUrl, candidateCategory: assessment.category });

    const visibleText = extracted.visibleText || '';
    const linkIndex = visibleText.indexOf(linkEntry.text);
    const sentence = linkIndex === -1 ? '' : getSentenceContaining(visibleText, linkIndex);
    // The relationship-assertion pass is only meaningful for a NAME the
    // gate resolved with confidence in its own right (a known regulator
    // link, a named partner, etc.) — a vendor name DERIVED from a domain
    // (assessment.category === 'technology_vendor') describes a supplier
    // relationship only if the surrounding wording says so; asserting a
    // full relationship phrase-match against derived text risks a false
    // positive the task explicitly warns against ("do not assert a
    // partnership unless wording supports it"), so the assertion pass
    // still runs, but on the ORIGINAL sentence around the derived name,
    // which is exactly where the "sub-processor" wording itself lives.
    const assertion = assess(sentence, rawName);

    if (assertion.supported) {
      addRelationshipCandidate({
        rawName, normalisedName, domain: normaliseDomain(domain), sourceUrl,
        contextExcerpt: cleanExcerpt(sentence), detectionMethod: 'external_link',
        relationshipType: assertion.relationshipType, relationshipDirection: assertion.direction,
        confidence: 'low', relationshipConfidenceState: assertion.relationshipConfidenceState,
      });
    } else if (assessment.category === 'technology_vendor') {
      // Explicit sub-processor/vendor context supports treating this as a
      // discovery-worthy technology vendor even though the sentence itself
      // doesn't match a recognised relationship phrase — but it must NOT
      // become an asserted relationship (no partnership claim), only a
      // contextual mention carrying its derived category.
      addContextualMention({
        rawName, normalisedName, sourceUrl, contextExcerpt: cleanExcerpt(sentence) || rawName, detectionMethod: 'external_link',
        classification: 'technology_vendor', rejectionReason: 'Named sub-processor/supplier context — recorded as a possible technology vendor, not an asserted relationship.',
      });
    } else {
      addContextualMention({
        rawName, normalisedName, sourceUrl, contextExcerpt: rawName, detectionMethod: 'external_link',
        classification: assertion.classification, rejectionReason: assertion.reason,
      });
    }
  }

  // ── 3. Structured data (JSON-LD) ───────────────────────────────────────────
  // Machine-readable, self-describing markup — no sentence-ambiguity
  // problem exists here, so no assertion-model pass is needed.
  for (const node of extracted.jsonLd || []) {
    if (!node || typeof node !== 'object') continue;
    for (const { field, relationshipType, relationshipDirection } of STRUCTURED_DATA_FIELDS) {
      const value = node[field];
      if (!value) continue;
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        const rawName = typeof entry === 'string' ? entry : entry.name;
        if (!rawName) continue;
        const normalisedName = normaliseName(rawName);
        if (!normalisedName || isSubject(normalisedName)) continue;
        const domain = (entry && typeof entry === 'object' && entry.url) ? normaliseDomain(hostnameOf(entry.url)) : null;
        addRelationshipCandidate({
          rawName, normalisedName, domain, sourceUrl,
          contextExcerpt: `Structured data (${field}): ${rawName}`, detectionMethod: 'structured_data',
          relationshipType, relationshipDirection, confidence: 'medium', relationshipConfidenceState: 'probable',
        });
      }
    }
  }

  // ── 5. Organisation-like names in headings/footer (light heuristic) ───────
  // Contextual only — never promoted to a relationship candidate on this
  // signal alone (too weak: no vocabulary match, no phrase, no link).
  let headingFooterCount = 0;
  const headingFooterSource = [
    ...(extracted.headings || []).map((h) => h.text),
    extracted.footerText || '',
  ].join(' \n ');
  const properNounRegex = /\b([A-Z][a-zA-Z&'.-]*(?:\s+[A-Z][a-zA-Z&'.-]*){1,3})\b/g;
  let m;
  while ((m = properNounRegex.exec(headingFooterSource)) !== null && headingFooterCount < MAX_HEADING_FOOTER_CONTEXTUAL_MENTIONS) {
    const candidate = m[1];
    if (!isProperNounSequence(candidate)) continue;
    const normalisedName = normaliseName(candidate);
    if (!normalisedName || isSubject(normalisedName)) continue;
    if (KNOWN_BODIES.some((b) => normaliseName(b.canonicalName) === normalisedName)) continue; // already handled above
    addContextualMention({
      rawName: candidate, normalisedName, sourceUrl,
      contextExcerpt: extractWindow(headingFooterSource, m.index, candidate.length, 40),
      detectionMethod: 'heading_or_footer',
      classification: 'general_context',
      rejectionReason: 'Proper-noun heuristic match only — no vocabulary, phrase or link support.',
    });
    headingFooterCount += 1;
  }

  return { relationshipCandidates, contextualMentions, linkedOrganisations };
}

module.exports = { detectEntities, KNOWN_BODIES };
