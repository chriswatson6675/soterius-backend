-- SOT-SECURITYTXT-001 — HE-001 Cohort Analysis Queries
--
-- All queries are parameterised by run_id.
-- Replace '<run_id>' with the UUID printed at the start of the collection run,
-- or use the latest_run CTE below to automatically select the most recent run.
--
-- To find available run_ids:
--   SELECT run_id, COUNT(*) AS rows, MIN(collected_at) AS started_at
--     FROM signal_securitytxt_v1
--    GROUP BY run_id
--    ORDER BY started_at DESC;
--
-- JSONB access conventions:
--   COALESCE(canonical_parse, legacy_parse)        — preferred evidence source
--   canonical_parse ->> 'content_state'            — text extraction
--   canonical_parse -> 'contact'                   — JSONB array
--   jsonb_array_length(canonical_parse -> 'contact') — array length
--   jsonb_array_elements_text(parse -> 'contact')  — unnest to text rows

-- ── Q1: File state distribution ───────────────────────────────────────────────
--
-- How many institutions fall into each file_state?
-- Provides the top-level security.txt adoption picture.

SELECT
  file_state,
  COUNT(*)                                                         AS institutions,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1)              AS pct
FROM signal_securitytxt_v1
WHERE run_id = '<run_id>'
GROUP BY file_state
ORDER BY institutions DESC;


-- ── Q2: Present security.txt count ───────────────────────────────────────────
--
-- Total number of institutions where a security.txt file was found
-- at either location.

SELECT
  COUNT(*)  AS institutions_with_securitytxt,
  ROUND(COUNT(*) * 100.0 / (
    SELECT COUNT(*) FROM signal_securitytxt_v1 WHERE run_id = '<run_id>'
  ), 1)     AS pct_of_cohort
FROM signal_securitytxt_v1
WHERE run_id = '<run_id>'
  AND file_state IN ('PRESENT_CANONICAL', 'PRESENT_LEGACY_ONLY', 'PRESENT_BOTH');


-- ── Q3: Canonical vs legacy adoption ─────────────────────────────────────────
--
-- Which location are institutions publishing at?
-- RFC 9116 mandates /.well-known/security.txt as the canonical location.

SELECT
  COUNT(*) FILTER (WHERE file_state = 'PRESENT_CANONICAL')    AS canonical_only,
  COUNT(*) FILTER (WHERE file_state = 'PRESENT_BOTH')         AS both_locations,
  COUNT(*) FILTER (WHERE file_state = 'PRESENT_LEGACY_ONLY')  AS legacy_only,
  COUNT(*) FILTER (WHERE file_state IN (
    'PRESENT_CANONICAL', 'PRESENT_BOTH', 'PRESENT_LEGACY_ONLY'
  ))                                                           AS total_present
FROM signal_securitytxt_v1
WHERE run_id = '<run_id>';


-- ── Q4: Signed vs unsigned distribution ──────────────────────────────────────
--
-- What content state are present security.txt files in?
-- content_state: UNSIGNED | SIGNED | MALFORMED_PGP
-- Uses canonical_parse if available; falls back to legacy_parse.

SELECT
  COALESCE(canonical_parse, legacy_parse) ->> 'content_state'  AS content_state,
  COUNT(*)                                                       AS institutions,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1)            AS pct
FROM signal_securitytxt_v1
WHERE run_id = '<run_id>'
  AND (canonical_parse IS NOT NULL OR legacy_parse IS NOT NULL)
GROUP BY content_state
ORDER BY institutions DESC;


-- ── Q5: Most common unknown fields ───────────────────────────────────────────
--
-- RFC 9116 defines 8 named fields. Unknown fields are vendor extensions
-- or non-standard practices. This surfaces what's in the wild.

SELECT
  uf ->> 'field_name_raw'                AS field_name,
  COUNT(*)                               AS occurrences,
  COUNT(DISTINCT s.domain)               AS distinct_domains
FROM signal_securitytxt_v1 AS s,
  LATERAL jsonb_array_elements(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'unknown_fields'
  ) AS uf
WHERE s.run_id = '<run_id>'
  AND (s.canonical_parse IS NOT NULL OR s.legacy_parse IS NOT NULL)
  AND jsonb_array_length(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'unknown_fields'
  ) > 0
GROUP BY field_name
ORDER BY occurrences DESC;


-- ── Q6: Most common Contact URI hosts ────────────────────────────────────────
--
-- Extracts the host portion of Contact field values.
-- Handles mailto: (extracts domain after @), https:// (extracts hostname),
-- and other schemes.

WITH contacts AS (
  SELECT
    s.domain,
    trim(c.val) AS contact_raw
  FROM signal_securitytxt_v1 AS s,
    LATERAL jsonb_array_elements_text(
      COALESCE(s.canonical_parse, s.legacy_parse) -> 'contact'
    ) AS c(val)
  WHERE s.run_id = '<run_id>'
    AND (s.canonical_parse IS NOT NULL OR s.legacy_parse IS NOT NULL)
    AND jsonb_array_length(
      COALESCE(s.canonical_parse, s.legacy_parse) -> 'contact'
    ) > 0
)
SELECT
  CASE
    WHEN contact_raw LIKE 'mailto:%' THEN
      split_part(split_part(contact_raw, '@', 2), '?', 1)
    WHEN contact_raw LIKE 'http://%' OR contact_raw LIKE 'https://%' THEN
      regexp_replace(
        regexp_replace(contact_raw, '^https?://', ''),
        '/.*', ''
      )
    ELSE '(other)'
  END                          AS contact_host,
  COUNT(*)                     AS occurrences,
  COUNT(DISTINCT domain)       AS distinct_domains
