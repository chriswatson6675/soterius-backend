'use strict';

// detect-transfersafeguard.js — SOT-TRANSFERSAFEGUARD-001 (H-SIG-003) deterministic detector.
//
// Element DE-PAD-016 (Transfer Safeguard Specification). Sole Present-qualifying form
// `named_mechanism`: the located privacy disclosure names a specific international-transfer
// safeguard mechanism from a closed Art 46 lexicon. Structural only (regex over a fixed closed
// lexicon); no NLP/AI/semantic inference/scoring/confidence. Per the Derived Constitutional
// Precedent (H-SIG-002): affirmative states are established only through structurally observable
// facts. `present` = a named mechanism keyword observed; `absent` = located, fully retrieved, no
// named mechanism (generic phrasing such as "appropriate safeguards" does NOT name a mechanism →
// absent — there is no ambiguity about the structural fact). Partial/empty retrieval → the writer
// resolves to `indeterminate`. No-fact is the located_state process state (handled upstream).
//
// Observes that a mechanism is NAMED — never whether the transfer is lawful/adequate (no compliance,
// no legal interpretation; SLG-023 §5).

// Closed Art 46 transfer-safeguard mechanism lexicon (full phrases case-insensitive; acronyms
// case-sensitive with word boundaries to avoid false positives).
const MECHANISMS = [
  /standard\s+contractual\s+clauses/i,
  /\bSCCs?\b/,
  /international\s+data\s+transfer\s+(?:agreement|addendum)/i,
  /\bIDTA\b/,
  /\bUK\s+addendum\b/i,
  /binding\s+corporate\s+rules/i,
  /\bBCRs?\b/,
  /adequacy\s+(?:decision|decisions|regulations|finding|status)/i,
  /(?:eu[\s-]*us|swiss[\s-]*us|uk[\s-]*us|uk[\s-]*extension)?\s*data\s+privacy\s+framework/i,
  /\bDPF\b/,
  /privacy\s+shield/i,
];

function detectTransferSafeguard(rawText) {
  const ABSENT = { state: 'absent', rawValue: null, form: null };
  if (typeof rawText !== 'string' || rawText.trim() === '') return ABSENT;
  for (const re of MECHANISMS) {
    const m = rawText.match(re);
    if (m) return { state: 'present', rawValue: m[0].trim(), form: 'named_mechanism' };
  }
  return ABSENT;
}

module.exports = { detectTransferSafeguard };
