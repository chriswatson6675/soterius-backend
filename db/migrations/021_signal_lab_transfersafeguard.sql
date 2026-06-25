-- ── Migration 021: Signal Lab — Transfer Safeguard Facts Table ─────────────────
-- Creates signal_transfersafeguard_v1 for observable Transfer Safeguard facts
-- (SOT-TRANSFERSAFEGUARD-001 / H-SIG-003, element DE-PAD-016).
-- Mirrors migrations 019/020 exactly; only the evidence-value columns differ.
--
-- Authority: SOT-TRANSFERSAFEGUARD-001 (Signal Spec) / DE-PAD-016 (Element Spec) /
--   SLG-026 / GATE-H1B / GATE-H1C / EM-H-D1 / ADR-SYS-001 / ADR-SYS-006.
--
-- Four-state located_state (EM-H-D1): located | not_located | retrieval_failure | ambiguous.
-- Three-state evidence_state (set ONLY when located): present | absent | indeterminate; else NULL.
--   present       — a named Art 46 transfer-safeguard mechanism observed (named_mechanism)
--   absent        — disclosure read; no named mechanism (incl. generic "appropriate safeguards")
--   indeterminate — partial/empty retrieval
-- INTEGRITY INVARIANT (EM-H-D1): non-located rows can NEVER carry evidence (evidence_only_when_located).
-- transfer_form (present only): named_mechanism — THE ONLY admissible form (single-value CHECK).
-- Reproducibility (GATE-H2): content_observed = exact detector input; content_hash = sha256.
-- Apply via Supabase Dashboard -> SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS signal_transfersafeguard_v1 (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID        NOT NULL,
  domain               TEXT        NOT NULL,

  signal_version       INTEGER     NOT NULL DEFAULT 1,
  collector_version    TEXT        NOT NULL,
  element_set_version  TEXT        NOT NULL DEFAULT 'pad-v1',
  collected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  located_state        TEXT        NOT NULL
                         CHECK (located_state IN ('located','not_located','retrieval_failure','ambiguous')),

  evidence_state       TEXT
                         CHECK (evidence_state IN ('present','absent','indeterminate')),
  transfer_raw_value   TEXT,
  transfer_form        TEXT
                         CHECK (transfer_form IN ('named_mechanism')),

  policy_url           TEXT,
  retrieval_method     TEXT
                         CHECK (retrieval_method IN ('static','headless')),
  http_status          INTEGER,
  content_hash         TEXT,
  content_observed     TEXT,

  evidence             JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT evidence_only_when_located
    CHECK (located_state = 'located' OR evidence_state IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_transfersafeguard_run_id ON signal_transfersafeguard_v1 (run_id);
CREATE INDEX IF NOT EXISTS idx_transfersafeguard_domain ON signal_transfersafeguard_v1 (domain);
