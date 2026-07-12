'use strict';

// contract-extractor.js — derives the "declared contract" of a migration file
// directly from its own SQL text: which tables/columns/constraints/indexes/
// functions/triggers/views/RLS-grants/extensions it creates or adds.
//
// This is deliberately NOT a hand-maintained spec per migration (that would
// drift from the actual .sql files and silently go stale). It is a small
// static SQL parser over the migration's own text, so the "contract" is
// always exactly what the file says it does — the source of truth is the
// migration, not a second description of it.
//
// Pure, no DB access — unit-testable in isolation. Consumed by `migrate.js
// audit`, which compares the extracted contract against the live catalog.

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, ' ');
}

// Find the index of the ')' matching the '(' at openIdx, respecting single-
// quoted string literals (so a literal like 'it''s' or a paren inside a
// string doesn't unbalance the count).
function findMatchingParen(sql, openIdx) {
  let depth = 0;
  let inQuote = false;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inQuote && sql[i + 1] === "'") { i++; continue; } // escaped '' inside a literal
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Split a comma-separated list at top level only (depth 0, outside quotes) —
// so `NUMERIC(5,2)` or `CHECK (x IN ('a','b'))` don't get split internally.
function splitTopLevel(str) {
  const items = [];
  let depth = 0, inQuote = false, current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'") {
      if (inQuote && str[i + 1] === "'") { current += ch + str[i + 1]; i++; continue; }
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { items.push(current.trim()); current = ''; continue; }
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function extractQuotedLiterals(text) {
  return (text.match(/'(?:[^']|'')*'/g) || []).map((s) => s.slice(1, -1).replace(/''/g, "'"));
}

// ── CREATE TABLE (...) ──────────────────────────────────────────────────────
// Returns { name, columns: [{name, inlinePrimaryKey, references}], namedConstraints,
//           unnamedConstraints, inlineColumnChecks }
function parseCreateTables(sql) {
  const tables = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const tableName = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(sql, openIdx);
    if (closeIdx === -1) continue;
    const body = sql.slice(openIdx + 1, closeIdx);
    const items = splitTopLevel(body);

    const columns = [];
    const namedConstraints = []; // {name, kind, raw}
    const unnamedConstraints = []; // {kind, raw}
    const inlineColumnChecks = []; // {column, literals}

    for (const item of items) {
      const trimmed = item.trim();

      const named = trimmed.match(/^constraint\s+"?([a-z0-9_]+)"?\s+([\s\S]*)$/i);
      if (named) {
        const cname = named[1].toLowerCase();
        const rest = named[2];
        const kind = classifyConstraintKind(rest);
        namedConstraints.push({ name: cname, kind, raw: rest });
        continue;
      }
      if (/^primary\s+key\s*\(/i.test(trimmed)) { unnamedConstraints.push({ kind: 'primary_key', raw: trimmed }); continue; }
      if (/^unique\s*\(/i.test(trimmed)) { unnamedConstraints.push({ kind: 'unique', raw: trimmed }); continue; }
      if (/^check\s*\(/i.test(trimmed)) { unnamedConstraints.push({ kind: 'check', raw: trimmed }); continue; }
      if (/^foreign\s+key\s*\(/i.test(trimmed)) { unnamedConstraints.push({ kind: 'foreign_key', raw: trimmed }); continue; }

      // Otherwise: a column definition — first token is the column name.
      const colMatch = trimmed.match(/^"?([a-z0-9_]+)"?\s+/i);
      if (colMatch) {
        const colName = colMatch[1].toLowerCase();
        const inlinePrimaryKey = /primary\s+key/i.test(trimmed);
        const refMatch = trimmed.match(/references\s+"?([a-z0-9_]+)"?/i);
        columns.push({ name: colName, inlinePrimaryKey, references: refMatch ? refMatch[1].toLowerCase() : null });

        const checkIdx = trimmed.search(/\bcheck\s*\(/i);
        if (checkIdx !== -1) {
          const literals = extractQuotedLiterals(trimmed.slice(checkIdx));
          if (literals.length) inlineColumnChecks.push({ column: colName, literals });
        }
      }
    }

    tables.push({ name: tableName, columns, namedConstraints, unnamedConstraints, inlineColumnChecks });
  }
  return tables;
}

function classifyConstraintKind(rest) {
  if (/^primary\s+key/i.test(rest)) return 'primary_key';
  if (/^unique/i.test(rest)) return 'unique';
  if (/^check/i.test(rest)) return 'check';
  if (/^foreign\s+key/i.test(rest)) return 'foreign_key';
  return 'other';
}

// ── ALTER TABLE ... (comma-separated clause list) ...; ─────────────────────
function parseAlterTableStatements(sql) {
  const results = [];
  const re = /alter\s+table\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?\s+([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1].toLowerCase();
    const clauses = splitTopLevel(m[2]);
    results.push({ table, clauses });
  }
  return results;
}

function parseAlterClauses(sql) {
  const addColumns = [];      // {table, column}
  const addConstraints = [];  // {table, name, kind, raw}
  const rlsEnables = [];      // {table}

  for (const stmt of parseAlterTableStatements(sql)) {
    for (const clause of stmt.clauses) {
      let m;
      if ((m = clause.match(/^add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/i))) {
        addColumns.push({ table: stmt.table, column: m[1].toLowerCase() });
      } else if ((m = clause.match(/^add\s+constraint\s+"?([a-z0-9_]+)"?\s+([\s\S]*)/i))) {
        const name = m[1].toLowerCase();
        const rest = m[2];
        addConstraints.push({ table: stmt.table, name, kind: classifyConstraintKind(rest), raw: rest });
      } else if (/^enable\s+row\s+level\s+security/i.test(clause)) {
        rlsEnables.push({ table: stmt.table });
      }
      // DROP CONSTRAINT clauses are intentionally not tracked as findings — in
      // this codebase's idempotent DROP-then-ADD pattern, the paired ADD
      // CONSTRAINT (same migration or a later one) declares the final expected
      // state, which is what the audit needs to check.
    }
  }
  return { addColumns, addConstraints, rlsEnables };
}

function parseCreateIndexes(sql) {
  const results = [];
  const re = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+"?([a-z0-9_]+)"?/gi;
  let m;
  while ((m = re.exec(sql))) results.push({ name: m[1].toLowerCase(), table: m[2].toLowerCase() });
  return results;
}

function parseFunctions(sql) {
  const results = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+"?([a-z0-9_]+)"?\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) results.push({ name: m[1].toLowerCase() });
  return results;
}

function parseTriggers(sql) {
  const results = [];
  const re = /create\s+trigger\s+"?([a-z0-9_]+)"?\s+[\s\S]*?\bon\s+"?([a-z0-9_]+)"?/gi;
  let m;
  while ((m = re.exec(sql))) results.push({ name: m[1].toLowerCase(), table: m[2].toLowerCase() });
  return results;
}

function parseViews(sql) {
  const results = [];
  const re = /create\s+(?:or\s+replace\s+)?view\s+"?([a-z0-9_]+)"?/gi;
  let m;
  while ((m = re.exec(sql))) results.push({ name: m[1].toLowerCase() });
  return results;
}

function parseExtensions(sql) {
  const results = [];
  const re = /create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi;
  let m;
  while ((m = re.exec(sql))) results.push(m[1].toLowerCase());
  return results;
}

// Dynamic SQL (DO $$ ... $$ blocks, EXECUTE format(...)) is invisible to every
// regex above — a migration that builds its DDL from a string template (e.g.
// looping ALTER TABLE across N tables) will report zero statically-declared
// objects even though it genuinely creates/drops things at runtime. Flagging
// this lets the audit report "not verifiable" instead of a false, vacuous PASS.
function detectDynamicDdl(sql) {
  const clean = stripComments(sql);
  const hasDoBlock = /do\s*\$\$/i.test(clean);
  const hasExecuteFormat = /execute\s+format\s*\(/i.test(clean);
  if (!hasDoBlock && !hasExecuteFormat) return null;
  const looksLikeDdl = /(create\s+table|create\s+index|alter\s+table|drop\s+column|add\s+column|create\s+function|drop\s+constraint|add\s+constraint)/i.test(
    clean
  );
  return { present: true, looksLikeDdl };
}

// ── Public entry point ──────────────────────────────────────────────────────
// extractContract(sql) -> {
//   tables: [{name, columns, namedConstraints, unnamedConstraints, inlineColumnChecks}],
//   addColumns, addConstraints, rlsEnables, indexes, functions, triggers, views, extensions
// }
// `addConstraints` merges ALTER-table ADD CONSTRAINT with CREATE TABLE's inline
// CONSTRAINT clauses into one uniform, strictly name-checkable list.
function extractContract(sql) {
  const clean = stripComments(sql);
  const tables = parseCreateTables(clean);
  const { addColumns, addConstraints: alterConstraints, rlsEnables } = parseAlterClauses(clean);

  const addConstraints = [...alterConstraints];
  for (const t of tables) {
    for (const nc of t.namedConstraints) {
      addConstraints.push({ table: t.name, name: nc.name, kind: nc.kind, raw: nc.raw });
    }
  }

  return {
    tables,
    addColumns,
    addConstraints,
    rlsEnables,
    indexes: parseCreateIndexes(clean),
    functions: parseFunctions(clean),
    triggers: parseTriggers(clean),
    views: parseViews(clean),
    extensions: parseExtensions(clean),
    dynamicDdl: detectDynamicDdl(clean),
  };
}

module.exports = {
  extractContract,
  extractQuotedLiterals,
  detectDynamicDdl,
  // exported for unit tests on the parser internals
  stripComments,
  findMatchingParen,
  splitTopLevel,
  parseCreateTables,
  parseAlterClauses,
  parseCreateIndexes,
  parseFunctions,
  parseTriggers,
  parseViews,
  parseExtensions,
};
