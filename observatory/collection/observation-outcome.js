'use strict';

// Shared collection-outcome vocabulary + the common DNS three-state mapping,
// reused by the DNS-based signal adapters (SPF, DMARC, CAA). Signals with
// richer/multi-part collection state (DKIM, MTA-STS, TLS, Certificate, Security
// Headers, security.txt) implement their own deriveCollectionOutcome but draw
// the OUTCOME constants from here so the four-state vocabulary is defined once.

const OUTCOME = Object.freeze({
  OBSERVED_PRESENT: 'OBSERVED_PRESENT',
  OBSERVED_ABSENT:  'OBSERVED_ABSENT',
  NOT_OBSERVED:     'NOT_OBSERVED',
  COLLECTION_ERROR: 'COLLECTION_ERROR',
});

// dnsThreeStateOutcome(present, error) — the canonical mapping for a signal whose
// collection state is a single three-state presence flag (true/false/null) plus a
// DNS error code. Mirrors the Quality Models' own not-scored / confirmed-absent
// gates: present===true → PRESENT, present===false → ABSENT (a real answer),
// present==null → NOT_OBSERVED on timeout else COLLECTION_ERROR (never ABSENT — P-5).
function dnsThreeStateOutcome(present, error) {
  if (present === true) return OUTCOME.OBSERVED_PRESENT;
  if (present === false) return OUTCOME.OBSERVED_ABSENT;
  return error === 'DNS_TIMEOUT' ? OUTCOME.NOT_OBSERVED : OUTCOME.COLLECTION_ERROR;
}

module.exports = { OUTCOME, dnsThreeStateOutcome };
