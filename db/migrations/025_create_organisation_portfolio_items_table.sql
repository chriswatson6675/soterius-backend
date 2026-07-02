-- ── Migration 025: create organisation_portfolio_items table ─────────────────
-- Phase 4A — Customer Platform Architecture (customer tenancy foundation).
-- A customer's tracked-organisations list (ADR-SYS-007's "portfolio"). Adding
-- an organisation to a portfolio requires no verification — that is a
-- separate, later concern (organisation_claims, out of scope for this slice).
-- is_home marks at most one portfolio item per tenant as the verified home
-- organisation once a claim workflow exists.
--
-- Schema only in this slice: no read/write functions or routes are built
-- against this table yet (nothing in the current implementation queries it).
--
-- TRACKED DEBT (per Phase 4A ratification review, finding R-03):
-- organisation_id references prospects.id because the Organisation Registry
-- API (WS3, C-04) does not exist yet. This FK target is provisional and MUST
-- be repointed at the Registry's canonical organisation id when WS3 lands —
-- via a tracked migration with an explicit backfill, not silently. Do not
-- onboard real customers onto this table until either WS3 has landed or a
-- tested repointing migration exists.

CREATE TABLE IF NOT EXISTS organisation_portfolio_items (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id      uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  organisation_id  uuid        NOT NULL REFERENCES prospects(id), -- provisional FK target — see debt note above
  is_home          boolean     NOT NULL DEFAULT false,
  added_by_user_id uuid        NOT NULL REFERENCES auth.users(id),
  added_at         timestamptz NOT NULL DEFAULT now()
);

-- An organisation appears at most once in a given tenant's portfolio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_items_customer_org
  ON organisation_portfolio_items (customer_id, organisation_id);

-- At most one home organisation per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_items_one_home_per_customer
  ON organisation_portfolio_items (customer_id) WHERE is_home;

-- Portfolio listing for a tenant (the common query).
CREATE INDEX IF NOT EXISTS idx_portfolio_items_customer_id
  ON organisation_portfolio_items (customer_id);

-- RLS enabled with no policies — see migration 022/023 rationale. All access
-- goes through the backend's service-role connection.
ALTER TABLE organisation_portfolio_items ENABLE ROW LEVEL SECURITY;
