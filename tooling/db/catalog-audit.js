'use strict';

// catalog-audit.js — compares a migration's extracted contract (see
// contract-extractor.js) against a snapshot of the LIVE database catalog and
// produces one finding per declared object.
//
// Every finding has:
//   presence: 'present' | 'absent'   — does an object of that name/kind exist at all
//   status:   'ok' | 'warn' | 'fail' — how well it matches what the migration declared
//   object, message
//
// `presence` lets the caller do a lightweight "how much of this pending
// migration is already live?" tally without invoking the stricter `status`
// semantics (which are only meaningful for migrations the ledger claims are
// applied). `status` drives the applied-migration verdict.
//
// Named constraints get a strict check: not just "does a constraint with this
// name exist", but "does its live definition contain every literal value the
// migration declared" — e.g. a widened CHECK ... IN ('A','B','C') must
// actually contain A, B, and C live. A constraint name colliding with an
// EARLIER migration's same-named-but-narrower constraint (the exact class of
// bug that let migration 042 appear applied when it wasn't) surfaces as FAIL,
// not as a false "exists, therefore fine".
//
// Unnamed constraints (bare PRIMARY KEY(...)/UNIQUE(...)/CHECK(...)/FOREIGN
// KEY(...) inside a CREATE TABLE, or an inline column-level CHECK) cannot be
// matched unambiguously by name, so they are checked as best-effort soft
// matches capped at 'warn' — never 'fail' — to avoid false positives from
// imperfect static parsing.

const { extractQuotedLiterals } = require('./contract-extractor');

function ok(object, message) { return { object, presence: 'present', status: 'ok', message }; }
function absent(object, message) { return { object, presence: 'absent', status: 'fail', message }; }
function warn(object, message, presence = 'present') { return { object, presence, status: 'warn', message }; }
function fail(object, message, presence = 'present') { return { object, presence, status: 'fail', message }; }

