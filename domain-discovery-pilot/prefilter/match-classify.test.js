'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyMatch } = require('./match-classify');

test('classifyMatch: NO_MATCH when nothing scores >= 0.5', () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const raRows = [{ name: 'Totally Different Firm', postcode: 'EH1 1AA' }];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'NO_MATCH');
});

test('classifyMatch: SINGLE_PROBABLE_MATCH — exactly one >=0.8 with matching postcode and no other >=0.5', () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const raRows = [{ name: 'Acme Widgets Limited', postcode: 'SW1A 1AA' }];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'SINGLE_PROBABLE_MATCH');
  assert.equal(result.matched.row.name, 'Acme Widgets Limited');
});

test('classifyMatch: SINGLE_PROBABLE_MATCH — postcode unavailable still counts as corroborated', () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: '' };
  const raRows = [{ name: 'Acme Widgets Limited', postcode: '' }];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'SINGLE_PROBABLE_MATCH');
});

test('classifyMatch: MULTIPLE_OR_AMBIGUOUS_MATCHES — postcode mismatch on the only >=0.8 candidate', () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const raRows = [{ name: 'Acme Widgets Limited', postcode: 'EH1 1AA' }];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'MULTIPLE_OR_AMBIGUOUS_MATCHES');
});

test('classifyMatch: MULTIPLE_OR_AMBIGUOUS_MATCHES — two rows both >=0.5', () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const raRows = [
    { name: 'Acme Widgets Limited', postcode: 'SW1A 1AA' },
    { name: 'Acme Widgets Group', postcode: 'SW1A 1AA' },
  ];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'MULTIPLE_OR_AMBIGUOUS_MATCHES');
});

test('classifyMatch: matches on tradingName when higher than name score', () => {
  // The RA row's own registered name is unrelated, but its tradingName
  // matches the candidate's businessName tokens closely — the "take the
  // higher of name-vs-name and name-vs-tradingName" rule should surface this.
  const candidate = { businessName: 'Bright Sparks Electrical Limited', postcode: '' };
  const raRows = [{ name: 'Totally Different Holdings Co', tradingName: 'Bright Sparks Electrical', postcode: '' }];
  const result = classifyMatch(candidate, raRows);
  assert.equal(result.classification, 'SINGLE_PROBABLE_MATCH');
});

test('classifyMatch: empty RA rows -> NO_MATCH', () => {
  const result = classifyMatch({ businessName: 'Acme', postcode: '' }, []);
  assert.equal(result.classification, 'NO_MATCH');
});