FROM contacts
GROUP BY contact_host
ORDER BY occurrences DESC
LIMIT 25;


-- ── Q7: Institutions with OpenBugBounty references ───────────────────────────
--
-- OpenBugBounty is a non-standard vendor extension field observed
-- in the pilot run. This query finds all institutions publishing it.

SELECT
  s.domain,
  uf ->> 'field_name_raw'    AS field_name,
  trim(uf ->> 'field_value_raw') AS field_value
FROM signal_securitytxt_v1 AS s,
  LATERAL jsonb_array_elements(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'unknown_fields'
  ) AS uf
WHERE s.run_id = '<run_id>'
  AND upper(uf ->> 'field_name_raw') = 'OPENBUGBOUNTY'
ORDER BY s.domain;


-- ── Q8: Institutions with Policy fields ──────────────────────────────────────
--
-- Policy: URI pointing to the institution's vulnerability disclosure policy.
-- RFC 9116 §2.5.5 — not mandatory but signals disclosure process maturity.

SELECT
  s.domain,
  trim(p.val) AS policy_uri
FROM signal_securitytxt_v1 AS s,
  LATERAL jsonb_array_elements_text(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'policy'
  ) AS p(val)
WHERE s.run_id = '<run_id>'
  AND (s.canonical_parse IS NOT NULL OR s.legacy_parse IS NOT NULL)
  AND jsonb_array_length(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'policy'
  ) > 0
ORDER BY s.domain;


-- ── Q9: Institutions with Encryption fields ───────────────────────────────────
--
-- Encryption: URI for a PGP key used to encrypt vulnerability reports.
-- RFC 9116 §2.5.3.

SELECT
  s.domain,
  trim(e.val) AS encryption_uri
FROM signal_securitytxt_v1 AS s,
  LATERAL jsonb_array_elements_text(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'encryption'
  ) AS e(val)
WHERE s.run_id = '<run_id>'
  AND (s.canonical_parse IS NOT NULL OR s.legacy_parse IS NOT NULL)
  AND jsonb_array_length(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'encryption'
  ) > 0
ORDER BY s.domain;


-- ── Q10: Institutions returning OTHER_HTTP ────────────────────────────────────
--
-- Domains where the HTTP response was not 200, 3xx, 404, or 5xx.
-- Common cause: 403 Forbidden. May indicate a WAF or robots policy
-- blocking automated requests. These are ABSENT in file_state but
-- the response deserves investigation.

SELECT
  s.domain,
  s.canonical_fetch ->> 'fetch_state'   AS canonical_state,
  (s.canonical_fetch ->> 'http_status')::int AS canonical_status,
  s.legacy_fetch    ->> 'fetch_state'   AS legacy_state,
  (s.legacy_fetch   ->> 'http_status')::int AS legacy_status
FROM signal_securitytxt_v1 AS s
WHERE s.run_id = '<run_id>'
  AND (
    s.canonical_fetch ->> 'fetch_state' = 'OTHER_HTTP'
    OR s.legacy_fetch  ->> 'fetch_state' = 'OTHER_HTTP'
  )
ORDER BY s.domain;


-- ── Bonus: Institutions with Expires in the past ─────────────────────────────
--
-- Expired security.txt files are stale. This is an observable fact —
-- not a score or rating. Surfaces for follow-up investigation.

SELECT
  s.domain,
  trim(e.val) AS expires_raw
FROM signal_securitytxt_v1 AS s,
  LATERAL jsonb_array_elements_text(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'expires'
  ) AS e(val)
WHERE s.run_id = '<run_id>'
  AND (s.canonical_parse IS NOT NULL OR s.legacy_parse IS NOT NULL)
  AND jsonb_array_length(
    COALESCE(s.canonical_parse, s.legacy_parse) -> 'expires'
  ) > 0
ORDER BY s.domain;


-- ── Bonus: Full evidence for a specific domain ────────────────────────────────

SELECT
  domain,
  file_state,
  canonical_fetch ->> 'fetch_state'              AS canonical_fetch_state,
  canonical_fetch ->> 'http_status'              AS canonical_http_status,
  COALESCE(canonical_parse, legacy_parse) ->> 'content_state' AS content_state,
  jsonb_array_length(
    COALESCE(canonical_parse, legacy_parse) -> 'contact'
  )                                              AS contact_count,
  COALESCE(canonical_parse, legacy_parse) ->> 'directive_count' AS directive_count,
  collected_at
FROM signal_securitytxt_v1
WHERE run_id    = '<run_id>'
  AND domain    = '<domain>'
ORDER BY collected_at DESC
LIMIT 1;
