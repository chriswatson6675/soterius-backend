-- Migration 017: SOT-DOMAINREGISTRATION-001 — Domain Registration Facts Signal
-- Table: signal_domainregistration_v1
--
-- Authority:
--   SOT-DOMAINREGISTRATION-001 v1.4 — Specification Freeze v1.0
--   PSD-001 v1.2 — Privacy Service Reference Dataset Specification
--   PSD-DATA-001 v1.1 — Approved v1.0 Freeze (7 ACTIVE entries, PSP-001–PSP-007)
--   Migration 017 Design Assessment — Development Readiness A
--   Migration 017 Final Implementation Validation — A — APPROVED FOR SQL GENERATION
--   ITA-DOMAINREGISTRATION-001 — Implementation Transition Authorisation
--
-- Storage model:
--   ADR-SYS-006 (JSONB evidence blocks — v1 schema).
--   Full §7.1 evidence block in 'evidence' JSONB column (70 fields).
--   12 scalar fields promoted to indexed columns per SOT-DOMAINREGISTRATION-001 §11.
--   No scores, ratings, or interpretations stored (Signal Lab rule).
--   JSONB structure matches the evidence object from evidence-builder.js.
--
-- Collection model (SOT-DOMAINREGISTRATION-001 §5.3 + SLG-011):
--   Single authoritative RDAP query per domain per run via IANA bootstrap discovery.
--   Protocol-mandated redirects (RFC 7480 §5.2) followed within the request chain.
--   Protocol-optional registrar referral links (rel=related) NOT followed; URL
--   extracted and preserved in evidence.rdap_registrar_referral_url only.
--
-- endpoint_state values (five-state; SOT-DOMAINREGISTRATION-001 §6.1):
--   RDAP_RESPONSE_OBSERVED — RDAP registry returned a valid domain JSON object
--   DOMAIN_NOT_FOUND       — Registry returned HTTP 404 (domain not registered)
--   RDAP_ERROR             — Registry returned a non-404 error response
--   RDAP_NOT_SUPPORTED     — No RDAP endpoint registered for this TLD in IANA bootstrap
--   CONNECTION_ERROR       — Network-layer failure before HTTP response received
--
-- privacy_state values (four-state; SOT-DOMAINREGISTRATION-001 §6.2):
--   REGISTRANT_DATA  — Genuine registrant contact data is present
--   PRIVACY_SERVICE  — A known privacy service entity is the registrant of record
--   REDACTED         — RDAP response indicates registrant data is withheld (GDPR etc.)
--   ENTITY_ABSENT    — No registrant-role entity present in the RDAP response
--
-- Nullable promoted column semantics (SOT-DOMAINREGISTRATION-001 §7.1, §7.5):
--
--   privacy_state (text, nullable):
--     Non-null only when endpoint_state = RDAP_RESPONSE_OBSERVED.
--     Null on DOMAIN_NOT_FOUND, RDAP_ERROR, RDAP_NOT_SUPPORTED, CONNECTION_ERROR.
--
--   privacy_service_present (boolean, nullable — tristate):
--     Null in two distinct cases:
--       (a) endpoint_state != RDAP_RESPONSE_OBSERVED — RDAP evidence absent
--       (b) privacy_state = REDACTED or ENTITY_ABSENT — determination not possible
--     null ≠ false here. Null means "determination not possible", not "no privacy service".
--     Privacy adoption COP calculations must use WHERE privacy_service_present IS NOT NULL
--     as the denominator (excludes REDACTED and ENTITY_ABSENT from the rate).
--     DO NOT ADD NOT NULL OR DEFAULT FALSE TO THIS COLUMN.
--
--   transfer_lock_present, domain_active, pending_delete (boolean, nullable — tristate):
--     Null when status_codes is null (no status evidence in RDAP response).
--     null ≠ false. Null means "status codes not available", not "code absent".
--     Cohort calculations must exclude nulls from both numerator and denominator.
--     DO NOT ADD NOT NULL OR DEFAULT FALSE TO THESE COLUMNS.
--
--   domain_age_days, expiry_days_remaining (integer, nullable):
--     Negative values are valid and must be preserved:
--       domain_age_days < 0 — creation_date is in the future (data anomaly, preserve as-is)
--       expiry_days_remaining < 0 — domain has already expired at time of collection
--     DO NOT ADD LOWER-BOUND CHECK CONSTRAINTS TO THESE COLUMNS.
--
--   registrar_iana_id (text, nullable):
--     Stored as text even though IANA IDs are numeric — preserves leading zeros and
--     avoids lossy coercion when the registry returns a formatted string.
--
--   registrant_country_code (text, nullable):
--     ISO 3166-1 alpha-2 uppercase. Non-conforming raw values from the RDAP vCard
--     are null in this column; the raw value is preserved in evidence (registrant vCard).
--
--   privacy_service_provider_id (text, nullable):
--     PSP-NNN identifier from the privacy service reference list (PSD-001).
--     Non-null only when privacy_state = PRIVACY_SERVICE.
--     Format: 'PSP-' followed by one or more digits.
--
--   tld_type (text, nullable):
--     Null only when endpoint_state prevents TLD resolution (uncommon).
--     Values: GTLD | CCTLD | NEW_GTLD | SPONSORED | UNKNOWN.
--
-- Rerun strategy:
--   run_id groups all rows from a single domain registration collection run.
--   (run_id, domain) is unique: prevents duplicate inserts within one run.
--   Multiple run_ids per domain are allowed: historical reruns are preserved.
--   A new run_id must be generated for each new execution of the collector.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once (IF NOT EXISTS guards on all objects).

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_domainregistration_v1 (

  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid        NOT NULL,
  domain            text        NOT NULL,
  collected_at      timestamptz NOT NULL,
  signal_version    text        NOT NULL,
  collector_version text        NOT NULL,

  -- ── Promoted scalar columns ────────────────────────────────────────────────
  -- 12 columns per SOT-DOMAINREGISTRATION-001 §11.
  -- All nullable where the collector may not produce a value.
  -- See nullable semantics notes above before adding constraints.

  -- Collection outcome (always present — five-state vocabulary)
  endpoint_state               text        NOT NULL,

  -- Privacy state (null when endpoint_state != RDAP_RESPONSE_OBSERVED)
  -- Four-state vocabulary per SOT-DOMAINREGISTRATION-001 §6.2
  privacy_state                text,

  -- Privacy service adoption indicator (tristate boolean — see semantics above):
  --   true  = privacy_state is PRIVACY_SERVICE
  --   false = privacy_state is REGISTRANT_DATA
  --   null  = privacy_state is REDACTED or ENTITY_ABSENT, or endpoint not observed
  -- DO NOT ADD NOT NULL OR DEFAULT FALSE. null ≠ false here.
  privacy_service_present      boolean,

  -- PSP identifier from PSD-001 reference list (null when privacy_state != PRIVACY_SERVICE)
  -- Format: 'PSP-NNN' (e.g. 'PSP-001' for WhoisGuard, Inc.)
  privacy_service_provider_id  text,

  -- Registrar IANA accreditation ID (stored as text — preserves formatting)
  registrar_iana_id            text,

  -- Registrant country code (ISO 3166-1 alpha-2 uppercase; null if non-conforming or absent)
  registrant_country_code      text,

  -- Transfer lock status (tristate boolean — see semantics above):
  --   true  = clientTransferProhibited or serverTransferProhibited in EPP status codes
  --   false = status codes present but neither lock code present
  --   null  = status codes null (no status evidence available)
  -- DO NOT ADD NOT NULL OR DEFAULT FALSE.
  transfer_lock_present        boolean,

  -- Domain operationally active (tristate boolean — see semantics above):
  --   true  = 'ok' or 'active' in EPP status codes
  --   false = status codes present but neither active code present
  --   null  = status codes null
  domain_active                boolean,

  -- Domain pending deletion (tristate boolean — see semantics above):
  --   true  = 'pendingDelete' in EPP status codes
  --   false = status codes present but pendingDelete absent
  --   null  = status codes null
  pending_delete               boolean,

  -- TLD type classification (per SOT-DOMAINREGISTRATION-001 §7.4)
  -- Values: GTLD | CCTLD | NEW_GTLD | SPONSORED | UNKNOWN
  tld_type                     text,

  -- Domain age in days at collected_at (negative values valid — see semantics above)
  -- Derived: floor((collected_at - creation_date) / 1 day)
  domain_age_days              integer,

  -- Days until domain expiry at collected_at (negative = already expired — preserve as-is)
  -- Derived: floor((expiration_date - collected_at) / 1 day)
  expiry_days_remaining        integer,

  -- ── Full JSONB evidence block ──────────────────────────────────────────────
  -- Contains the complete §7.1 evidence object from evidence-builder.js.
  -- 70 top-level fields. All keys present in every row; inapplicable fields are
  -- JSON null. No field is omitted. Conforms to ADR-SYS-001 (evidence preservation).
  --
  -- Field groups:
  --   Collection context (7):
  --     endpoint_state, collected_at, collection_domain, rdap_endpoint_resolved,
  --     rdap_redirect_chain, error_code, error_message
  --
  --   Registration core (9):
  --     registry_domain_id, domain_name_ldh, domain_name_unicode,
  --     creation_date, expiration_date, last_update_date,
  --     nameservers, status_codes, event_history
  --
  --   RDAP protocol metadata (5):
  --     rdap_conformance, rdap_remarks, rdap_notices,
  --     rdap_self_link, rdap_registrar_referral_url
  --
  --   Registrar entity (6):
  --     registrar_name, registrar_iana_id, registrar_url,
  --     registrar_abuse_email, registrar_abuse_telephone, registrar_entity_handle
  --
  --   Privacy state (4):
  --     privacy_state, privacy_service_name, privacy_service_provider_id,
  --     privacy_service_detection_version
  --
  --   Registrant entity (12):
  --     registrant_org_name, registrant_full_name, registrant_email,
  --     registrant_telephone, registrant_address_street, registrant_address_city,
  --     registrant_address_state, registrant_address_postal,
  --     registrant_country_code, registrant_handle, registrant_roles,
  --     registrant_status_codes
  --
  --   Admin contact (6):
  --     admin_org_name, admin_full_name, admin_email,
  --     admin_telephone, admin_country_code, admin_handle
  --
  --   Technical contact (6):
  --     tech_org_name, tech_full_name, tech_email,
  --     tech_telephone, tech_country_code, tech_handle
  --
  --   TLD classification (4):
  --     tld_string, tld_type, tld_country_code, tld_classification_snapshot_date
  --
  --   Derived lifecycle (3):
  --     domain_age_days, expiry_days_remaining, registration_term_days
  --
  --   Derived status (5):
  --     privacy_service_present, transfer_lock_present, domain_active,
  --     pending_delete, server_hold_present
  --
  --   Future consideration — always JSON null in v1 (3):
  --     billing_contact, legacy_whois_text, rdap_entities_raw
  evidence                     jsonb       NOT NULL,

  created_at                   timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  -- Endpoint state: five-state vocabulary (SOT-DOMAINREGISTRATION-001 §6.1)
  -- NOT NULL enforced on column; this constraint validates the value set.
  CONSTRAINT sdrv1_endpoint_state_values CHECK (
    endpoint_state IN (
      'RDAP_RESPONSE_OBSERVED',
      'DOMAIN_NOT_FOUND',
      'RDAP_ERROR',
      'RDAP_NOT_SUPPORTED',
      'CONNECTION_ERROR'
    )
  ),

  -- Privacy state: four-state vocabulary (SOT-DOMAINREGISTRATION-001 §6.2)
  -- Nullable; null permitted when endpoint_state != RDAP_RESPONSE_OBSERVED.
  CONSTRAINT sdrv1_privacy_state_values CHECK (
    privacy_state IS NULL OR privacy_state IN (
      'REGISTRANT_DATA',
      'PRIVACY_SERVICE',
      'REDACTED',
      'ENTITY_ABSENT'
    )
  ),

  -- PSP identifier format: PSP- followed by one or more digits (PSD-001 §4.1)
  -- Null permitted when privacy_state != PRIVACY_SERVICE.
  CONSTRAINT sdrv1_psp_id_format CHECK (
    privacy_service_provider_id IS NULL OR
    privacy_service_provider_id ~ '^PSP-\d+$'
  ),

  -- Registrant country code format: ISO 3166-1 alpha-2 (exactly 2 uppercase letters)
  -- Null permitted when code is absent, redacted, or non-conforming.
  -- Non-conforming raw values are preserved in the evidence JSONB.
  CONSTRAINT sdrv1_country_code_format CHECK (
    registrant_country_code IS NULL OR
    registrant_country_code ~ '^[A-Z]{2}$'
  ),

  -- TLD type: five-value vocabulary (SOT-DOMAINREGISTRATION-001 §7.4)
  -- Nullable; null permitted when TLD classification cannot be determined.
  CONSTRAINT sdrv1_tld_type_values CHECK (
    tld_type IS NULL OR tld_type IN (
      'GTLD',
      'CCTLD',
      'NEW_GTLD',
      'SPONSORED',
      'UNKNOWN'
    )
  ),

  -- Version strings must not be empty when present
  CONSTRAINT sdrv1_signal_version_non_empty CHECK (
    signal_version <> ''
  ),

  CONSTRAINT sdrv1_collector_version_non_empty CHECK (
    collector_version <> ''
  ),

  -- Unique per run: prevents re-inserting the same domain in the same run.
  -- A new run_id must be generated for each new collector execution.
  CONSTRAINT sdrv1_run_domain_unique UNIQUE (run_id, domain)

);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access patterns

