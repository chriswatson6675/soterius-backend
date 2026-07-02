-- ── Migration 023: create customers table ─────────────────────────────────────
-- Phase 4A — Customer Platform Architecture (customer tenancy foundation).
-- A customer is a tenant: a paying account (a firm), not a person. Deliberately
-- thin at first (plan/tier is a placeholder for the WS6 commercial tail — no
-- billing fields yet). Users relate to a customer via memberships (migration 024).
--
-- Governed-by: ADR-SYS-007 (Customer Authorisation Model — portfolios over a
-- shared observed corpus; tenancy on private objects only). This table is a
-- private object per that ADR.

CREATE TABLE IF NOT EXISTS customers (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text        NOT NULL,
  plan       text        NOT NULL DEFAULT 'trial', -- trial | standard (placeholder; WS6 commercial tail)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS enabled with no policies, matching the precedent set in migration 022:
-- all application access goes through the backend's service-role connection
-- (infra/database.js → createClient(url, SUPABASE_SERVICE_ROLE_KEY)), which
-- bypasses RLS. Enabling RLS with no policies closes the anon/authenticated
-- Data API off entirely for this table.
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
