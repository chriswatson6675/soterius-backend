'use strict';

// A minimal in-memory fake Supabase client for the Domain Discovery Pilot's
// persistence tests, mirroring commercial-observatory/persistence/fake-client.js's
// DI convention exactly: supports .insert(rows).select().single().

let idCounter = 0;
function nextId() { idCounter += 1; return `fake-ddp-id-${idCounter}`; }

function createFakeClient() {
  const tables = {};
  function tableRows(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  return {
    _tables: tables,
    from(table) {
      const rows = tableRows(table);
      return {
        insert(newRows) {
          const inserted = newRows.map((r) => ({ id: nextId(), created_at: '2026-07-15T00:00:00.000Z', ...r }));
          rows.push(...inserted);
          return {
            select() {
              return { single: () => Promise.resolve({ data: inserted[0], error: null }) };
            },
          };
        },
        select(_cols, options = {}) {
          let filtered = rows;
          const isHeadCount = options && options.head === true;
          const builder = {
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return builder;
            },
            order(col, { ascending } = {}) {
              filtered = [...filtered].sort((a, b) => {
                if (a[col] === b[col]) return 0;
                return ascending ? (a[col] < b[col] ? -1 : 1) : (a[col] > b[col] ? -1 : 1);
              });
              return builder;
            },
            limit(n) { filtered = filtered.slice(0, n); return builder; },
            single() {
              if (!filtered.length) return Promise.resolve({ data: null, error: { message: 'no matching row' } });
              return Promise.resolve({ data: filtered[0], error: null });
            },
            maybeSingle() { return Promise.resolve({ data: filtered[0] || null, error: null }); },
            then(resolve) { resolve(isHeadCount ? { data: null, error: null, count: filtered.length } : { data: filtered, error: null }); },
          };
          return builder;
        },
      };
    },
  };
}

module.exports = { createFakeClient };
