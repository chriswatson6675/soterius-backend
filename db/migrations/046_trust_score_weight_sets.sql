-- ── Migration 046: Trust Score Weight Sets ──────────────────────────────────
-- ENG-026 (Canonical Trust Score Aggregator) §9 — the versioned weight-set
-- artifact TSW-METH-v1.0 (SLG-135) regenerates per National Observatory
-- Baseline. Per SLG-135 §0's governing principle ("methodology is frozen;
-- weights are derived"), the Aggregator (backend/observatory/aggregation/
-- trust-score-aggregator.js) must never hardcode a weight table in
-- application code — it reads the single active row here instead.
--
-- Exactly one row is is_active = true at any time (application-level
-- invariant, enforced by the regeneration tooling — not yet built, ENG-026
-- §14.4 — and, until then, by hand when a new weight set is inserted).
--
-- Bootstrap row: SLG-135 Appendix C (TSW-W-NOB), the informative/regenerable
-- reference weight set, inserted here as the first row per ENG-026 §14.4 to
-- unblock Aggregator implementation ahead of the regeneration tooling.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only
-- for DDL). Idempotent.

CREATE TABLE IF NOT EXISTS trust_score_weight_sets (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  weight_set_id           TEXT        NOT NULL UNIQUE,          -- e.g. 'TSW-W-NOB-BOOTSTRAP-001'
  method_version          TEXT        NOT NULL,                 -- 'TSW-METH-v1.0'
  source_baseline_run_id  TEXT        NOT NULL,                 -- SLG-003 Run Register identity
  weights                 JSONB       NOT NULL,                 -- { spf, dkim, dmarc, dnssec, caa, securityheaders, securitytxt, tls, certificate, mtasts } — sums to 999
  is_active               BOOLEAN     NOT NULL DEFAULT false,
  generated_at            TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT trust_score_weight_sets_sum_999 CHECK (
    (
      COALESCE((weights->>'spf')::numeric, 0) + COALESCE((weights->>'dkim')::numeric, 0) +
      COALESCE((weights->>'dmarc')::numeric, 0) + COALESCE((weights->>'dnssec')::numeric, 0) +
      COALESCE((weights->>'caa')::numeric, 0) + COALESCE((weights->>'securityheaders')::numeric, 0) +
      COALESCE((weights->>'securitytxt')::numeric, 0) + COALESCE((weights->>'tls')::numeric, 0) +
      COALESCE((weights->>'certificate')::numeric, 0) + COALESCE((weights->>'mtasts')::numeric, 0)
    ) = 999
  )
);

CREATE INDEX IF NOT EXISTS idx_trust_score_weight_sets_active ON trust_score_weight_sets (is_active) WHERE is_active;

-- Enforce "exactly one active row" at the database layer, not just application-level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trust_score_weight_sets_one_active
  ON trust_score_weight_sets ((is_active)) WHERE is_active;

-- Bootstrap: SLG-135 Appendix C (TSW-W-NOB), re-verified per ENG-026 §14.3 —
-- signal_quality_securityheaders (migration 035) is live, so the Appendix C
-- "provisional" caveat on Security Headers no longer applies.
INSERT INTO trust_score_weight_sets (weight_set_id, method_version, source_baseline_run_id, weights, is_active, generated_at)
VALUES (
  'TSW-W-NOB-BOOTSTRAP-001',
  'TSW-METH-v1.0',
  'SLG-135-APPENDIX-C',
  '{"dmarc": 154, "spf": 111, "dkim": 108, "dnssec": 83, "caa": 70, "securityheaders": 143, "securitytxt": 47, "certificate": 124, "tls": 94, "mtasts": 65}'::jsonb,
  true,
  NOW()
)
ON CONFLICT (weight_set_id) DO NOTHING;
