-- OBS-103 full-coverage monitoring & reconciliation queries (read-only).
--
-- Run against production Supabase to measure provisioning, backlog, freshness
-- and — the acceptance gate — persisted successful evidence for all five
-- signals of every eligible domain. Full coverage is NOT accepted merely
-- because 80,835 state rows exist; it is accepted only when every eligible
-- domain has successful SPF, DKIM, DMARC, DNSSEC and CAA evidence.
--
-- ELIGIBLE ORGANISATIONS / ELIGIBLE DOMAINS are authority-derived (16,167 at the
-- time of writing) and come from the deployed authority dataset, NOT the
-- database; they are supplied as :eligible_orgs / :eligible_domains parameters
-- (both currently 16,167) so the queries below can compute coverage percentages.

-- ── Headline acceptance report ───────────────────────────────────────────────
-- PROVISIONED ORGANISATIONS / PROVISIONED STATES / state counts by signal.
SELECT
  count(DISTINCT organisation_id)                                             AS provisioned_organisations,
  count(*)                                                                    AS provisioned_states,
  count(*) FILTER (WHERE observation_type IN ('spf','dkim','dmarc'))          AS daily_states,
  count(*) FILTER (WHERE observation_type IN ('dnssec','caa'))                AS weekly_states,
  count(*) FILTER (WHERE status = 'never_observed')                           AS never_observed,
  count(*) FILTER (WHERE status = 'observed')                                 AS observed,
  count(*) FILTER (WHERE status = 'failed')                                   AS failed_states,
  count(*) FILTER (WHERE status = 'running')                                  AS claimed_states
FROM observation_states;

-- ── Due backlog and oldest-due age (CURRENT DUE BACKLOG / OLDEST DUE AGE) ─────
SELECT
  count(*) FILTER (WHERE status <> 'running' AND status <> 'suspended'
                    AND (next_due_at IS NULL OR next_due_at <= now()))         AS current_due_backlog,
  count(*) FILTER (WHERE observation_type IN ('spf','dkim','dmarc')
                    AND status NOT IN ('running','suspended')
                    AND (next_due_at IS NULL OR next_due_at <= now()))         AS daily_backlog,
  count(*) FILTER (WHERE observation_type IN ('dnssec','caa')
                    AND status NOT IN ('running','suspended')
                    AND (next_due_at IS NULL OR next_due_at <= now()))         AS weekly_backlog,
  now() - min(next_due_at) FILTER (WHERE status NOT IN ('running','suspended')
                    AND next_due_at <= now())                                  AS oldest_due_age
FROM observation_states;

-- ── Retry / failure health (FAILED STATES / RETRYING STATES) ─────────────────
SELECT
  count(*) FILTER (WHERE status = 'failed')                                   AS failed_states,
  count(*) FILTER (WHERE attempt_count > 0 AND status <> 'observed')          AS retrying_states,
  count(*) FILTER (WHERE attempt_count >= 5)                                  AS retry_exhausted,
  max(attempt_count)                                                          AS worst_attempt_count
FROM observation_states;

-- ── Stale-claim / overlap detection (crashed workers, stuck leases) ──────────
SELECT count(*) AS stale_running_claims
FROM observation_states
WHERE status = 'running' AND updated_at < now() - interval '15 minutes';

-- ── Slot distribution (SLOT DISTRIBUTION) — detect overloaded 15-min slots ───
-- next_due_at truncated to its 15-minute slot; large outliers => hot shard.
SELECT
  to_char(date_trunc('hour', next_due_at)
          + floor(extract(minute FROM next_due_at) / 15) * interval '15 min', 'HH24:MI') AS slot,
  count(*) AS states_due_in_slot
FROM observation_states
WHERE observation_type IN ('spf','dkim','dmarc') AND next_due_at IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- ── Domains missing one or more signal types (structural coverage gap) ───────
SELECT organisation_id, count(DISTINCT observation_type) AS signal_count,
       array_agg(DISTINCT observation_type ORDER BY observation_type) AS signals
FROM observation_states
GROUP BY organisation_id
HAVING count(DISTINCT observation_type) < 5
LIMIT 100;

-- ── ACCEPTANCE GATE — DOMAINS SUCCESSFULLY OBSERVED / NEVER OBSERVED ─────────
-- A domain (organisation) counts as fully covered only when all five signal
-- states are status='observed' with a non-null evidence pointer. Anything less
-- is NOT accepted coverage.
WITH per_org AS (
  SELECT organisation_id,
         count(*) FILTER (WHERE status = 'observed' AND evidence_ref IS NOT NULL) AS observed_with_evidence
  FROM observation_states
  GROUP BY organisation_id
)
SELECT
  count(*)                                                    AS organisations_with_states,
  count(*) FILTER (WHERE observed_with_evidence = 5)          AS domains_successfully_observed_all5,
  count(*) FILTER (WHERE observed_with_evidence = 0)          AS domains_never_observed,
  count(*) FILTER (WHERE observed_with_evidence BETWEEN 1 AND 4) AS domains_partial
FROM per_org;

-- ── Per-signal successful-evidence coverage (each must reach :eligible_domains) ─
SELECT observation_type,
       count(*) FILTER (WHERE status = 'observed' AND evidence_ref IS NOT NULL) AS domains_with_successful_evidence
FROM observation_states
GROUP BY observation_type
ORDER BY observation_type;
