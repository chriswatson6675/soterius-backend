-- Migration 018: SOT-REGISTRAR-001 — Registrar Trust Signal
-- Table: signal_registrar_v1
--
-- Authority:
--   SOT-REGISTRAR-001 v1.0 — Specification Freeze v1.0
--   ITA-REGISTRAR-001 — Implementation Transition Authorisation (Option B: Authorised with Conditions)
--   LCR-REGISTRAR-001 — Post-ITA Lifecycle Review (ITA-REGISTRAR-001 is terminal pre-collection artefact)
--   ADR-SYS-006 (JSONB evidence blocks — v1 schema)
--
-- Storage model (SOT-REGISTRAR-001 §7.3):
--   One row per unique registrar IANA ID per collection run.
--   This is architecturally distinct from all other Category E signals, which store one row
--   per domain per run. Domain-to-registrar joins use registrar_iana_id shared between
--   signal_registrar_v1 and signal_domainregistration_v1.
--   7 scalar fields promoted to indexed columns per §7.3.
--   16-field JSONB evidence block per §7.1.
--   No scores, ratings, or interpretations (Signal Lab rule).
--   upstream_run_id links to the SOT-DOMAINREGISTRATION-001 run that provided the IANA IDs.
--
-- Assessment unit (SOT-REGISTRAR-001 §5.3 + §7.3):
--   One ICANN database query per unique registrar IANA ID per run.
--   Null IANA IDs (IANA_ID_ABSENT outcome) do NOT produce rows in this table.
--   The deduplication query excludes null IANA IDs before collection begins:
--     SELECT DISTINCT registrar_iana_id FROM signal_domainregistration_v1
--     WHERE run_id = {upstream_run_id} AND registrar_iana_id IS NOT NULL
--
-- Data source (ITA-REGISTRAR-001 Condition 3 / ICANN Scope 1):
--   IANA Registrar IDs XHTML dataset — www.iana.org/assignments/registrar-ids/registrar-ids.xhtml
--   Provides: registrar_name, registrar_accreditation_status, registrar RDAP URL
--   Does NOT provide in v1.0: country_code, accreditation_date, raa_version,
--     ssad_participant, abuse_email_published, abuse_telephone_published
--   These fields are null in v1.0 and must not be inferred or approximated.
--
-- icann_query_outcome values (Amendment 1 — four-state; SOT-REGISTRAR-001 §7.2):
--   QUERY_SUCCESS  — ICANN dataset queried; record found; registrar_accreditation_status set
--   NOT_FOUND      — ICANN dataset queried; IANA ID not in dataset (ccTLD-only registrar expected)
--   QUERY_ERROR    — ICANN dataset download or parse failed; all evidence fields null
--   Note: IANA_ID_ABSENT rows are not stored — null IANA IDs are filtered before collection.
--
-- registrar_accreditation_status values (Amendment 1 — three-state; SOT-REGISTRAR-001 §7.2):
--   ACCREDITED  — Active ICANN accreditation
--   SUSPENDED   — Accreditation suspended
--   TERMINATED  — Accreditation terminated
--   Null when icann_query_outcome != QUERY_SUCCESS. MUST be null for NOT_FOUND and QUERY_ERROR.
--
-- Null semantics for promoted scalar columns:
--   registrar_accreditation_status (text, nullable):
--     Non-null only when icann_query_outcome = QUERY_SUCCESS.
--     Null on NOT_FOUND, QUERY_ERROR. DO NOT ADD NOT NULL.
--
--   registrar_country_code (text, nullable):
--     Always null in v1.0 — IANA dataset does not expose country per registrar IANA ID.
--     Future v1.x: populate from richer ICANN contracted parties data source.
--     DO NOT ADD NOT NULL.
--
--   registrar_raa_version (text, nullable):
--     Always null in v1.0 — IANA dataset does not expose RAA version per IANA ID.
--     DO NOT ADD NOT NULL.
--
--   registrar_ssad_participant (boolean, nullable):
--     Always null in v1.0 — IANA dataset does not expose SSAD participation per IANA ID.
--     DO NOT ADD NOT NULL OR DEFAULT FALSE.
--
-- Rerun strategy:
--   run_id groups all rows from a single registrar collection run.
--   (run_id, registrar_iana_id) is UNIQUE: prevents duplicate inserts within one run.
--   upstream_run_id records which SOT-DOMAINREGISTRATION-001 run provided the IANA IDs.
--   A new run_id must be generated for each new registrar collector execution.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once (IF NOT EXISTS guards on all objects).

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_registrar_v1 (

  id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                uuid        NOT NULL,
  upstream_run_id       uuid        NOT NULL,
  collected_at          timestamptz NOT NULL,
  signal_version        text        NOT NULL,
  collector_version     text        NOT NULL,

  -- ── Promoted scalar columns ────────────────────────────────────────────────
  -- 7 columns per SOT-REGISTRAR-001 §7.3.
  -- registrar_iana_id NOT NULL: rows are only stored for actual IANA IDs.
  -- Null IANA IDs (IANA_ID_ABSENT) do not produce rows.

  -- Primary evidence key
  registrar_iana_id              text        NOT NULL,

  -- Query-level outcome (four-state; always non-null for stored rows)
  -- Note: IANA_ID_ABSENT is valid per spec vocabulary but does not produce rows.
  icann_query_outcome            text        NOT NULL,

  -- Accreditation state (three-state; null when icann_query_outcome != QUERY_SUCCESS)
  -- DO NOT ADD NOT NULL — null is meaningful here (NOT_FOUND, QUERY_ERROR outcomes)
  registrar_accreditation_status text,

  -- Jurisdiction (ISO 3166-1 alpha-2; null in v1.0 — IANA dataset limitation)
  -- DO NOT ADD NOT NULL — always null in v1.0
  registrar_country_code         text,

  -- RAA version in force (null in v1.0 — IANA dataset limitation)
  -- DO NOT ADD NOT NULL
  registrar_raa_version          text,

  -- SSAD participation (tristate boolean; null in v1.0 — IANA dataset limitation)
  -- DO NOT ADD NOT NULL OR DEFAULT FALSE. null != false here.
  registrar_ssad_participant     boolean,

  -- Timestamp at which the ICANN dataset query was executed for this IANA ID
  icann_query_timestamp          timestamptz NOT NULL,

  -- ── Full JSONB evidence block ──────────────────────────────────────────────
  -- Contains the complete §7.1 evidence object (16 fields).
  -- All 16 keys present in every row; inapplicable fields are JSON null.
  -- No field is omitted. Conforms to ADR-SYS-001 (evidence preservation).
  --
  -- Field list (SOT-REGISTRAR-001 §7.1):
  --
  --   RD-01 — ICANN Accreditation Evidence (6 fields):
  --     icann_query_outcome, registrar_accreditation_status, registrar_iana_id,
  --     registrar_name, registrar_accreditation_date, registrar_raa_version
  --
  --   RD-02 — Registrar Jurisdictional Identity (3 fields):
  --     registrar_country_code, registrar_country_name, registrar_registrant_country_alignment
  --
  --   RD-03 — Registrar Governance Transparency (5 fields):
  --     registrar_ssad_participant, registrar_abuse_email_published,
  --     registrar_abuse_telephone_published, registrar_whois_policy_published,
  --     registrar_registration_agreement_published
  --
  --   Collection context (2 fields):
  --     icann_query_timestamp, icann_query_iana_id
  --
  -- v1.0 null fields (IANA dataset does not provide; always JSON null):
  --   registrar_country_code, registrar_country_name, registrar_registrant_country_alignment,
  --   registrar_accreditation_date, registrar_raa_version, registrar_ssad_participant,
  --   registrar_abuse_email_published, registrar_abuse_telephone_published
  --
  -- Always null in v1.0 (Scope 3 not implemented):
  --   registrar_whois_policy_published, registrar_registration_agreement_published
  evidence                       jsonb       NOT NULL,

  created_at                     timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  -- Query outcome: four-state vocabulary (SOT-REGISTRAR-001 §7.2)
  -- Includes IANA_ID_ABSENT for completeness even though those rows are not stored.
  CONSTRAINT srrv1_icann_query_outcome_values CHECK (
    icann_query_outcome IN (
      'QUERY_SUCCESS',
      'NOT_FOUND',
      'IANA_ID_ABSENT',
      'QUERY_ERROR'
    )
  ),

  -- Accreditation status: three-state vocabulary (SOT-REGISTRAR-001 §7.2)
  -- Nullable; null permitted when icann_query_outcome != QUERY_SUCCESS.
  CONSTRAINT srrv1_accreditation_status_values CHECK (
    registrar_accreditation_status IS NULL OR
    registrar_accreditation_status IN ('ACCREDITED', 'SUSPENDED', 'TERMINATED')
  ),

  -- Amendment 1 enforcement: accreditation_status must be null when outcome != QUERY_SUCCESS
  -- (SOT-REGISTRAR-001 §7.2 — vocabulary separation constraint)
  CONSTRAINT srrv1_accreditation_status_null_when_not_success CHECK (
    icann_query_outcome = 'QUERY_SUCCESS' OR registrar_accreditation_status IS NULL
  ),

  -- Country code format: ISO 3166-1 alpha-2 (exactly 2 uppercase letters)
  -- Null permitted — always null in v1.0.
  CONSTRAINT srrv1_country_code_format CHECK (
    registrar_country_code IS NULL OR
    registrar_country_code ~ '^[A-Z]{2}$'
  ),

  -- Version strings must not be empty when present
  CONSTRAINT srrv1_signal_version_non_empty CHECK (signal_version <> ''),
  CONSTRAINT srrv1_collector_version_non_empty CHECK (collector_version <> ''),

  -- One row per unique registrar IANA ID per run (deduplication invariant)
  CONSTRAINT srrv1_run_registrar_unique UNIQUE (run_id, registrar_iana_id)

);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access: run context
CREATE INDEX IF NOT EXISTS idx_srrv1_run_id
  ON signal_registrar_v1 (run_id);

