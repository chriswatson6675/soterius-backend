-- ── Migration 053: Observation State — deterministic UTC shard scheduling ────
--
-- OBS-103 full-coverage transition. ADDITIVE ONLY: adds the two indexes that
-- serve the full-population draining scheduler. It does NOT change the row key —
-- (organisation_id, observation_type) remains the unique identity, because the
-- current authority population is exactly one resolvable domain per organisation.
-- It performs NO data backfill: the ~80,835 observation-state rows are created by
-- the idempotent provisioning command (provision-observation-states-cli.js),
-- never inside a deployment migration.
--
-- No new columns: cadence/shard policy is already derivable deterministically
-- from observation_type + organisation_id (cadence-policy.js / shard-assignment.js),
-- so a stored copy would be dead metadata that no code writes or reads. If schedule
-- provenance is ever wanted, add it in a focused migration that also wires the
-- writers.
--
-- Index build note: plain CREATE INDEX (not CONCURRENTLY) is deliberate — this
-- migration is applied in Phase 0 when observation_states holds only the ~25
-- pilot rows, so the brief table lock is negligible; provisioning to 80,835 rows
-- happens afterwards, against the already-present indexes.

-- Drain due-selection: the scheduler fetches pages ordered by
-- (next_due_at, organisation_id, observation_type) over states that are neither
-- 'running' nor 'suspended' and whose next_due_at has passed. This partial
-- composite index serves that ordered, bounded page scan directly at ~80,835
-- rows without scanning the whole table each wake.
CREATE INDEX IF NOT EXISTS idx_observation_states_due_drain
  ON observation_states (next_due_at, organisation_id, observation_type)
  WHERE status <> 'running' AND status <> 'suspended';

-- Stale-claim recovery: the drain tops up a page with reclaimable crashed-worker
-- claims (status 'running', updated_at older than the lease). This partial index
-- serves that lookup.
CREATE INDEX IF NOT EXISTS idx_observation_states_stale_running
  ON observation_states (updated_at)
  WHERE status = 'running';
