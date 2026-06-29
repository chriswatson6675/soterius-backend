'use strict';
const MONTHS =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const D1 = `\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\.?\\s+\\d{4}`;
const D2 = `${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`;
const D3 = `\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}`;
const D4 = `\\d{4}-\\d{2}-\\d{2}`;
const DATE_ALT = `(?:${D1}|${D2}|${D3}|${D4})`;
const DATE_RE = new RegExp(`\\b${DATE_ALT}\\b`, 'i'); // month-year intentionally NOT here (orphan guard)

const VERSION_PATTERNS = [
  /\bversion\s*\.?\s*\d+(?:\.\d+)*\b/i,
  /\bver\.?\s*\d+(?:\.\d+)*\b/i,
  /\bv\d+\.\d+\b/i,
];
const KW =
  '(?:last\\s+(?:updated|reviewed|revised|modified|amended|changed)|' +
  'date\\s+last\\s+(?:updated|reviewed|revised)|' +
  '(?:updated|reviewed|revised|published|amended)\\s+on|published|' +
  'effective(?:\\s+(?:date|from|as\\s+of))?)';

// WP-1 patch: month-year form + connector words, keyword-adjacent only
const MY = `${MONTHS}\\.?\\s+\\d{4}`;
const SEP = `[\\s:.\\-–—()]*(?:(?:in|on|of|as\\s+of)\\b[\\s:.\\-–—()]*){0,2}`;
const CURRENCY_PHRASE_RE = new RegExp(`\\b${KW}\\b${SEP}(?:${DATE_ALT}|${MY})`, 'i');

const NON_CURRENCY_CONTEXT = [
  /©|\(c\)|copyright|all\s+rights\s+reserved/i,
  /accurate\s+as\s+(?:at|of)|as\s+at\s+\d|company\s+(?:figures|data|performance)|figures?\s+(?:are\s+|were\s+)?(?:accurate|correct|as\s+(?:at|of))|prices?\s+as\s+(?:at|of)/i,
  /\bsince\s+(?:19|20)\d{2}|established\s+(?:19|20)\d{2}|founded\s+(?:19|20)\d{2}|for\s+over\s+\d+\s+years/i,
];

function matchFirst(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m;
  }
  return null;
}

function detectCurrency(rawText) {
  const ABSENT = { state: 'absent', rawValue: null, form: null };
  if (typeof rawText !== 'string' || rawText.trim() === '') return ABSENT;
  const text = rawText;
  const versionM = matchFirst(text, VERSION_PATTERNS);
  const dateM = text.match(DATE_RE);
  if (versionM && dateM) {
    const start = Math.min(versionM.index, dateM.index);
    const end = Math.max(versionM.index + versionM[0].length, dateM.index + dateM[0].length);
    return { state: 'present', rawValue: text.slice(start, end).trim(), form: 'version_date' };
  }
  const phraseM = text.match(CURRENCY_PHRASE_RE);
  if (phraseM) return { state: 'present', rawValue: phraseM[0].trim(), form: 'dated' };
  if (versionM) return { state: 'present', rawValue: versionM[0].trim(), form: 'version_only' };
  if (dateM) return NON_CURRENCY_CONTEXT.some((re) => re.test(text))
    ? ABSENT
    : { state: 'indeterminate', rawValue: null, form: null };
  return ABSENT;
}

module.exports = { detectCurrency };
