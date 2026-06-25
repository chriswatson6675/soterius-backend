'use strict';

// detect-retention.js — SOT-RETENTIONTRANSPARENCY-001 (H-SIG-002) deterministic detector.
//
// Implements element DE-PAD-015 (Retention Specification) per the approved Operational Design
// and the Founder Constitutional Refinement: the SOLE Present-qualifying form is
// `specific_period` — an attributable numeric retention period. `objective_criterion` is NOT a
// Present-qualifying form; criterion-shaped wording resolves to `indeterminate`.
//
// Structural only: regex + fixed lexicons + keyword-adjacency attribution. No NLP, no AI, no
// semantic inference, no scoring, no confidence. An affirmative evidence state is established
// ONLY through a structurally observable fact; where structural observability is insufficient
// the result is `indeterminate` (Derived Constitutional Precedent, H-SIG-002).
//
// No-fact is a process state handled upstream by located_state — this detector runs only on
// located, fully-retrieved content. Partial/empty located content is routed to `indeterminate`
// by the observation writer, not here.

// ── Numeric retention period (number + time unit) ───────────────────────────────
const NUM  = '(?:\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const UNIT = '(?:year|month|week|day)s?';
const PERIOD = `${NUM}\\s+${UNIT}`;
const PERIOD_RE = new RegExp(`\\b${PERIOD}\\b`, 'i');

// ── Retention-context anchors (attribution to personal-data retention) ──────────
const RET     = '(?:retain(?:ed|s|ing)?|retention(?:\\s+period)?)';
const RETKEEP = `(?:${RET}|(?:keep|kept|hold|held|stor(?:e|ed|ing))\\b[^.\\n]{0,25}?\\bfor)`;

// PRESENT — retention keyword adjacent to a numeric period (either order)
const RP_STRICT_FWD = new RegExp(`\\b${RETKEEP}\\b[^.\\n]{0,60}?\\b${PERIOD}\\b`, 'i');
const RP_STRICT_REV = new RegExp(`\\b${PERIOD}\\b[^.\\n]{0,30}?\\b(?:${RET}|we\\s+(?:keep|hold|store))\\b`, 'i');

// INDETERMINATE triggers — retention-specificity-shaped, NON-numeric constructions
const CRITERION_RE = /\b(?:for\s+the\s+)?duration\s+of\s+(?:the|our|your|any)?\s*(?:contract|engagement|relationship|agreement|membership|account)|limitation\s+period|statutory\s+(?:retention|period|requirement|obligation)|regulatory\s+(?:requirement|period|obligation)|required\s+by\s+(?:applicable\s+)?law|legal\s+(?:requirement|obligation)|in\s+accordance\s+with\s+(?:our|the)\s+retention\s+(?:schedule|policy)/i;
const VAGUE_RE     = /\b(?:a\s+)?reasonable\s+period|appropriate\s+(?:period|length\s+of\s+time)|such\s+period\s+as|for\s+a\s+period\s+(?:determined|deemed)|as\s+long\s+as\s+(?:appropriate|relevant)/i;
const OFFPAGE_RE   = /retention\s+(?:schedule|policy)[^.\n]{0,40}?(?:available|provided|set\s+out|obtained)[^.\n]{0,25}?(?:on\s+request|separately|elsewhere|upon\s+request)|see\s+(?:our|the)\s+(?:separate\s+)?retention\s+(?:schedule|policy)/i;

// Retention context present anywhere (gates the loose/ambiguous indeterminate branch)
const RET_CONTEXT_RE = new RegExp(`\\b(?:${RET}|how\\s+long\\s+we\\s+(?:keep|hold|store|retain))\\b`, 'i');

// LOOSE proximity — a period near retention context but not cleanly attributed
const RP_LOOSE_FWD = new RegExp(`\\b${RET}\\b[^.\\n]{0,120}?\\b${PERIOD}\\b`, 'i');
const RP_LOOSE_REV = new RegExp(`\\b${PERIOD}\\b[^.\\n]{0,120}?\\b${RET}\\b`, 'i');

// Non-attributable context guard (cookie / session / expiry / SAR-response). A period whose
// matched span sits in one of these contexts is NOT a retention period.
const NON_ATTRIBUTABLE_RE = /cookie|local\s+storage|session\s+(?:id|cookie|storage)|expir(?:e|es|y|ation)|respond(?:ing)?\s+(?:to\s+)?(?:your\s+)?(?:request|sar)|within\s+(?:one\s+month|\d+\s+(?:days|months))\s+of\s+(?:your\s+)?(?:request|receipt|access)/i;

// Return the first match of `re` whose matched span is NOT in a non-attributable context.
function firstClean(text, re) {
  const g = new RegExp(re.source, 'ig');
  let m;
  while ((m = g.exec(text)) !== null) {
    if (!NON_ATTRIBUTABLE_RE.test(m[0])) return m[0];
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return null;
}

function detectRetention(rawText) {
  const ABSENT = { state: 'absent', rawValue: null, form: null };
  const IND = { state: 'indeterminate', rawValue: null, form: null };
  if (typeof rawText !== 'string' || rawText.trim() === '') return ABSENT;
  const text = rawText;

  // 1) PRESENT — an attributable numeric retention period (structural fact)
  const period = firstClean(text, RP_STRICT_FWD) || firstClean(text, RP_STRICT_REV);
  if (period) return { state: 'present', rawValue: period.trim(), form: 'specific_period' };

  // 2) INDETERMINATE — non-numeric specificity-shaped constructions
  if (CRITERION_RE.test(text) || VAGUE_RE.test(text) || OFFPAGE_RE.test(text)) return IND;

  // 3) INDETERMINATE — a period near retention context but attribution ambiguous
  //    (matched span not in a cookie/SAR/expiry context)
  if (RET_CONTEXT_RE.test(text) && PERIOD_RE.test(text)) {
    const loose = firstClean(text, RP_LOOSE_FWD) || firstClean(text, RP_LOOSE_REV);
    if (loose) return IND;
  }

  // 4) ABSENT — located, fully retrieved; only platitude / no retention specificity / no content
  return ABSENT;
}

module.exports = { detectRetention };
