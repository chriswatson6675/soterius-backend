-- ── Migration 045: SECURITY DEFINER function hardening (least privilege) ─────
--
-- Production security hardening ONLY. Additive; modifies NO previously-applied
-- migration, NO table, NO evidence schema, and NO function BODY. It changes only
-- two things about existing functions: their configured search_path and their
-- EXECUTE privileges. Because it uses ALTER FUNCTION / REVOKE / GRANT (never
-- CREATE OR REPLACE), the executable body of every function is provably unchanged,
-- so functional behaviour is identical.
--
-- ── Review of every function in the public schema (2026-07-12) ───────────────
--
--   observatory_table_sizes()                 SECURITY DEFINER  → HARDENED here
--   prune_storage_capacity_snapshots(integer) SECURITY INVOKER  → grants tightened here
--   rls_auto_enable()                         SECURITY DEFINER  → OUT OF SCOPE (see note)
--   events_reject_mutation()                  SECURITY INVOKER  → no change (see note)
--
-- observatory_table_sizes() — SECURITY DEFINER retained, not removed.
--   Is DEFINER strictly required? Not for the intended caller: the backend calls
--   it with the service_role key, and reading pg_total_relation_size / pg_class is
--   not privilege-gated, so SECURITY INVOKER would also work for service_role.
--   However, flipping DEFINER→INVOKER would change the function's SECURITY CONTEXT
--   (a behavioural change this task forbids) and remove a defense-in-depth
--   guarantee. We therefore KEEP SECURITY DEFINER and instead close its real
--   attack surface:
--     * an unset search_path on a DEFINER function is a privilege-escalation
--       vector (object-resolution hijacking) — we pin it to pg_catalog, pg_temp
--       (the function references only pg_catalog objects, so this is behaviour-
--       preserving); and
--     * default privileges granted EXECUTE to PUBLIC, anon and authenticated —
--       we revoke all three and grant EXECUTE to service_role ONLY. Table sizes
--       and row estimates are now readable only by the backend's service role,
--       not by anonymous PostgREST callers.
--
-- prune_storage_capacity_snapshots(integer) — SECURITY INVOKER (already), so the
--   DEFINER-injection concern does not apply. But it performs a DELETE and, by
--   Supabase default, is EXECUTE-able by PUBLIC/anon/authenticated. Least
--   privilege: revoke those and grant service_role only. We also pin its
--   search_path (INCLUDING public, since it targets public.storage_capacity_
--   snapshots) so its target table cannot be shadowed via a caller's search_path.
--   It can only ever delete telemetry snapshots — never evidence.
--
-- rls_auto_enable() — SECURITY DEFINER, but NOT an Observatory function and NOT
--   created by any Observatory migration; it is platform/tenancy infrastructure
--   (RLS auto-enablement) and already carries search_path=pg_catalog. It is
--   deliberately left UNCHANGED: altering a function this stream does not own,
--   whose invocation model is external, risks breaking table-creation behaviour.
--   Its PUBLIC EXECUTE grant is flagged for the tenancy/RLS owner, not changed here.
--
-- events_reject_mutation() — SECURITY INVOKER trigger function (blocks UPDATE/
--   DELETE on events). INVOKER is correct for a trigger; not a DEFINER function,
--   so out of this migration's mandate. Left unchanged.
--
-- Apply via backend/tooling/db/apply-migration.js --confirm. Idempotent
-- (ALTER/REVOKE/GRANT are naturally re-runnable).

-- ── observatory_table_sizes() — DEFINER function: pin search_path + least priv ──
ALTER FUNCTION observatory_table_sizes() SET search_path = pg_catalog, pg_temp;

REVOKE ALL ON FUNCTION observatory_table_sizes() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION observatory_table_sizes() TO service_role;

-- ── prune_storage_capacity_snapshots(integer) — least privilege (+ search_path) ─
ALTER FUNCTION prune_storage_capacity_snapshots(integer)
  SET search_path = public, pg_catalog, pg_temp;

REVOKE ALL ON FUNCTION prune_storage_capacity_snapshots(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION prune_storage_capacity_snapshots(integer) TO service_role;
