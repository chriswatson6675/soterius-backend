-- Migration 013: SOT-SECURITYTXT-001 — Disclosure & Transparency Signal
-- Table: signal_securitytxt_v1
--
-- Storage model:
--   Single evidence-preserving table. All collector output stored verbatim.
--   No flattening of JSONB evidence. No scores, ratings, or interpretations.
--   JSONB structures match the frozen SOT-SECURITYTXT-001 v1 schema exactly.
--
-- Evidence model:
--   canonical_fetch  — FetchResult for /.well-known/security.txt (always present)
--   legacy_fetch     — FetchResult for /security.txt (always present)
--   canonical_parse  — ParsedContent | null (null unless canonical fetch_state = FOUND)
--   legacy_parse     — ParsedContent | null (null unless legacy fetch_state = FOUND)
--
-- file_state values (from SOT-SECURITYTXT-001 v1 FileState enum):
--   PRESENT_CANONICAL    — file found at /.well-known/security.txt only
--   PRESENT_LEGACY_ONLY  — file found at /security.txt only (not at canonical)
--   PRESENT_BOTH         — file found at both locations
--   ABSENT               — no file found at either location
--   INDETERMINATE        — at least one fetch hit a blocking error (TIMEOUT, CONNECTION_ERROR, SERVER_ERROR)
--
-- Rerun strategy:
--   run_id groups all rows from a single cohort run.
--   (run_id, domain) is unique: prevents duplicate inserts within one run.
--   Multiple run_ids per domain are allowed: historical reruns are preserved.
--   Query the latest run: WHERE run_id = (SELECT MAX(run_id) ... ORDER BY created_at DESC LIMIT 1)
--   or use the provided analysis queries which accept run_id as a parameter.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_securitytxt_v1 (

  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid        NOT NULL,
  domain            text        NOT NULL,
  collected_at      timestamptz NOT NULL,
  signal_version    text        NOT NULL,
  collector_version text        NOT NULL,
  file_state        text        NOT NULL,

  -- ── Full evidence blocks (JSONB) ───────────────────────────────────────────

  -- FetchResult for /.well-known/security.txt
  -- { url, fetch_state, http_status, content_type, redirect_chain,
  --   raw_content, raw_content_bytes }
  canonical_fetch   jsonb       NOT NULL,

  -- FetchResult for /security.txt
  legacy_fetch      jsonb       NOT NULL,

  -- ParsedContent | null
  -- { content_state, pgp_signed_body_raw, pgp_signature_raw,
  --   directive_lines, comment_lines, malformed_lines,
  --   directive_count, comment_line_count, malformed_line_count,
  --   blank_line_count, blank_line_positions, total_lines,
  --   known_field_count, unknown_field_count, unknown_fields,
  --   contact[], expires[], encryption[], acknowledgments[],
  --   policy[], preferred_languages[], hiring[], canonical[] }
  canonical_parse   jsonb,
  legacy_parse      jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  CONSTRAINT sstv1_file_state_values CHECK (
    file_state IN (
      'PRESENT_CANONICAL',
      'PRESENT_LEGACY_ONLY',
      'PRESENT_BOTH',
      'ABSENT',
      'INDETERMINATE'
    )
  ),

  CONSTRAINT sstv1_signal_version_non_empty CHECK (
    signal_version <> ''
  ),

  CONSTRAINT sstv1_collector_version_non_empty CHECK (
    collector_version <> ''
  ),

  -- canonical_parse null iff canonical fetch_state != FOUND
  -- (enforced in application; documented here for clarity — not enforced as SQL
  --  constraint because fetch_state lives inside JSONB)

  -- Unique per run: prevents re-inserting the same domain in the same run
  CONSTRAINT sstv1_run_domain_unique UNIQUE (run_id, domain)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access patterns

CREATE INDEX IF NOT EXISTS idx_sstv1_domain
  ON signal_securitytxt_v1 (domain);

CREATE INDEX IF NOT EXISTS idx_sstv1_domain_collected_at
  ON signal_securitytxt_v1 (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sstv1_collected_at
  ON signal_securitytxt_v1 (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sstv1_run_id
  ON signal_securitytxt_v1 (run_id);

-- File state queries

CREATE INDEX IF NOT EXISTS idx_sstv1_file_state
  ON signal_securitytxt_v1 (file_state);

CREATE INDEX IF NOT EXISTS idx_sstv1_file_state_present
  ON signal_securitytxt_v1 (file_state)
  WHERE file_state IN ('PRESENT_CANONICAL', 'PRESENT_LEGACY_ONLY', 'PRESENT_BOTH');

CREATE INDEX IF NOT EXISTS idx_sstv1_file_state_indeterminate
  ON signal_securitytxt_v1 (file_state)
  WHERE file_state = 'INDETERMINATE';

-- JSONB evidence — GIN indexes enable @>, jsonpath, and jsonb_path_query

CREATE INDEX IF NOT EXISTS idx_sstv1_canonical_fetch_gin
  ON signal_securitytxt_v1 USING GIN (canonical_fetch);

CREATE INDEX IF NOT EXISTS idx_sstv1_legacy_fetch_gin
  ON signal_securitytxt_v1 USING GIN (legacy_fetch);

CREATE INDEX IF NOT EXISTS idx_sstv1_canonical_parse_gin
  ON signal_securitytxt_v1 USING GIN (canonical_parse)
  WHERE canonical_parse IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sstv1_legacy_parse_gin
  ON signal_securitytxt_v1 USING GIN (legacy_parse)
  WHERE legacy_parse IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_securitytxt_v1'
--  ORDER BY ordinal_position;
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_securitytxt_v1';
