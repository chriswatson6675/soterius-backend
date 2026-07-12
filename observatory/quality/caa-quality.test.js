'use strict';
// CAA-QM-v1.0 reference-implementation tests.
// Verifies the implementation matches SLG-070 (structure) and SLG-071 (values) exactly,
// and honours the SLG-072 commissioning requirements CR-1 … CR-4.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreCaaQuality, scorePopulation, isAuthorising, classify,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_RESTRICTED, PRIMARY_WILDCARD_ONLY, PRIMARY_UNCONSTRAINED,
  MULT_WILDCARD_EXCEEDS_BASE, MULT_INOPERATIVE_ELEMENT,
} = require('./caa-quality');

const rec = (tag, value, flags = 0) => ({ flags, tag, value });
const present = (domain, records) => ({ domain, dns_caa_present: true, caa_collection_error: null, caa_records: records });
const absent  = (domain) => ({ domain, dns_caa_present: false, caa_collection_error: null, caa_records: [] });
const unknown = (domain, err = 'DNS_FAILURE') => ({ domain, dns_caa_present: null, caa_collection_error: err, caa_records: [] });
const score = (facts, pop = new Map()) => scoreCaaQuality(facts, pop);

// ── Calibrated constants (SLG-071 §3) ────────────────────────────────────────
test('calibrated values match SLG-071 exactly', () => {
  assert.equal(PRIMARY_RESTRICTED, 100);
  assert.equal(PRIMARY_WILDCARD_ONLY, 50);
  assert.equal(PRIMARY_UNCONSTRAINED, 0);
  assert.equal(MULT_WILDCARD_EXCEEDS_BASE, 0.90);
  assert.equal(MULT_INOPERATIVE_ELEMENT, 0.95);
  assert.equal(QUALITY_VERSION, 'CAA-QM-v1.0');
  assert.equal(MODEL_ID, 'CAA-QM-v1.0');
});

// ── R1 / R2 — RFC 8659 §4.2 ABNF empty-equivalence (SLG-070 D3/D4) ───────────
test('R1: authorising iff non-empty and ABNF-conformant', () => {
  assert.equal(isAuthorising('digicert.com'), true);
  assert.equal(isAuthorising('Digicert.com'), true);          // LDH admits ALPHA
  assert.equal(isAuthorising('www.digicert.com'), true);
  assert.equal(isAuthorising('ca.intranet.alpha-associates.ch'), true);
  assert.equal(isAuthorising('digicert.com; cansignhttpexchanges=yes'), true); // params stripped
  assert.equal(isAuthorising(''), false);                     // empty issuer-domain-name
  assert.equal(isAuthorising(';'), false);                    // canonical deny-all form
  assert.equal(isAuthorising(' ; '), false);
  assert.equal(isAuthorising('amazon.com.'), false);          // trailing dot ⇒ non-conformant
  assert.equal(isAuthorising('mailto:x@y.com'), false);       // not a domain name
});

// ── Primary states (SLG-070 §4) ──────────────────────────────────────────────
test('UNCONSTRAINED: no CAA RRset (confirmed floor)', () => {
  const r = score(absent('a.example'));
  assert.equal(r.scored, true);
  assert.equal(r.score, 0);
  assert.equal(r.primaryLabel, 'UNCONSTRAINED');
});

test('UNCONSTRAINED: RRset with no restricting Property (D1 — publication is not policy)', () => {
  // §4.2: "contains no Property Tags that restrict issuance … CAA does not restrict issuance"
  assert.equal(score(present('a', [rec('iodef', 'mailto:a@b.c')])).score, 0);
  assert.equal(score(present('b', [rec('contactemail', 'a@b.c')])).score, 0);
  assert.equal(score(present('c', [rec('issuemail', 'ca.example')])).score, 0);
  // …and it must NOT rank above a domain publishing nothing at all
  assert.equal(score(present('d', [rec('iodef', 'mailto:a@b.c')])).score, score(absent('e')).score);
});

test('WILDCARD_ONLY: issuewild present, no issue (§4.3 leaves base unconstrained)', () => {
  const r = score(present('a', [rec('issuewild', 'letsencrypt.org')]));
  assert.equal(r.score, 50);
  assert.equal(r.primaryLabel, 'WILDCARD_ONLY');
});

