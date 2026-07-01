'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRetention } = require('./detect-retention');
const { deriveEvidence } = require('./observation-writer');

function present(r) {
  assert.equal(r.state, 'present');
  assert.equal(r.form, 'specific_period');
  assert.ok(r.rawValue && r.rawValue.length > 0);
}
function absent(r) {
  assert.equal(r.state, 'absent');
  assert.equal(r.rawValue, null);
  assert.equal(r.form, null);
}
function indeterminate(r) {
  assert.equal(r.state, 'indeterminate');
  assert.equal(r.rawValue, null);
  assert.equal(r.form, null);
}

// ── PRESENT: explicit numeric periods (the sole qualifying form) ────────────────
test('present — explicit numeric periods', () => {
  present(detectRetention('We retain your personal data for 6 years.'));
  present(detectRetention('Personal data is retained for 24 months from account closure.'));
  present(detectRetention('We keep your information for 7 years.'));
  present(detectRetention('Our retention period is 5 years.'));
  present(detectRetention('Records are held for a period of 6 years.'));
  present(detectRetention('Data will be retained for up to 90 days.'));
});

// ── PRESENT: written-number periods ─────────────────────────────────────────────
test('present — written-number periods', () => {
  present(detectRetention('We retain your data for seven years.'));
  present(detectRetention('Information is kept for twelve months.'));
});

// ── PRESENT: raw value is the verbatim matched span ─────────────────────────────
test('present — raw value preserved verbatim', () => {
  const r = detectRetention('We retain your personal data for 6 years from the date of last contact.');
  assert.equal(r.state, 'present');
  assert.match(r.rawValue, /6 years/);
});

// ── INDETERMINATE: criterion-shaped (objective_criterion removed; never Present) ─
test('indeterminate — criterion-shaped wording', () => {
  indeterminate(detectRetention('We retain your data for the duration of the contract plus the limitation period applicable to claims.'));
  indeterminate(detectRetention('Personal data is retained as required by law.'));
  indeterminate(detectRetention('We keep records in accordance with our retention schedule.'));
  indeterminate(detectRetention('Data is retained for the duration of our relationship with you.'));
});

// ── INDETERMINATE: vague wording ────────────────────────────────────────────────
test('indeterminate — vague wording', () => {
  indeterminate(detectRetention('We retain your personal data for a reasonable period.'));
  indeterminate(detectRetention('Information is kept for an appropriate length of time.'));
});

// ── INDETERMINATE: off-page schedule references ─────────────────────────────────
test('indeterminate — off-page schedule references', () => {
  indeterminate(detectRetention('Our retention periods are set out in our retention schedule, available on request.'));
  indeterminate(detectRetention('Please see our separate retention policy for details.'));
});

// ── INDETERMINATE: period near retention context but attribution ambiguous ──────
// Within one sentence (no boundary), "retention" sits >60 chars from "6 years": too far for the
// strict attribution window (Present) but inside the loose proximity window -> indeterminate.
test('indeterminate — ambiguous retention-proximate period', () => {
  indeterminate(detectRetention('Our retention approach varies by record category and business need, and in some cases extends to 6 years where relevant.'));
});

// ── ABSENT: platitude only / no retention content / non-attributable numbers ────
test('absent — closed platitude only', () => {
  absent(detectRetention('We retain your personal data for as long as necessary.'));
  absent(detectRetention('We keep your information for as long as is necessary for the purposes described.'));
});
test('absent — no retention content', () => {
  absent(detectRetention('This privacy notice explains what data we collect and your rights.'));
});
test('absent — non-attributable durations (no retention context)', () => {
  absent(detectRetention('Our cookies expire after 30 days.'));
  absent(detectRetention('We will respond to your access request within 30 days.'));
});
test('absent — period in cookie context is not a retention period', () => {
  // retention itself is a platitude; the "2 years" belongs to a cookie -> not Present, not ambiguous
  absent(detectRetention('We retain data for as long as necessary. Our analytics cookies last 2 years.'));
});

// ── Negative / guard cases ──────────────────────────────────────────────────────
test('absent — empty / invalid input', () => {
  for (const v of ['', '   ', null, undefined, 123, {}]) absent(detectRetention(v));
});

// ── Determinism / re-derivation ─────────────────────────────────────────────────
test('determinism — same content yields same evidence fact', () => {
  const s = 'We retain your personal data for 6 years.';
  assert.deepEqual(detectRetention(s), detectRetention(s));
});

// ── Partial-retrieval behaviour (writer-level EM-H-D1 routing) ───────────────────
test('partial retrieval — located + empty content -> indeterminate (writer)', () => {
  const e = deriveEvidence('located', '', detectRetention(''));
  assert.equal(e.evidence_state, 'indeterminate');
  assert.equal(e.retention_raw_value, null);
  assert.equal(e.retention_form, null);
});

// ── No-fact (process state) — non-located rows carry NO evidence (EM-H-D1) ───────
test('no-fact — non-located states carry null evidence', () => {
  for (const st of ['not_located', 'retrieval_failure', 'ambiguous']) {
    const e = deriveEvidence(st, null, null);
    assert.equal(e.evidence_state, null);
    assert.equal(e.retention_raw_value, null);
    assert.equal(e.retention_form, null);
  }
});

// ── Located + content -> detector result flows through unchanged ─────────────────
test('located + content -> detector result', () => {
  const e = deriveEvidence('located', 'We retain your data for 6 years.', detectRetention('We retain your data for 6 years.'));
  assert.equal(e.evidence_state, 'present');
  assert.equal(e.retention_form, 'specific_period');
  assert.ok(e.retention_raw_value);
});
