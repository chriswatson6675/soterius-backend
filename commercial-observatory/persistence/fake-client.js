'use strict';

// A minimal in-memory fake Supabase client for Commercial Observatory
// persistence tests — supports exactly the query-builder chains db.js uses:
// .insert(rows).select(cols).single(); .select(cols).eq().maybeSingle();
// .select(cols).eq().order().(then|single); .update(obj).eq().select().single().
//
// Simulates migration 050's database-level append-only triggers: an
// .update()/.delete() call against one of the five insert-only tables
// rejects, exactly as the real trigger would (commercial_authority_drafts
// is simulated separately — it allows updates but rejects a content change).

const APPEND_ONLY_TABLES = new Set([
  'commercial_claims',
  'commercial_evidence',
  'commercial_relationship_observations',
  'commercial_discoveries',
  'commercial_agent_events',
]);

let idCounter = 0;
function nextId() { idCounter += 1; return `fake-id-${idCounter}`; }

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
          const inserted = newRows.map((r) => ({
            id: nextId(),
            created_at: '2026-07-14T00:00:00.000Z',
            ...defaultsFor(table),
            ...r,
          }));
          rows.push(...inserted);
          return {
            select() {
              return {
                single: () => Promise.resolve({ data: inserted[0], error: null }),
              };
            },
          };
        },

        update(patch) {
          if (APPEND_ONLY_TABLES.has(table)) {
            return {
              eq() {
                return {
                  select() {
                    return {
                      single: () => Promise.resolve({ data: null, error: { message: `${table} is append-only and immutable: UPDATE is not permitted` } }),
                    };
                  },
                };
              },
            };
          }
          if (table === 'commercial_authority_drafts' && ('content' in patch || 'investigation_id' in patch)) {
            return {
              eq() {
                return {
                  select() {
                    return {
                      single: () => Promise.resolve({ data: null, error: { message: 'commercial_authority_drafts.content is immutable once written' } }),
                    };
                  },
                };
              },
            };
          }

          let filtered = rows;
          const builder = {
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return builder;
            },
            select() {
              return {
                single() {
                  if (!filtered.length) return Promise.resolve({ data: null, error: { message: 'no matching row' } });
                  Object.assign(filtered[0], patch);
                  return Promise.resolve({ data: filtered[0], error: null });
                },
              };
            },
          };
          return builder;
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
            limit(n) {
              filtered = filtered.slice(0, n);
              return builder;
            },
            single() {
              if (!filtered.length) return Promise.resolve({ data: null, error: { message: 'no matching row' } });
              return Promise.resolve({ data: filtered[0], error: null });
            },
            maybeSingle() {
              return Promise.resolve({ data: filtered[0] || null, error: null });
            },
            then(resolve) {
              resolve(isHeadCount ? { data: null, error: null, count: filtered.length } : { data: filtered, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

function defaultsFor(table) {
  if (table === 'commercial_investigations') return { status: 'pending', step_count: 0, source_count: 0 };
  if (table === 'commercial_dossiers') return { version: 1, updated_at: '2026-07-14T00:00:00.000Z' };
  if (table === 'commercial_claims') return { status: 'active' };
  if (table === 'commercial_authority_drafts') return { review_state: 'pending', reviewed_by: null, reviewed_at: null, rejection_reason: null };
  return {};
}

module.exports = { createFakeClient };