-- Upstream lineage: join back to source SOT-DOMAINREGISTRATION-001 run
CREATE INDEX IF NOT EXISTS idx_srrv1_upstream_run_id
  ON signal_registrar_v1 (upstream_run_id);

-- Primary evidence key: registrar identity
CREATE INDEX IF NOT EXISTS idx_srrv1_registrar_iana_id
  ON signal_registrar_v1 (registrar_iana_id);

-- Collection timeline
CREATE INDEX IF NOT EXISTS idx_srrv1_icann_query_timestamp
  ON signal_registrar_v1 (icann_query_timestamp DESC);

-- Query outcome — supports QUERY_ERROR retry queries and anomaly filtering
CREATE INDEX IF NOT EXISTS idx_srrv1_icann_query_outcome
  ON signal_registrar_v1 (icann_query_outcome);

-- Accreditation status — primary benchmarking dimension (excludes null rows)
CREATE INDEX IF NOT EXISTS idx_srrv1_accreditation_status
  ON signal_registrar_v1 (registrar_accreditation_status)
  WHERE registrar_accreditation_status IS NOT NULL;

-- Accredited-only partial index — most common benchmarking filter
CREATE INDEX IF NOT EXISTS idx_srrv1_accreditation_status_accredited
  ON signal_registrar_v1 (registrar_iana_id, icann_query_timestamp DESC)
  WHERE registrar_accreditation_status = 'ACCREDITED';

