'use strict';

// batch-adapter-contract.js — the Population Acquisition Engine's Batch Adapter
// Contract (WP-1, ENG-024). Defines responsibilities only: parse → validate
// source structure → normalise → emit canonical Organisation source records.
// INFRASTRUCTURE ONLY: no Repository Authority merge, no Domain Discovery, no
// validation beyond source structure. See README.md and ENG-018 §3.
//
// The canonical record shape below is the one backend/authority/loaders.js
// already defines and merges — copied here, not imported, so this contract
// has no dependency on Repository Authority (ENG-018 §3's boundary holds in
// both directions: PAE never calls in, and is never called from, that layer
// during WP-1). Any future change to the shape is made in loaders.js first,
// per that module's own header ("normalisation happens once... rules live in
// exactly one place"), and mirrored here.
//
// `frcAudit`, `hmrcAml`, `pbsFirm` were added per GCN-004 (Identity-Namespace
// Extension & Key-Precedence Disposition, Founder-registered 2026-07-07),
// mirroring the same three fields added to loaders.js's documented shape and
// to organisation/identity.js's primaryKeyOf precedence (ENG-027 §2/§3.2).
// `lei` was already present in this list before GCN-004 (it predates the
// disposition as a collected-but-not-yet-precedence-ranked field); GCN-004
// §E.5 only changes how `lei` is *used* downstream (union-consistency,
// precedence tail) — it requires no field-list change here.
const CANONICAL_RECORD_FIELDS = [
  'source', 'regulator', 'name', 'namePriority',
  'frn', 'sraNumber', 'ukprn', 'companyNumber', 'lei', 'ifUuid',
  'frcAudit', 'hmrcAml', 'pbsFirm',
  'domainRaw', 'domainSource', 'domainPriority', 'noDomainAsserted',
  'sourceDate', 'provenance',
];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Structural validation of one canonical record — presence of every required
 * field and the minimal shape of `provenance`. Does not validate values (a
 * batch adapter's own `normalise` is responsible for producing correct
 * values); this is the contract's own backstop against a record silently
 * missing a field Repository Authority's merge substrate expects.
 * @returns {string[]} empty if the record conforms
 */
function validateCanonicalRecord(record, index) {
  if (!isPlainObject(record)) return [`record[${index}] is not an object`];
  const errors = [];
  for (const field of CANONICAL_RECORD_FIELDS) {
    if (!(field in record)) errors.push(`record[${index}] missing required field "${field}"`);
  }
  if ('provenance' in record) {
    const p = record.provenance;
    if (!isPlainObject(p) || typeof p.file !== 'string' || !p.file || typeof p.key !== 'string' || !p.key) {
      errors.push(`record[${index}] provenance must be { file: string, key: string }`);
    }
  }
  if ('source' in record && (typeof record.source !== 'string' || !record.source)) {
    errors.push(`record[${index}] source must be a non-empty string`);
  }
  return errors;
}

/**
 * Assert an object conforms to the Batch Adapter shape: a string `sourceId`
 * and three functions. Throws TypeError naming every missing/malformed piece
 * at once, rather than failing on the first `runBatchAdapter` call — adapter
 * authors get one clear error, not a cryptic "x is not a function" mid-run.
 */
function assertIsBatchAdapter(adapter) {
  const problems = [];
  if (!isPlainObject(adapter)) {
    throw new TypeError('batch adapter must be an object with { sourceId, parse, validateStructure, normalise }');
  }
  if (typeof adapter.sourceId !== 'string' || !adapter.sourceId) problems.push('sourceId must be a non-empty string');
  for (const fn of ['parse', 'validateStructure', 'normalise']) {
    if (typeof adapter[fn] !== 'function') problems.push(`${fn} must be a function`);
  }
  if (problems.length) {
    throw new TypeError(`batch adapter does not conform to the Batch Adapter Contract: ${problems.join('; ')}`);
  }
}

/**
 * Normalise whatever `validateStructure` returned into { valid, rejected }.
 * Accepted shapes:
 *   - { valid: Row[], rejected: { index, row, reason }[] }
 *   - Row[] (every row treated as valid — adapters with no structural
 *     rejections at all may return the array directly)
 */
