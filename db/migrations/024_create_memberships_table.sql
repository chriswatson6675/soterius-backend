-- ── Migration 024: create memberships table ───────────────────────────────────
-- Phase 4A — Customer Platform Architecture (customer tenancy foundation).
-- Joins a Supabase auth user to a customer (tenant), carrying a tenant-scoped
-- role. Schema is many-to-many (customer_id, user_id) so a second employee at
-- a firm, or later an adviser managing multiple tenants, needs no migration —
-- but see the single-tenancy constraint below before treating it as such.
--
-- SINGLE-TENANCY CONSTRAINT (deliberate, not an oversight):
-- ADR-SYS-007 §3.2 states, as an accepted decision, that "users belong to
-- exactly one tenant." A many-to-many table with no matching constraint would
-- let the database silently permit what that ADR forbids, relying entirely on
-- application code to hold the line — this was flagged as finding G-01 in the
-- Phase 4A ratification review and is fixed here at creation, not after the
-- fact. UNIQUE(user_id) enforces one membership row per user today. If a
-- future ADR-SYS-011 (multi-tenant-per-user) is ratified, that ADR authorises
-- a follow-on migration to drop this constraint in favour of the compound
-- UNIQUE(customer_id, user_id) below — not before.

CREATE TABLE IF NOT EXISTS memberships (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_role text        NOT NULL DEFAULT 'member' CHECK (tenant_role IN ('owner', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enforces ADR-SYS-007 §3.2 (one tenant per user) at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_id
  ON memberships (user_id);

-- Redundant with the above while single-tenancy holds, but this is the
-- constraint that remains correct if UNIQUE(user_id) is ever relaxed —
-- a membership row is never duplicated for the same (customer, user) pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_customer_user
  ON memberships (customer_id, user_id);

-- Lists members of a tenant (owner-facing member management, future).
CREATE INDEX IF NOT EXISTS idx_memberships_customer_id
  ON memberships (customer_id);

-- RLS enabled with no policies — see migration 022/023 rationale. All access
-- goes through the backend's service-role connection.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