function checkContract(contract, catalog) {
  const findings = [];

  // ── Tables + their columns ────────────────────────────────────────────────
  for (const t of contract.tables) {
    if (!catalog.tableSet.has(t.name)) {
      findings.push(absent(`table ${t.name}`, 'declared by CREATE TABLE but the table does not exist live'));
      continue; // nothing further to check meaningfully for this table
    }
    findings.push(ok(`table ${t.name}`, 'exists live'));

    const liveCols = catalog.columnsByTable.get(t.name) || new Set();
    for (const col of t.columns) {
      if (liveCols.has(col.name)) {
        findings.push(ok(`${t.name}.${col.name}`, 'column exists live'));
      } else {
        findings.push(absent(`${t.name}.${col.name}`, 'column declared by CREATE TABLE but missing live'));
      }
    }

    for (const col of t.columns.filter((c) => c.inlinePrimaryKey)) {
      const hasPk = (catalog.constraintsByTable.get(t.name) || []).some(
        (c) => c.contype === 'p' && c.definition.toLowerCase().includes(col.name)
      );
      findings.push(
        hasPk
          ? ok(`${t.name}.${col.name} (PK)`, 'inline PRIMARY KEY matched live')
          : warn(`${t.name}.${col.name} (PK)`, 'column declares inline PRIMARY KEY but no matching primary-key constraint found live')
      );
    }

    for (const col of t.columns.filter((c) => c.references)) {
      const hasFk = (catalog.constraintsByTable.get(t.name) || []).some(
        (c) => c.contype === 'f' && c.definition.toLowerCase().includes(col.references)
      );
      findings.push(
        hasFk
          ? ok(`${t.name}.${col.name} (FK)`, `REFERENCES ${col.references} matched live`)
          : warn(`${t.name}.${col.name} (FK)`, `column declares REFERENCES ${col.references} but no matching foreign-key constraint found live`)
      );
    }

    for (const cc of t.inlineColumnChecks) {
      const liveChecks = (catalog.constraintsByTable.get(t.name) || []).filter((c) => c.contype === 'c');
      const match = liveChecks.some((c) => {
        const def = c.definition.toLowerCase();
        return cc.literals.every((lit) => def.includes(lit.toLowerCase()));
      });
      findings.push(
        match
          ? ok(`${t.name}.${cc.column} (inline CHECK)`, 'a matching CHECK constraint was found live')
          : warn(`${t.name}.${cc.column} (inline CHECK)`, `no live CHECK constraint on ${t.name} contains all declared values [${cc.literals.join(', ')}] — best-effort match (unnamed constraint)`)
      );
    }

    for (const uc of t.unnamedConstraints) {
      findings.push(checkUnnamedConstraint(t.name, uc, catalog));
    }
  }

  // ── ALTER TABLE ADD COLUMN ────────────────────────────────────────────────
  for (const col of contract.addColumns) {
    if (!catalog.tableSet.has(col.table)) {
      findings.push(absent(`${col.table}.${col.column}`, `ALTER TABLE ADD COLUMN declared but table ${col.table} does not exist live`));
      continue;
    }
    const liveCols = catalog.columnsByTable.get(col.table) || new Set();
    findings.push(
      liveCols.has(col.column)
        ? ok(`${col.table}.${col.column}`, 'column exists live')
        : absent(`${col.table}.${col.column}`, 'column declared by ALTER TABLE ADD COLUMN but missing live')
    );
  }

  // ── Named constraints (strict — the class of check that catches 042) ─────
  for (const c of contract.addConstraints) {
    const liveList = catalog.constraintsByTable.get(c.table) || [];
    const live = liveList.find((x) => x.name === c.name);
    if (!live) {
      findings.push(absent(`${c.table}.${c.name}`, `constraint (${c.kind}) declared but does not exist live on ${c.table}`));
      continue;
    }
    const expectedLiterals = extractQuotedLiterals(c.raw);
    if (expectedLiterals.length) {
      const liveDef = live.definition.toLowerCase();
      const missing = expectedLiterals.filter((lit) => !liveDef.includes(lit.toLowerCase()));
      if (missing.length) {
        findings.push(
          fail(
            `${c.table}.${c.name}`,
            `constraint "${c.name}" exists on ${c.table} but its live definition is missing declared value(s) [${missing.join(', ')}] — ` +
              `the name matches but the definition is stale, most likely inherited from an EARLIER migration that reused this constraint ` +
              `name and this migration's own DROP+ADD never actually ran. This is precisely the class of bug that let migration 042 read ` +
              `as applied while its widened status set and completion columns were absent.`
          )
        );
        continue;
      }
    }
    findings.push(ok(`${c.table}.${c.name}`, `constraint exists and its definition contains all declared value(s)`));
  }

  // ── RLS ────────────────────────────────────────────────────────────────────
  for (const rls of contract.rlsEnables) {
    const live = catalog.rlsByTable.get(rls.table);
    findings.push(
      live === true
        ? ok(`${rls.table} (RLS)`, 'row-level security is enabled live')
        : absent(`${rls.table} (RLS)`, 'ALTER TABLE ENABLE ROW LEVEL SECURITY declared but RLS is not enabled live')
    );
  }

  // ── Indexes ────────────────────────────────────────────────────────────────
  for (const idx of contract.indexes) {
    const liveIdx = catalog.indexesByTable.get(idx.table);
    findings.push(
      liveIdx && liveIdx.has(idx.name)
        ? ok(`${idx.table}.${idx.name}`, 'index exists live')
        : absent(`${idx.table}.${idx.name}`, 'index declared by CREATE INDEX but does not exist live')
    );
  }

  // ── Functions ──────────────────────────────────────────────────────────────
  for (const fn of contract.functions) {
    findings.push(
      catalog.functionSet.has(fn.name)
        ? ok(`function ${fn.name}`, 'function exists live')
        : absent(`function ${fn.name}`, 'function declared by CREATE FUNCTION but does not exist live')
    );
  }

  // ── Triggers ───────────────────────────────────────────────────────────────
  for (const tr of contract.triggers) {
    const liveTrig = catalog.triggersByTable.get(tr.table);
    findings.push(
      liveTrig && liveTrig.has(tr.name)
        ? ok(`${tr.table}.${tr.name} (trigger)`, 'trigger exists live')
        : absent(`${tr.table}.${tr.name} (trigger)`, 'trigger declared by CREATE TRIGGER but does not exist live')
    );
  }

  // ── Views ──────────────────────────────────────────────────────────────────
  for (const v of contract.views) {
    findings.push(
      catalog.viewSet.has(v.name)
        ? ok(`view ${v.name}`, 'view exists live')
        : absent(`view ${v.name}`, 'view declared by CREATE VIEW but does not exist live')
    );
  }

  // ── Extensions ─────────────────────────────────────────────────────────────
  for (const ext of contract.extensions) {
    findings.push(
      catalog.extensionSet.has(ext)
        ? ok(`extension ${ext}`, 'extension is installed live')
        : absent(`extension ${ext}`, 'extension declared by CREATE EXTENSION but is not installed live')
    );
  }

  return findings;
}

function checkUnnamedConstraint(table, uc, catalog) {
  const live = catalog.constraintsByTable.get(table) || [];
  const label = `${table} (unnamed ${uc.kind})`;
  if (uc.kind === 'check') {
    const literals = extractQuotedLiterals(uc.raw);
    const match = live
      .filter((c) => c.contype === 'c')
      .some((c) => literals.every((lit) => c.definition.toLowerCase().includes(lit.toLowerCase())));
    return match
      ? ok(label, 'a matching CHECK constraint was found live')
      : warn(label, `no live CHECK constraint on ${table} contains all declared values — best-effort match (unnamed constraint)`);
  }
  const typeMap = { primary_key: 'p', unique: 'u', foreign_key: 'f' };
  const contype = typeMap[uc.kind];
  const has = live.some((c) => c.contype === contype);
  return has
    ? ok(label, `a live ${uc.kind} constraint was found on ${table}`)
    : warn(label, `no live ${uc.kind} constraint found on ${table} — best-effort match (unnamed constraint)`);
}

module.exports = { checkContract };
