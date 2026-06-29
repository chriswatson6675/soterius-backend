'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCurrency } = require('./detect-currency');

function present(r, form) {
  assert.equal(r.state, 'present');
  assert.equal(r.form, form);
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

test('dated', () => {
  present(detectCurrency('Last updated: 16 April 2026'), 'dated');
  present(detectCurrency('Last reviewed: 27 May 2026'), 'dated');
  present(detectCurrency('Published on 13/11/2024'), 'dated');
  present(detectCurrency('Effective date: 1 January 2025'), 'dated');
});

test('version_date', () => {
  present(detectCurrency('Version 4.4 – 23 Nov 2025'), 'version_date');
  present(detectCurrency('Version 2.1 (Updated 5 March 2024)'), 'version_date');
});

test('version_only', () => {
  present(detectCurrency('Version 1.8'), 'version_only');
  present(detectCurrency('Privacy Policy v2.0'), 'version_only');
});

test('WP-1 month-year', () => {
  present(detectCurrency('This notice was last updated in September 2025'), 'dated'); // UCL (HE-001 run)
  present(detectCurrency('Last reviewed June 2025'), 'dated');
  absent(detectCurrency('In September 2025 we launched a new portal')); // orphan month-year
});

test('absent', () => {
  absent(detectCurrency('© 2024'));
  absent(detectCurrency('Company figures accurate as of 13 December 2023'));
  absent(detectCurrency('Since 2018 we have...'));
  absent(detectCurrency('No date or version information'));
  absent(detectCurrency('© 2026 The University of Sheffield')); // Sheffield (HE-001 run)
});

test('indeterminate', () => {
  indeterminate(detectCurrency('13 March 2024'));
});

test('pilot regression', () => {
  present(detectCurrency('Page last updated: 04 June 2025'), 'dated'); // Cambridge (HE-001 run)
  present(detectCurrency('Last updated: 16 April 2026'), 'dated'); // Hargreaves Lansdown (FCA pilot)
});

test('priority + guards', () => {
  present(detectCurrency('© 2024 Example Ltd. Last updated: 16 April 2026'), 'dated');
  for (const v of ['', '   ', null, undefined, 123, {}]) absent(detectCurrency(v));
});

test('determinism', () => {
  const s = 'Last updated: 16 April 2026';
  assert.deepEqual(detectCurrency(s), detectCurrency(s));
});