test('RESTRICTED: issue with >=1 authorising issuer', () => {
  const r = score(present('a', [rec('issue', 'digicert.com')]));
  assert.equal(r.score, 100);
  assert.equal(r.primaryLabel, 'RESTRICTED');
  assert.deepEqual(r.applied, []);
});

test('R3: an empty-equivalent issue value is nullified by an authorising one (§4.2 override)', () => {
  // hants.gov.uk: deny-all `issue ";"` alongside permissive issue values ⇒ RESTRICTED, not PROHIBITED
  const r = score(present('hants', [rec('issue', ';'), rec('issue', 'digicert.com')]));
  assert.equal(r.primaryLabel, 'RESTRICTED');
  assert.equal(r.score, 95);                       // M2(a) fires: the deny-all is inoperative
});

// ── CR-3 — PROHIBITED is OBSERVED but UNCALIBRATED ───────────────────────────
test('CR-3: PROHIBITED is not scored, and is distinguishable from unobserved', () => {
  const p = score(present('a', [rec('issue', ';')]));               // every issue value empty-equivalent
  assert.equal(p.scored, false);
  assert.equal(p.reason, 'UNCALIBRATED_STATE_PROHIBITED');
  assert.equal(p.score, null);
  assert.equal(p.primaryLabel, 'PROHIBITED');

  const u = score(unknown('b'));
  assert.equal(u.scored, false);
  assert.equal(u.reason, 'OBSERVATION_INCOMPLETE');
  assert.notEqual(u.reason, p.reason);            // must never be conflated
});

test('CR-3: a wholly non-conformant issue set also prohibits (§4.2 ABNF rule)', () => {
  const r = score(present('a', [rec('issue', 'mailto:x@y.com')]));
  assert.equal(r.reason, 'UNCALIBRATED_STATE_PROHIBITED');
});

test('R5: unobserved is never scored and never imputed', () => {
  const r = score(unknown('a', 'DNS_SERVFAIL'));
  assert.equal(r.score, null);
  assert.equal(r.collectionError, 'DNS_SERVFAIL');
});

// ── M1 (SLG-070 §5, ×0.90) ───────────────────────────────────────────────────
test('M1: wildcard authorisation strictly wider than base', () => {
  const r = score(present('a', [rec('issue', 'digicert.com'), rec('issuewild', 'digicert.com'), rec('issuewild', 'sectigo.com')]));
  assert.equal(r.score, 90);
  assert.equal(r.applied[0].factor, 0.90);
});

test('M1: incomparable wildcard set also fires (SLG-071 Q7)', () => {
  const r = score(present('a', [rec('issue', 'amazon.com'), rec('issuewild', 'sectigo.com')]));
  assert.equal(r.score, 90);
});

test('M1: equal or narrower wildcard set does NOT fire (narrowing is never rewarded nor penalised)', () => {
  assert.equal(score(present('a', [rec('issue', 'digicert.com'), rec('issuewild', 'digicert.com')])).score, 100);
  assert.equal(score(present('b', [rec('issue', 'digicert.com'), rec('issue', 'sectigo.com'), rec('issuewild', 'digicert.com')])).score, 100);
});

test('M1: deny-all issuewild (wildcards prohibited) does NOT fire — it narrows', () => {
  const r = score(present('a', [rec('issue', 'digicert.com'), rec('issuewild', ';')]));
  assert.equal(r.primaryLabel, 'RESTRICTED');
  assert.equal(r.score, 100);                      // no M1; and no M2 (no authorising issuewild to nullify it)
});

