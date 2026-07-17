'use strict';

// Deterministic finding extraction (Part 5) — the conservative layer that
// turns an already-fetched, already-preserved page into obvious,
// high-confidence, evidence-backed findings the previous real dry-run
// never produced. No LLM, no inference beyond explicit phrasing — exactly
// the same "hold the conservative line" discipline as
// research/relationship-assertion.js, applied to non-relationship facts.
//
// Every finding: { category, value, sourceUrl, evidenceId, contextExcerpt,
// confidence, reason }. This module NEVER assigns an evidence id itself —
// the caller (orchestrator) supplies the id of the evidence record the
// page was already preserved as, so a finding can never cite evidence that
// doesn't exist.

const SERVICE_HEADING_KEYWORDS = ['services', 'what we do', 'our services'];
const WE_PROVIDE_REGEX = /\bwe (?:provide|offer)\s+([a-z0-9][a-z0-9 ,&'-]{2,80})/i;

// Section-boundary keywords — once a "Services" heading section is being
// collected, any of these mark a DIFFERENT section (news/testimonials/
// team) and must stop collection, so blog-article titles or client-name
// headings are never mistaken for service items.
const SERVICE_SECTION_STOP_KEYWORDS = ['recent articles', 'trusted by', 'latest news', 'testimonials', 'our team', 'meet the team', 'follow us', 'news', 'blog', 'contact us'];
const MAX_SERVICE_SECTION_ITEMS = 20;

const REGULATORY_EXPERTISE_PHRASES = [
  /SRA compliance audits?/i,
  /COLP support/i,
  /COFA support/i,
  /AML compliance/i,
  /FCA compliance advice/i,
  /SRA compliance/i,
  /AML consultancy/i,
];

const CLIENT_SECTOR_TERMS = ['law firms', 'solicitors', 'financial advisers', 'accountants', 'estate agents', 'insurance brokers'];

// Positive serving-direction constructions ONLY — deliberately does not
// include a bare "for" (too weak: "For example, as solicitors we..."
// matched it and produced the real false-positive this list replaces).
const POSITIVE_SERVING_PHRASES = [
  /\bwe support\b/i, /\bwe serve\b/i, /\bwe advise\b/i, /\bwe work with\b/i, /\bworking with\b/i,
  /\bclients include\b/i, /\bour clients include\b/i, /\bservices? for\b/i, /\bsupport for\b/i,
  /\badvice for\b/i, /\b(?:support|services|advice|solutions)\s+to\b/i,
];

// The target describing ITSELF as a member of a regulated category ("as
// solicitors we have to...") is a self-description, never evidence of who
// the target SERVES — the real false-positive this rejects.
const SELF_DESCRIPTION_REJECTION_REGEX = /\bas (?:a |an )?(?:law firms?|solicitors?|financial advisers?|accountants?|estate agents?|insurance brokers?)\b.{0,25}\bwe\b/i;

// A sentence containing a real quotation mark that does not itself open
// with "We" reads as being INSIDE someone else's quoted attribution (a
// testimonial, a case study) — sector-serving claims are only trusted when
// the TARGET is making the statement directly, not a quoted third party.
const QUOTE_CHARACTER_REGEX = /[“”"]/;

const ROLE_TITLES = ['Director', 'Founder', 'Consultant', 'Head of Compliance', 'Managing Director', 'Partner'];
const PERSON_ROLE_REGEX = new RegExp(`\\b([A-Z][a-z]+ [A-Z][a-z]+),?\\s+(?:is\\s+(?:our|the)\\s+)?(?:the\\s+)?(${ROLE_TITLES.join('|')})\\b`);
const EMPLOYEE_HISTORY_MARKERS = /\b(previously worked|formerly|used to work|former (employee|director|partner))\b/i;

const THOUGHT_LEADERSHIP_PHRASES = [
  /wrote an article/i,
  /published (?:an?|the) (?:article|guidance)/i,
  /\bwebinar\b/i,
  /speaking at/i,
  /\bconference\b/i,
  /\bpodcast\b/i,
];

// Named-client testimonials — categorically different from the inferences
// this module already explicitly refuses to make (a logo, a membership, an
// employee's work history are never enough). A short, capitalised name
// immediately followed by a quoted, first-person testimonial ("Astraea
// "We have been working with the Compliance Office for a number of
// years...") is direct, explicit, first-party evidence of a named client —
// exactly the kind COMM-002 §6's high bar for named-client claims is meant
// to admit, not exclude. Real testimonial markup is often inconsistent
// about closing quote characters (smart-quote rendering bugs are common),
// so this deliberately does not require a matching close quote — it scores
// the text immediately following the opening quote (up to the next
// testimonial or a bounded window) for an explicit first-person marker.
const NAMED_CLIENT_TESTIMONIAL_REGEX = /([A-Z][A-Za-z.,'-]*(?:\s+(?:&|[A-Z][A-Za-z.,'-]*)){0,5})\s*[“"'‘]/g;
const FIRST_PERSON_TESTIMONIAL_MARKER = /\b(we (?:have|are|would|found|use|work)|our (?:team|firm|experience)|I (?:have|would|am))\b/i;
const NON_NAME_PHRASES = new Set(['Read More', 'Learn More', 'Older Entries', 'Newer Entries', 'Find Out More', 'Contact Us', 'Get In Touch', 'Trusted By', 'Latest News']);
const MAX_TESTIMONIAL_WINDOW = 400;

function extractNamedClientTestimonials(fullText, sourceUrl, evidenceId) {
  const results = [];
  const matches = [...fullText.matchAll(NAMED_CLIENT_TESTIMONIAL_REGEX)];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const name = cleanExcerpt(m[1]);
    if (NON_NAME_PHRASES.has(name)) continue;
    const windowStart = m.index + m[0].length;
    const nextMatchIndex = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    const windowEnd = Math.min(fullText.length, nextMatchIndex, windowStart + MAX_TESTIMONIAL_WINDOW);
    const quote = fullText.slice(windowStart, windowEnd);
    if (!FIRST_PERSON_TESTIMONIAL_MARKER.test(quote)) continue;
    const cleanedQuote = cleanExcerpt(quote);
    results.push({
      category: 'clientsNamed', value: name, sourceUrl, evidenceId,
      contextExcerpt: cleanExcerpt(`${name} "${cleanedQuote.slice(0, 300)}"`),
      evidencePreview: evidencePreviewFor(sourceUrl, cleanedQuote),
      confidence: 'high', reason: 'Named client paired with an explicit first-person quoted testimonial.',
    });
  }
  return results;
}

function isServiceSectionStop(headingText) {
  const lower = headingText.toLowerCase();
  return SERVICE_SECTION_STOP_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Collects specific service-item headings living under an explicit
 * "Services" section heading, stopping at the next h1 (a hard structural
 * boundary) or a recognised different-section heading (news/testimonials/
 * team). General, heading-structure-based — not hardcoded to any one
 * site's wording.
 */
function extractServiceSectionItems(headings) {
  const startIndex = headings.findIndex((h) => SERVICE_HEADING_KEYWORDS.some((k) => h.text.toLowerCase() === k || h.text.toLowerCase().includes(k)));
  if (startIndex === -1) return [];
  const items = [];
  for (let i = startIndex + 1; i < headings.length && items.length < MAX_SERVICE_SECTION_ITEMS; i += 1) {
    const h = headings[i];
    if (h.level === 'h1') break;
    if (isServiceSectionStop(h.text)) break;
    items.push(h.text);
  }
  return items;
}

/** lowercase, strip all non-alphanumeric — unifies case/hyphenation variants ("SRA Compliance Health Checks" vs "sra compliance health-checks") without merging genuinely different phrases. */
function normaliseServiceKey(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deduplicates raw service candidates by normalised wording, merging exact
 * variants into one finding that carries every distinct evidence excerpt
 * it was seen with, rather than one finding per surface-text occurrence.
 */
function dedupeServiceCandidates(candidates) {
  const merged = new Map();
  for (const c of candidates) {
    const key = normaliseServiceKey(c.value);
    if (!key) continue;
    if (!merged.has(key)) {
      merged.set(key, { ...c, additionalContextExcerpts: [] });
    } else {
      const existing = merged.get(key);
      if (c.contextExcerpt && c.contextExcerpt !== existing.contextExcerpt && !existing.additionalContextExcerpts.includes(c.contextExcerpt)) {
        existing.additionalContextExcerpts.push(c.contextExcerpt);
      }
    }
  }
  return [...merged.values()];
}

function splitSentences(text) {
  return (text || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function cleanExcerpt(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function evidencePreviewFor(sourceUrl, excerpt) {
  return `${sourceUrl} — "${excerpt.slice(0, 120)}${excerpt.length > 120 ? '…' : ''}"`;
}

/**
 * extractFindings(page, { sourceUrl, evidenceId }) -> Finding[]
 * `page`: html-extract.js's output shape (title, headings, visibleText,
 * footerText).
 */
function extractFindings(page, { sourceUrl, evidenceId } = {}) {
  const findings = [];
  const fullText = page?.visibleText || '';
  const sentences = splitSentences(fullText);
  const headings = page?.headings || [];

  findings.push(...extractNamedClientTestimonials(fullText, sourceUrl, evidenceId));

  // Services — specific items under an explicit "Services" section heading
  // (service-card sub-headings), plus explicit "we provide/offer"
  // statements below. Collected as raw candidates first, deduplicated by
  // normalised wording, and only pushed as findings at the very end of
  // this function — the generic "Services" heading itself is a fallback,
  // used ONLY when nothing more specific was found anywhere on the page.
  const serviceCandidates = [];
  for (const item of extractServiceSectionItems(headings)) {
    serviceCandidates.push({
      value: cleanExcerpt(item), sourceUrl, evidenceId, contextExcerpt: item,
      confidence: 'medium', reason: 'Explicit service item under a Services section heading.',
    });
  }

  for (const sentence of sentences) {
    // Services — "we provide/offer X".
    const provideMatch = WE_PROVIDE_REGEX.exec(sentence);
    if (provideMatch) {
      serviceCandidates.push({
        value: cleanExcerpt(provideMatch[1]), sourceUrl, evidenceId,
        contextExcerpt: cleanExcerpt(sentence),
        confidence: 'high', reason: 'Explicit "we provide/offer" statement.',
      });
    }

    // Regulatory expertise — explicit phrases only.
    for (const phrase of REGULATORY_EXPERTISE_PHRASES) {
      const match = phrase.exec(sentence);
      if (match) {
        findings.push({
          category: 'regulatoryExpertise', value: match[0], sourceUrl, evidenceId,
          contextExcerpt: cleanExcerpt(sentence), evidencePreview: evidencePreviewFor(sourceUrl, sentence),
          confidence: 'high', reason: 'Explicit regulatory-expertise phrase.',
        });
      }
    }

    // Client sectors — require an explicit serving-DIRECTION construction
    // ("we support X", "services for X" — see POSITIVE_SERVING_PHRASES,
    // which deliberately excludes a bare "for", too weak on its own) AND a
    // named sector, and reject the target describing itself AS a member of
    // that sector ("as solicitors we..."), employee-biography language, or
    // a sentence that reads as inside someone else's quoted attribution.
    for (const term of CLIENT_SECTOR_TERMS) {
      if (!sentence.toLowerCase().includes(term)) continue;
      if (SELF_DESCRIPTION_REJECTION_REGEX.test(sentence)) continue;
      if (EMPLOYEE_HISTORY_MARKERS.test(sentence)) continue;
      if (QUOTE_CHARACTER_REGEX.test(sentence) && !/^\s*we\b/i.test(sentence.trim())) continue;
      if (!POSITIVE_SERVING_PHRASES.some((p) => p.test(sentence))) continue;
      findings.push({
        category: 'clientsSectors', value: term, sourceUrl, evidenceId,
        contextExcerpt: cleanExcerpt(sentence), evidencePreview: evidencePreviewFor(sourceUrl, sentence),
        confidence: 'medium', reason: 'Explicit serving-direction statement naming this sector.',
      });
    }

    // People — name + explicit role, never from employee-history/biography language.
    if (!EMPLOYEE_HISTORY_MARKERS.test(sentence)) {
      const personMatch = PERSON_ROLE_REGEX.exec(sentence);
      if (personMatch) {
        findings.push({
          category: 'people', value: { name: personMatch[1], role: personMatch[2] }, sourceUrl, evidenceId,
          contextExcerpt: cleanExcerpt(sentence), evidencePreview: evidencePreviewFor(sourceUrl, sentence),
          confidence: 'medium', reason: 'Named person paired with an explicit role.',
        });
      }
    }

    // Thought leadership — explicit publication/speaking language.
    for (const phrase of THOUGHT_LEADERSHIP_PHRASES) {
      if (phrase.test(sentence)) {
        findings.push({
          category: 'thoughtLeadership', value: cleanExcerpt(sentence), sourceUrl, evidenceId,
          contextExcerpt: cleanExcerpt(sentence), evidencePreview: evidencePreviewFor(sourceUrl, sentence),
          confidence: 'medium', reason: 'Explicit published/speaking-activity language.',
        });
        break; // one thought-leadership finding per sentence is enough
      }
    }
  }

  // Finalise services: deduplicate near-duplicate wording, and only fall
  // back to the generic "Services" heading itself when nothing more
  // specific was found anywhere on the page.
  const dedupedServices = dedupeServiceCandidates(serviceCandidates);
  if (dedupedServices.length > 0) {
    for (const c of dedupedServices) {
      findings.push({
        category: 'services', value: c.value, sourceUrl: c.sourceUrl, evidenceId: c.evidenceId,
        contextExcerpt: c.contextExcerpt, evidencePreview: evidencePreviewFor(c.sourceUrl, c.contextExcerpt),
        confidence: c.confidence, reason: c.reason,
        ...(c.additionalContextExcerpts.length > 0 ? { additionalContextExcerpts: c.additionalContextExcerpts } : {}),
      });
    }
  } else {
    const genericHeading = headings.find((h) => SERVICE_HEADING_KEYWORDS.some((k) => h.text.toLowerCase() === k || h.text.toLowerCase().includes(k)));
    if (genericHeading) {
      findings.push({
        category: 'services', value: genericHeading.text, sourceUrl, evidenceId,
        contextExcerpt: genericHeading.text, evidencePreview: evidencePreviewFor(sourceUrl, genericHeading.text),
        confidence: 'medium', reason: 'Explicitly labelled service heading (no more specific service items found).',
      });
    }
  }

  return findings;
}

module.exports = { extractFindings };