function coerceStructureResult(result, rows) {
  if (Array.isArray(result)) {
    return { valid: result, rejected: [] };
  }
  if (isPlainObject(result) && Array.isArray(result.valid)) {
    const rejected = Array.isArray(result.rejected) ? result.rejected : [];
    return { valid: result.valid, rejected };
  }
  throw new TypeError(
    'validateStructure() must return either an array of valid rows, or { valid: Row[], rejected: {index,row,reason}[] }'
  );
}

function nowIso(context) {
  return typeof context.now === 'function' ? context.now() : new Date().toISOString();
}

/**
 * Execute one batch adapter against one raw input. Enforces the contract's
 * stage order (parse → validateStructure → normalise → emit) and produces the
 * shared reporting shape every batch adapter returns, regardless of source.
 *
 * Error handling: a stage throwing is treated as fatal to this run (the whole
 * input is unusable — e.g. a corrupt file) and returned as `fatalError`,
 * never thrown past this function, so a caller driving many imports can
 * treat every adapter run uniformly. Row-level structural rejections and
 * canonical-shape rejections at emit are never fatal — they are captured
 * per-row in `rejections` and the run completes with whatever it could emit
 * (ENG-016 §4.1: never silently dropped, never fatal to the whole import).
 *
 * @param {{sourceId:string, parse:Function, validateStructure:Function, normalise:Function}} adapter
 * @param {*} rawInput - whatever this adapter's parse() accepts
 * @param {{now?:Function}} [context]
 * @returns {Promise<Object>} BatchAdapterResult
 */
async function runBatchAdapter(adapter, rawInput, context = {}) {
  assertIsBatchAdapter(adapter);
  const startedAt = nowIso(context);

  const fail = (stage, error) => ({
    sourceId: adapter.sourceId,
    startedAt,
    completedAt: nowIso(context),
    stage,
    rowsParsed: 0,
    rowsRejected: 0,
    recordsEmitted: 0,
    records: [],
    rejections: [],
    fatalError: { stage, message: error.message },
  });

  let rows;
  try {
    rows = await adapter.parse(rawInput, context);
  } catch (err) {
    return fail('parse', err);
  }
  if (!Array.isArray(rows)) {
    return fail('parse', new TypeError(`${adapter.sourceId}.parse() must return an array of rows`));
  }

  let structureResult;
  try {
    structureResult = await adapter.validateStructure(rows, context);
  } catch (err) {
    return fail('validateStructure', err);
  }
  let valid, rejected;
  try {
    ({ valid, rejected } = coerceStructureResult(structureResult, rows));
  } catch (err) {
    return fail('validateStructure', err);
  }

  let records;
  try {
    records = await adapter.normalise(valid, context);
  } catch (err) {
    return fail('normalise', err);
  }
  if (!Array.isArray(records)) {
    return fail('normalise', new TypeError(`${adapter.sourceId}.normalise() must return an array of canonical records`));
  }

  const emitted = [];
  const emitRejections = [];
  records.forEach((record, index) => {
    const errors = validateCanonicalRecord(record, index);
    if (errors.length) emitRejections.push({ stage: 'emit', index, record, reason: errors.join('; ') });
    else emitted.push(record);
  });

  const structureRejections = rejected.map((r) => ({
    stage: 'validateStructure',
    index: r.index,
    row: r.row,
    reason: r.reason,
  }));

  return {
    sourceId: adapter.sourceId,
    startedAt,
    completedAt: nowIso(context),
    stage: 'complete',
    rowsParsed: rows.length,
    rowsRejected: structureRejections.length + emitRejections.length,
    recordsEmitted: emitted.length,
    records: emitted,
    rejections: [...structureRejections, ...emitRejections],
    fatalError: null,
  };
}

module.exports = {
  CANONICAL_RECORD_FIELDS,
  validateCanonicalRecord,
  assertIsBatchAdapter,
  runBatchAdapter,
};