// ── M2 (SLG-070 §5, ×0.95) — four sub-cases, uniform, applied once ───────────
test('M2(b): undefined Property Tag (§4.5 — ignored by every CA)', () => {
  assert.equal(score(present('a', [rec('issue', 'digicert.com'), rec('issuewildcard', 'amazon.com')])).score, 95);
});
test('M2(c): iodef value that is not a URL (§4.4)', () => {
  assert.equal(score(present('a', [rec('issue', 'digicert.com'), rec('iodef', 'admin@example.com')])).score, 95);
  assert.equal(score(present('b', [rec('issue', 'digicert.com'), rec('iodef', 'mailto:admin@example.com')])).score, 100);
});
test('M2(d): reserved flags bit set (§4.1 "MUST clear")', () => {
  assert.equal(score(present('a', [rec('issue', 'digicert.com'), rec('iodef', 'mailto:a@b.c', 1)])).score, 95);
});
test('M2 is uniform and applied ONCE, not dosed (SLG-071 Q3)', () => {
  const many = present('bdo', [rec('issue', 'digicert.com'),
    ...Array.from({ length: 10 }, () => rec('issuewildcard', 'amazon.com'))]);
  assert.equal(score(many).score, 95);             // ten inert records, one ×0.95
  assert.equal(score(many).applied.length, 1);
});

test('M1 and M2 compose multiplicatively (michelmores.com case)', () => {
  const r = score(present('a', [
    rec('issue', 'amazon.com'), rec('issue', 'amazon.com.'),   // trailing dot ⇒ inoperative ⇒ M2
    rec('issuewild', 'sectigo.com'),                            // not in the issue set ⇒ M1
  ]));
  assert.equal(r.score, 85.5);                     // 100 × 0.90 × 0.95
  assert.equal(r.applied.length, 2);
});

test('multipliers are inert on the floor (arcelormittal.com case)', () => {
  const r = score(present('a', [rec('issuedwild', 'digicert.com')]));  // undefined tag only
  assert.equal(r.primaryLabel, 'UNCONSTRAINED');
  assert.equal(r.score, 0);                        // 0 × 0.95 = 0
});

// ── CR-4 — M3 evaluated and flagged, never applied ───────────────────────────
test('CR-4: M3 is flagged but applies no factor (kier.co.uk case)', () => {
  const r = score(present('kier', [rec('issue', 'sectigo.com'), rec('issuemail', 'sectigo.com', 128)]));
  assert.equal(r.score, 100);                      // uncalibrated ⇒ no reduction
  assert.deepEqual(r.flags, ['M3_CRITICAL_UNRECOGNISED_TAG']);
  assert.equal(r.applied.length, 0);
});
test('critical flag on a RECOGNISED tag has no effect (§4.5) and raises no flag', () => {
  const r = score(present('a', [rec('issue', 'digicert.com', 128)]));
  assert.equal(r.score, 100);
  assert.deepEqual(r.flags, []);
});

// ── CR-1 — D-2 immunity: case-insensitive tag matching from preserved evidence ──
test('CR-1: uppercase Property Tags classify correctly (immune to collector defect D-2)', () => {
  // RFC 8659 §4.1: "Matching of tags is case insensitive."
  // The collector's derived counters get this wrong (D-2); caa_records preserves the tag verbatim.
  assert.equal(score(present('a', [rec('ISSUE', 'letsencrypt.org')])).primaryLabel, 'RESTRICTED');
  assert.equal(score(present('a', [rec('ISSUE', 'letsencrypt.org')])).score, 100);
  assert.equal(score(present('b', [rec('Issue', 'letsencrypt.org')])).score, 100);
  assert.equal(score(present('c', [rec('ISSUEWILD', 'letsencrypt.org')])).primaryLabel, 'WILDCARD_ONLY');
  assert.equal(score(present('d', [rec('issue', 'digicert.com'), rec('IODEF', 'mailto:a@b.c')])).score, 100);
  // and an uppercase RECOGNISED tag must not be treated as "undefined" (would wrongly fire M2)
  assert.equal(score(present('e', [rec('issue', 'digicert.com'), rec('IODEF', 'mailto:a@b.c')])).applied.length, 0);
});

test('CR-1: the model never reads the collector-derived counters', () => {
  // Deliberately contradictory counters — the score must ignore them entirely.
  const facts = { domain: 'a', dns_caa_present: true, caa_collection_error: null,
    caa_records: [rec('issue', 'digicert.com')],
    caa_issue_count: 0, caa_issuewild_count: 99, caa_iodef_count: 99,
    caa_unknown_tag_count: 99, caa_critical_count: 99, caa_tags_present: ['nonsense'] };
  assert.equal(score(facts).score, 100);
});