CREATE INDEX IF NOT EXISTS idx_sdrv1_domain
  ON signal_domainregistration_v1 (domain);

CREATE INDEX IF NOT EXISTS idx_sdrv1_domain_collected_at
  ON signal_domainregistration_v1 (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sdrv1_collected_at
  ON signal_domainregistration_v1 (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sdrv1_run_id
  ON signal_domainregistration_v1 (run_id);

-- Endpoint state queries

CREATE INDEX IF NOT EXISTS idx_sdrv1_endpoint_state
  ON signal_domainregistration_v1 (endpoint_state);

CREATE INDEX IF NOT EXISTS idx_sdrv1_endpoint_state_observed
  ON signal_domainregistration_v1 (endpoint_state)
  WHERE endpoint_state = 'RDAP_RESPONSE_OBSERVED';

-- Privacy state analysis
-- Partial indexes on non-null values exclude non-RDAP_RESPONSE_OBSERVED rows.
-- privacy_service_present IS NOT NULL is the correct denominator for adoption rate.

CREATE INDEX IF NOT EXISTS idx_sdrv1_privacy_state
  ON signal_domainregistration_v1 (privacy_state)
  WHERE privacy_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sdrv1_privacy_service_present
  ON signal_domainregistration_v1 (privacy_service_present)
  WHERE privacy_service_present IS NOT NULL;

-- Partial index for the most common privacy adoption query: WHERE = true
-- Supports rapid privacy-enrolled domain retrieval without filtering false rows.
CREATE INDEX IF NOT EXISTS idx_sdrv1_privacy_service_present_true
  ON signal_domainregistration_v1 (domain, collected_at DESC)
  WHERE privacy_service_present = true;

CREATE INDEX IF NOT EXISTS idx_sdrv1_privacy_service_provider_id
  ON signal_domainregistration_v1 (privacy_service_provider_id)
  WHERE privacy_service_provider_id IS NOT NULL;

-- Registrar identity — primary input for SOT-REGISTRAR-001 Scope 1
-- Supports registrar market share analysis and registrar-level benchmarking.

CREATE INDEX IF NOT EXISTS idx_sdrv1_registrar_iana_id
  ON signal_domainregistration_v1 (registrar_iana_id)
  WHERE registrar_iana_id IS NOT NULL;

-- Jurisdictional indicator — primary input for SOT-LEGALIDENTITY-001 scoping

CREATE INDEX IF NOT EXISTS idx_sdrv1_registrant_country_code
  ON signal_domainregistration_v1 (registrant_country_code)
  WHERE registrant_country_code IS NOT NULL;

-- Status boolean analysis
-- All three use partial indexes on IS NOT NULL to match the correct COP denominator.
-- null rows (no status evidence) are excluded from cohort rate calculations.

CREATE INDEX IF NOT EXISTS idx_sdrv1_transfer_lock_present
  ON signal_domainregistration_v1 (transfer_lock_present)
  WHERE transfer_lock_present IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sdrv1_domain_active
  ON signal_domainregistration_v1 (domain_active)
  WHERE domain_active IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sdrv1_pending_delete
  ON signal_domainregistration_v1 (pending_delete)
  WHERE pending_delete IS NOT NULL;

-- TLD classification and lifecycle — benchmarking dimensions

CREATE INDEX IF NOT EXISTS idx_sdrv1_tld_type
  ON signal_domainregistration_v1 (tld_type)
  WHERE tld_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sdrv1_domain_age_days
  ON signal_domainregistration_v1 (domain_age_days)
  WHERE domain_age_days IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sdrv1_expiry_days_remaining
  ON signal_domainregistration_v1 (expiry_days_remaining)
  WHERE expiry_days_remaining IS NOT NULL;

-- JSONB evidence — GIN index enables @>, jsonpath, and jsonb_path_query operations.
-- Required for evidence-field queries not covered by promoted scalar indexes
-- (e.g. rdap_registrar_referral_url, registrant_org_name, rdap_remarks).

CREATE INDEX IF NOT EXISTS idx_sdrv1_evidence_gin
  ON signal_domainregistration_v1 USING GIN (evidence);

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_domainregistration_v1'
--  ORDER BY ordinal_position;
--
-- Expected: 20 columns.
-- Confirm privacy_service_present IS NULLABLE (not NOT NULL, not DEFAULT FALSE).
-- Confirm transfer_lock_present IS NULLABLE (not NOT NULL, not DEFAULT FALSE).
-- Confirm domain_active IS NULLABLE.
-- Confirm pending_delete IS NULLABLE.
-- Confirm domain_age_days IS NULLABLE with no lower-bound CHECK constraint.
-- Confirm expiry_days_remaining IS NULLABLE with no lower-bound CHECK constraint.
-- Confirm evidence IS NOT NULL.
-- Confirm endpoint_state IS NOT NULL.
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_domainregistration_v1'
--  ORDER BY indexname;
--
-- Expected: 20 indexes (1 implicit PK + 19 explicit CREATE INDEX).
--
-- SELECT conname, contype, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'signal_domainregistration_v1'::regclass
--  ORDER BY conname;
--
-- Expected: 8 constraints (7 CHECK + 1 UNIQUE).
-- Constraint names: sdrv1_collector_version_non_empty, sdrv1_country_code_format,
--   sdrv1_endpoint_state_values, sdrv1_privacy_state_values, sdrv1_psp_id_format,
--   sdrv1_run_domain_unique, sdrv1_signal_version_non_empty, sdrv1_tld_type_values.
--
-- Key privacy-state check — confirm tristate semantics are preserved:
--
-- SELECT
--   endpoint_state,
--   privacy_state,
--   privacy_service_present,
--   COUNT(*) AS n
-- FROM signal_domainregistration_v1
-- GROUP BY 1, 2, 3
-- ORDER BY 1, 2, 3;
--
-- Expected:
--   RDAP_RESPONSE_OBSERVED / REGISTRANT_DATA  / false → privacy-enrolled false
--   RDAP_RESPONSE_OBSERVED / PRIVACY_SERVICE  / true  → privacy-enrolled true
--   RDAP_RESPONSE_OBSERVED / REDACTED         / null  → determination not possible
--   RDAP_RESPONSE_OBSERVED / ENTITY_ABSENT    / null  → determination not possible
--   All other endpoint_state values → privacy_state null, privacy_service_present null
--
-- Privacy adoption rate query (correct denominator):
--
-- SELECT
--   SUM(CASE WHEN privacy_service_present = true THEN 1 ELSE 0 END)::float /
--   NULLIF(COUNT(*) FILTER (WHERE privacy_service_present IS NOT NULL), 0) AS privacy_adoption_rate
-- FROM signal_domainregistration_v1
-- WHERE run_id = '<run_id>';
--
-- DO NOT use COUNT(*) as denominator — this incorrectly includes REDACTED and
-- ENTITY_ABSENT rows where privacy_service_present is null (determination absent,
-- not absence of privacy service). See SOT-DOMAINREGISTRATION-001 §6.2.
