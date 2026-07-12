'use strict';

// fake-supabase.js — a small STATEFUL in-memory fake of the Supabase/PostgREST
// query builder, for unit tests of the production-hardening modules. Unlike a
// call-recording stub, this actually stores rows, so tests can exercise real
// resume / idempotency / duplicate-prevention behaviour across simulated crashes
// and restarts against the same store.
//
// Not a *.test.js file, so `node --test` does not execute it directly.
//
// Supports the operations the ledger / executor / storage-monitor use:
//   from, insert, upsert({ onConflict, ignoreDuplicates }), update, delete,
//   select (incl. { count:'exact', head:true }), eq, in, gte, lte, not,
//   order, range, limit, single, maybeSingle, and awaiting the builder directly.

function createFakeSupabase(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const counters = {};

  function nextId(table) {
    counters[table] = (counters[table] || 0) + 1;
    return `${table}-${counters[table]}`;
  }
  function ensure(table) { if (!tables[table]) tables[table] = []; return tables[table]; }

  function matches(row, filters) {
    return filters.every((f) => {
      const v = row[f.col];
      switch (f.op) {
        case 'eq': return v === f.val;
        case 'in': return f.val.includes(v);
        case 'gte': return v >= f.val;
        case 'lte': return v <= f.val;
        case 'gt': return v > f.val;
        case 'lt': return v < f.val;
        case 'not': return f.mod === 'is' && f.val === null ? v != null : v !== f.val;
        default: return true;
      }
    });
  }

  function makeBuilder(table) {
    const state = {
      table,
      filters: [],
      op: 'select',
      payload: null,
      upsertOpts: null,
      selectCols: null,
      countOpts: null,
      orderBy: null,
      rangeArgs: null,
      limitN: null,
    };

    function execute() {
      const rows = ensure(state.table);

      if (state.op === 'insert') {
        const toInsert = (Array.isArray(state.payload) ? state.payload : [state.payload]).map((r) => ({
          id: r.id ?? nextId(state.table), ...r,
        }));
        rows.push(...toInsert);
        return finalizeRows(toInsert);
      }

      if (state.op === 'upsert') {
        const conflictCols = (state.upsertOpts?.onConflict || 'id').split(',').map((s) => s.trim());
        const ignore = Boolean(state.upsertOpts?.ignoreDuplicates);
        const affected = [];
        for (const r of (Array.isArray(state.payload) ? state.payload : [state.payload])) {
          const existing = rows.find((x) => conflictCols.every((c) => x[c] === r[c]));
          if (existing) {
            if (!ignore) Object.assign(existing, r);
            affected.push(existing);
          } else {
            const row = { id: r.id ?? nextId(state.table), ...r };
            rows.push(row);
            affected.push(row);
          }
        }
        return finalizeRows(affected);
      }

      if (state.op === 'update') {
        const affected = rows.filter((r) => matches(r, state.filters));
        for (const r of affected) Object.assign(r, state.payload);
        return finalizeRows(affected);
      }

      if (state.op === 'delete') {
        const keep = [], removed = [];
        for (const r of rows) (matches(r, state.filters) ? removed : keep).push(r);
        tables[state.table] = keep;
        return finalizeRows(removed);
      }

      // select
      let out = rows.filter((r) => matches(r, state.filters));
      if (state.orderBy) {
        const { col, ascending } = state.orderBy;
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending ? 1 : -1));
      }
      if (state.rangeArgs) out = out.slice(state.rangeArgs[0], state.rangeArgs[1] + 1);
      if (state.limitN != null) out = out.slice(0, state.limitN);
      if (state.countOpts?.head) return { data: null, error: null, count: rows.filter((r) => matches(r, state.filters)).length };
      const res = { data: out, error: null };
      if (state.countOpts) res.count = rows.filter((r) => matches(r, state.filters)).length;
      return res;
    }

    function finalizeRows(affected) {
      return { data: affected, error: null };
    }

    const builder = {
      from(t) { state.table = t; return builder; },
      insert(p) { state.op = 'insert'; state.payload = p; return builder; },
      upsert(p, opts) { state.op = 'upsert'; state.payload = p; state.upsertOpts = opts || {}; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      delete() { state.op = 'delete'; return builder; },
      select(cols, opts) { state.selectCols = cols; if (opts) state.countOpts = opts; return builder; },
      eq(col, val) { state.filters.push({ col, op: 'eq', val }); return builder; },
      in(col, val) { state.filters.push({ col, op: 'in', val }); return builder; },
      gte(col, val) { state.filters.push({ col, op: 'gte', val }); return builder; },
      lte(col, val) { state.filters.push({ col, op: 'lte', val }); return builder; },
      gt(col, val) { state.filters.push({ col, op: 'gt', val }); return builder; },
      lt(col, val) { state.filters.push({ col, op: 'lt', val }); return builder; },
      not(col, mod, val) { state.filters.push({ col, op: 'not', mod, val }); return builder; },
      order(col, opts = {}) { state.orderBy = { col, ascending: opts.ascending !== false }; return builder; },
      range(a, b) { state.rangeArgs = [a, b]; return builder; },
      limit(n) { state.limitN = n; return builder; },
      single() {
        const res = execute();
        if (res.error) return Promise.resolve(res);
        const row = (res.data || [])[0];
        if (!row) return Promise.resolve({ data: null, error: { message: 'no rows (single)' } });
        return Promise.resolve({ data: row, error: null });
      },
      maybeSingle() {
        const res = execute();
        if (res.error) return Promise.resolve(res);
        return Promise.resolve({ data: (res.data || [])[0] ?? null, error: null });
      },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return builder;
  }

  return {
    from(table) { return makeBuilder(table); },
    // test introspection
    _tables: tables,
    _rows(table) { return tables[table] || []; },
  };
}

module.exports = { createFakeSupabase };