-- Jurisdiction analysis (null in v1.0 — index is forward-compatible for v1.x)
CREATE INDEX IF NOT EXISTS idx_srrv1_country_code
  ON signal_registrar_v1 (registrar_country_code)
  WHERE registrar_country_code IS NOT NULL;

-- RAA version distribution (null in v1.0 — index is forward-compatible for v1.x)
CREATE INDEX IF NOT EXISTS idx_srrv1_raa_version
  ON signal_registrar_v1 (registrar_raa_version)
  WHERE registrar_raa_version IS NOT NULL;

-- SSAD participation (null in v1.0 — index is forward-compatible for v1.x)
-- Tristate boolean: null excluded from SSAD rate calculations
CREATE INDEX IF NOT EXISTS idx_srrv1_ssad_participant
  ON signal_registrar_v1 (registrar_ssad_participant)
  WHERE registrar_ssad_participant IS NOT NULL;

-- JSONB evidence — GIN index enables @>, jsonpath, and jsonb_path_query operations
CREATE INDEX IF NOT EXISTS idx_srrv1_evidence_gin
  ON signal_registrar_v1 USING GIN (evidence);

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_registrar_v1'
--  ORDER BY ordinal_position;
--
-- Expected: 17 columns.
-- Confirm registrar_accreditation_status IS NULLABLE (not NOT NULL).
-- Confirm registrar_country_code IS NULLABLE (null in v1.0).
-- Confirm registrar_raa_version IS NULLABLE (null in v1.0).
-- Confirm registrar_ssad_participant IS NULLABLE (not NOT NULL, not DEFAULT FALSE).
-- Confirm evidence IS NOT NULL.
-- Confirm icann_query_outcome IS NOT NULL.
-- Confirm registrar_iana_id IS NOT NULL.
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_registrar_v1'
--  ORDER BY indexname;
--
-- Expected: 13 indexes (1 implicit PK + 12 explicit CREATE INDEX).
--
-- SELECT conname, contype, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'signal_registrar_v1'::regclass
--  ORDER BY conname;
--
-- Expected: 7 constraints (6 CHECK + 1 UNIQUE).
-- Constraint names: srrv1_accreditation_status_null_when_not_success,
--   srrv1_accreditation_status_values, srrv1_collector_version_non_empty,
--   srrv1_country_code_format, srrv1_icann_query_outcome_values,
--   srrv1_run_registrar_unique, srrv1_signal_version_non_empty.
--
-- Domain-to-registrar join (core benchmarking query pattern):
--
-- SELECT
--   d.domain,
--   d.registrar_iana_id,
--   r.registrar_accreditation_status,
--   r.registrar_country_code
-- FROM signal_domainregistration_v1 d
-- JOIN signal_registrar_v1 r
--   ON r.registrar_iana_id = d.registrar_iana_id
--  AND r.upstream_run_id   = d.run_id
-- WHERE d.run_id = '<domainregistration_run_id>';
