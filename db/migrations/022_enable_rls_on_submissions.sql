-- ── Migration 022: enable Row Level Security on submissions ────────────────────
-- Corrective migration. The submissions table was created with RLS disabled
-- (see 000_create_submissions_table.sql, reproducing the original 2026-06-09 state).
-- Every other public table already has RLS enabled; submissions was the lone
-- exception, which is what Supabase's Security Advisor flags as "RLS Disabled in Public".
--
-- WHY THIS IS SAFE:
--   All application DB access goes through the backend using the service-role key
--   (services/database.js → createClient(url, SUPABASE_SERVICE_ROLE_KEY)). The
--   service-role key bypasses RLS entirely, so enabling RLS does not affect the app.
--   The frontend never touches Supabase directly — it only calls the Express backend.
--
-- EFFECT:
--   With RLS enabled and NO policies defined, the anon and authenticated roles get
--   default-deny on this table via the PostgREST Data API — closing the hole where
--   the public anon key could read/write submissions directly, bypassing the backend.
--   No policies are added intentionally: nothing should reach this table except the
--   backend service-role connection.
--
-- Idempotent: enabling RLS on an already-enabled table is a no-op.

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Verification (run after applying):
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.submissions'::regclass;
-- Expected: t (true)
