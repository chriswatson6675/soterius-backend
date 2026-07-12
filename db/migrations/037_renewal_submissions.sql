-- 037_renewal_submissions.sql
--
-- renewal_submissions — Renewal-Experience-owned state, per ADR-SYS-010 OC-7
-- ("Experiences MUST NOT own Organisation state"). Everything a solicitor
-- types into a renewal (fee income today; claims, risk narratives, etc. in
-- later Renewal sections) lives here, keyed by the canonical Organisation id
-- as a plain reference column — never inside the Organisation object itself.
--
-- v0.1 scope: one Renewal-entered fact (fee income). `answers` is JSONB so
-- v0.2's additional Renewal sections don't each require a new migration; it
-- is not a general-purpose escape hatch for Organisation data.

CREATE TABLE IF NOT EXISTS renewal_submissions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   TEXT        NOT NULL,   -- references organisation.identity's ORG-* id (no FK — Organisation has no table yet, v0.2)
  cycle_year        INTEGER     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'in_progress',

  -- Renewal-owned applicant answers. v0.1: {feeIncomeLastCompleted, feeIncomeEstimate}.
  answers           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT renewal_submissions_status_check CHECK (status IN ('in_progress', 'submitted'))
);

CREATE INDEX IF NOT EXISTS renewal_submissions_organisation_id_idx
  ON renewal_submissions (organisation_id, cycle_year);