// ── CR-2 / R4 — inheritance resolution (§3), peer-independent but not row-independent ──
test('CR-2/R4: an absent child governed by a publishing in-population ancestor', () => {
  const parent = present('jpmorgan.com', [rec('issue', 'digicert.com'), rec('issue', 'entrust.net')]);
  const child  = absent('am.jpmorgan.com');
  const pop = new Map([[parent.domain, parent], [child.domain, child]]);
  const r = scoreCaaQuality(child, pop);
  assert.equal(r.primaryLabel, 'RESTRICTED');
  assert.equal(r.score, 100);
  assert.equal(r.source, 'ancestor');
  assert.equal(r.inheritedFrom, 'jpmorgan.com');
});

test('CR-2/R4: a child publishing its own RRset overrides the ancestor (§3)', () => {
  const parent = present('jpmorgan.com', [rec('issue', 'digicert.com')]);
  const child  = present('personalinvesting.jpmorgan.com', [rec('issuewild', 'sectigo.com')]);
  const pop = new Map([[parent.domain, parent], [child.domain, child]]);
  const r = scoreCaaQuality(child, pop);
  assert.equal(r.source, 'self');
  assert.equal(r.primaryLabel, 'WILDCARD_ONLY');
});

test('CR-2/R4: the NEAREST publishing ancestor governs', () => {
  const gp  = present('example.com', [rec('issue', 'digicert.com')]);
  const mid = present('a.example.com', [rec('issuewild', 'sectigo.com')]);
  const kid = absent('b.a.example.com');
  const pop = new Map([[gp.domain, gp], [mid.domain, mid], [kid.domain, kid]]);
  assert.equal(scoreCaaQuality(kid, pop).inheritedFrom, 'a.example.com');
});

test('CR-2/R4: absent with no publishing ancestor stays at the floor', () => {
  const parent = absent('gov.uk');
  const child  = absent('hmrc.gov.uk');
  const pop = new Map([[parent.domain, parent], [child.domain, child]]);
  const r = scoreCaaQuality(child, pop);
  assert.equal(r.score, 0);
  assert.equal(r.source, 'none');
});

test('CR-2: scorePopulation resolves inheritance across the whole population', () => {
  const rows = [
    present('computershare.com', [rec('issue', 'digicert.com')]),
    absent('www-uk.computershare.com'),
    absent('unrelated.example'),
    unknown('broken.example'),
  ];
  const m = scorePopulation(rows);
  assert.equal(m.get('www-uk.computershare.com').score, 100);
  assert.equal(m.get('unrelated.example').score, 0);
  assert.equal(m.get('broken.example').scored, false);
});

// ── Structural invariants (SLG-071 §4) ───────────────────────────────────────
test('reduce-only: no multiplier can raise a score, all scores in [0,100]', () => {
  const cases = [
    present('a', [rec('issue', 'digicert.com')]),
    present('b', [rec('issue', 'digicert.com'), rec('issuewild', 'sectigo.com')]),
    present('c', [rec('issue', 'digicert.com'), rec('issuewildcard', 'x.example')]),
    present('d', [rec('issuewild', 'letsencrypt.org')]),
    absent('e'),
  ];
  for (const f of cases) {
    const r = score(f);
    assert.ok(r.score >= 0 && r.score <= 100, `${f.domain} out of range`);
    assert.ok(r.score <= r.primary, `${f.domain} multiplier raised the score`);
  }
});

test('bands are disjoint and non-inverting (maximum reduction 0.855 cannot cross a band)', () => {
  const restrictedMin = 100 * MULT_WILDCARD_EXCEEDS_BASE * MULT_INOPERATIVE_ELEMENT;  // 85.5
  const wildcardMax   = PRIMARY_WILDCARD_ONLY;                                        // 50
  const wildcardMin   = PRIMARY_WILDCARD_ONLY * MULT_INOPERATIVE_ELEMENT;             // 47.5 (M1 unreachable)
  assert.ok(restrictedMin > wildcardMax);
  assert.ok(wildcardMin > PRIMARY_UNCONSTRAINED);
});
