# OBS-103 — Remediation & Rollout Record (REC-OBS-103-001)

## 1. Document identifier and title
- **Identifier:** REC-OBS-103-001
- **Title:** OBS-103 — Remediation & Rollout Record
- **Type:** Engineering governance record (co-located with the code it governs).

## 2. Status and owner
- **Status:** ACTIVE. WP-1 and WP-2 CLOSED; WP-3 IN PROGRESS (this record is the WP-3 deliverable); WP-4…WP-8 OPEN.
- **Owner:** Backend engineering (OBS-103 programme). Governance authority: repository owner.

## 3. Purpose
Persist, in the repository, the OBS-103 observation-scheduler rollout and its post-Phase-1B technical-debt remediation programme: the authoritative baseline, the rollout phase register, the work-package register, the technical-debt register, the decision log, the verification/evidence register, and the durable cohort-manifest provenance. It preserves evidence that previously existed only as an engagement record or in ephemeral locations, so the programme's status is auditable from committed content.

## 4. Scope and exclusions
**In scope:** durable preservation of governance/evidence for OBS-103 (registers, decisions, verification pointers, and any independently-validated cohort-manifest evidence).

**Out of scope (explicitly not changed by WP-3):** runtime code; scheduler, provisioning, cadence, sharding, claim, retry or lease behaviour; database schema; migrations; Railway configuration; Supabase data; production state; tests; package files. WP-3 also does **not** reconcile documentation drift (that is WP-5), does **not** re-verify current production totals, and does **not** register this record in the parent repository's `DOCUMENT_REGISTER.md` (a Founder-ratified cross-repo step recorded here as a follow-up, consistent with the deferral already noted in [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md)).

## 5. Authority and source classification
Every material claim below carries one of these classifications:
- **COMMITTED** — independently present in git history or repository content.
- **VERIFIED AT CLOSURE** — verified during the relevant execution/closure pass but **not re-verified** by WP-3.
- **ENGAGEMENT RECORD** — established during the OBS-103 remediation engagement and committed for the first time by WP-3.
- **UNVERIFIED / MISSING** — not sufficiently supported to state as fact.

The audit, remediation programme, and the two registers below originate as **ENGAGEMENT RECORD** unless a stronger classification is cited. They are not represented as pre-existing committed authority; committing them here is the point of WP-3.

## 6. Authoritative baseline
- Backend `origin/main` at authoring: **`1d1d550957887f85fb47a1fb64712ae64c31a834`** (WP-2 merge commit). *(COMMITTED)*
- WP-1 merge commit: **`0b11eb5dc68b239a0b8a2680707f3df5816296d7`**; WP-1 change head: **`94c3bb01b0c43fd28f20b883502ffe10367c7bda`**. *(COMMITTED)*
- WP-2 approved change head: **`6ed234e5ad327c111b018db48a5cb6a20c8acbb4`**. *(COMMITTED)*
- Schema: migration [`053_observation_state_shard_scheduling.sql`](../../db/migrations/053_observation_state_shard_scheduling.sql) (additive indexes only). *(COMMITTED)*
- Design/mechanism authority: [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md). *(COMMITTED)*
- Operator guide: [PROVISIONING-COHORTS.md](../observation-state/PROVISIONING-COHORTS.md). *(COMMITTED)*
- Reconciliation queries: [monitoring/coverage-reconciliation.sql](./monitoring/coverage-reconciliation.sql). *(COMMITTED)*

## 7. Operational architecture summary
Summary only; the authority is [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md). *(COMMITTED)*
- **Scheduler:** [`run-drain-cli.js`](./run-drain-cli.js) → `drain.js`, deployed via [`railway.observation-scheduler.json`](../../railway.observation-scheduler.json) on cron `*/15 * * * *`, `--production --max-states-per-run 1500 --page-size 250 --concurrency 8 --runtime-budget-ms 720000`. Processes the whole due population (no `--org` scope).
- **Cadence/sharding:** deterministic fixed-UTC 15-minute shards (`utc-shard-v1`); daily signals (SPF/DKIM/DMARC) once per UTC day at the org's slot; weekly signals (DNSSEC/CAA) once per 7-day UTC epoch cycle.
- **Provisioning:** [`provision-observation-states-cli.js`](../observation-state/provision-observation-states-cli.js). Since WP-2, `--from-manifest` is the **sole** production-write path.

## 8. Rollout phase register
Totals were **verified at their closure points and are NOT re-queried by WP-3**; WP-3 does not assert current production totals.

| Phase | Scope | Reported totals (at closure) | Cohort digest | Classification |
|--|--|--|--|--|
| Phase 0 — pilot | 5 pilot organisations | 25 states | n/a | VERIFIED AT CLOSURE |
| Phase 1A — governed cohort | +100 organisations | +500 states | `27ddbc2ae6d3bbec53bacbdbc6f5cd25ba3fbbf48c841635ccf9d45fb559ad1a` (reconstructed from live state at Phase 1B baseline) | VERIFIED AT CLOSURE — **canonical manifest artifact ABSENT** (see §13) |
| Phase 1B — additional cohort | +400 organisations | closure total reported **505 organisations / 2,525 states** | `df86a330d93ddb4b2b7ac2ed908d240076e55072f85832a1d60fdfc9e2fde70e` | VERIFIED AT CLOSURE — **canonical manifest COMMITTED** (see §13) |
| Phase 2 — larger cohorts | bounded batches | not started | — | UNVERIFIED / not started |
| Phase 3 — full population | remaining eligible (→ ~16,167 orgs / ~80,835 states) | not started | — | UNVERIFIED / not started |
| Phase 4 — acceptance | all-five-signal coverage gate | not started | — | UNVERIFIED / not started |

> The staged-rollout narrative in [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md) still describes a `--limit 200` Phase 1. That wording is now inconsistent with the governed manifest-based Phase 1A/1B **and** is prohibited by the WP-2 safety gate. It is **flagged as WP-5 documentation debt** and deliberately **not** edited by WP-3.

## 9. Work-package register
The canonical programme is **WP-1 … WP-8**. Earlier references to "WP-1 … WP-7" omitted the future environment-separation package (WP-8); **this record establishes WP-1 … WP-8 as the canonical register.** *(ENGAGEMENT RECORD, except closure evidence as cited.)*

| WP | Title | TD IDs | Status | Closure evidence |
|--|--|--|--|--|
| WP-1 | Scheduler deploy integrity & regression guard | TD-01, TD-02, TD-08, TD-12 | **CLOSED** | PR #2 → merge `0b11eb5`; files on `main` *(COMMITTED)* |
| WP-2 | Provisioning safety gate | TD-03 | **CLOSED** | PR #3 → merge `1d1d550`; guard on `main` *(COMMITTED)* |
| WP-3 | Governance evidence preservation | TD-07 | **IN PROGRESS** | this record + §13 evidence |
| WP-4 | Observability & reconciliation | TD-05, TD-10, TD-11 | **OPEN** | — |
| WP-5 | Documentation reconciliation | TD-06 | **OPEN** | — |
| WP-6 | Evidence-growth strategy | TD-04 | **OPEN** | — |
| WP-7 | Repo/worktree hygiene | TD-09 | **OPEN** | — |
| WP-8 | Environment separation | TD-13 | **OPEN / FUTURE** | — |

## 10. Technical-debt register
*(Status/mapping: ENGAGEMENT RECORD; closure evidence: COMMITTED as cited.)*

| ID | Title | Severity | Status | WP | Evidence class | Closure evidence / outstanding condition |
|--|--|--|--|--|--|--|
| TD-01 | Stale scheduler config drift | P1 | CLOSED | WP-1 | COMMITTED | Config regression test on `main` (PR #2) |
| TD-02 | No deployed-command regression test | P1 | CLOSED | WP-1 | COMMITTED | `deployed-scheduler-config.regression.test.js` on `main` |
| TD-03 | Unpinned full-population provisioning | P1 | CLOSED | WP-2 | COMMITTED | `runLegacy` safety gate on `main` (PR #3) |
| TD-04 | Unbounded append-only evidence growth | P1 | OPEN | WP-6 | ENGAGEMENT RECORD | Outstanding: choose/implement dedup / change-only / retention strategy |
| TD-05 | No automated ops alerting | P1 | OPEN | WP-4 | ENGAGEMENT RECORD | Outstanding: missed-wake/backlog/stale-claim/scope-drop alerts |
| TD-06 | Documentation drift | P2 | OPEN | WP-5 | ENGAGEMENT RECORD | Outstanding: reconcile OPS-007 / DEPLOYMENT_CHECKLIST / FULL-COVERAGE rollout wording |
| TD-07 | Cohort-manifest provenance ephemeral | P2 | **PARTIALLY REMEDIATED** | WP-3 | see §13 | Phase 1B manifest committed; **Phase 1A canonical manifest absent** (closure condition in §13) |
| TD-08 | `run-drain-cli.js` untested | P2 | CLOSED | WP-1 | COMMITTED | `run-drain-cli.test.js` on `main` |
| TD-09 | Worktree/branch/obsolete-test clutter | P2 | OPEN | WP-7 | ENGAGEMENT RECORD | Outstanding: retire stale `release/public-scanner-rc1` config, prune stale worktrees/branches |
| TD-10 | Reconciliation SQL not operationalised | P2 | OPEN | WP-4 | ENGAGEMENT RECORD | Outstanding: schedule/automate `coverage-reconciliation.sql` |
| TD-11 | Dual (NULL-org) evidence provenance | P3 | OPEN | WP-4 / WP-6 | ENGAGEMENT RECORD | Outstanding: document/tag baseline vs OBS-103 evidence |
| TD-12 | Two entry points, prose-only distinction | P3 | CLOSED | WP-1 | COMMITTED | Entry-point clarifications + config guard on `main` |
| TD-13 | Single Supabase project = production | P3 | OPEN / FUTURE | WP-8 | ENGAGEMENT RECORD | Outstanding: evaluate/stand up a staging project |

## 11. Decision log
*(ENGAGEMENT RECORD unless cited.)*
1. **WP-2 strict interpretation (approved):** `--from-manifest` is the sole production-write path; both the legacy no-mode full-population path and `--limit` are refused in production. Implemented in PR #3. *(COMMITTED)*
2. **Deploy from `main` only:** the Railway scheduler service builds from `main`; the stale `release/public-scanner-rc1` scheduler config is not deployed (WP-1 adds a CI guard against a revert reaching `main`).
3. **Merged-branch retention:** repository practice retains merged branches (`delete_branch_on_merge=false`); WP-1/WP-2 remote branches were retained.
4. **Durable patch archives:** reviewed patches retained outside the repo as recovery artifacts (see §12); `main` is the source of truth.
5. **Scheduling authority:** UTC-only, deterministic 15-minute shards; superseded designs retained for interpretation only. *(COMMITTED — [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md))*
6. **Evidence is append-only** and never deleted on rollback. *(COMMITTED — FULL-COVERAGE §Rollback)*

## 12. Verification and evidence register
| Item | Reference | Classification |
|--|--|--|
| WP-1 change | GitHub PR #2, head `94c3bb0`, merge `0b11eb5` | COMMITTED |
| WP-1 validation at closure | provision/scheduler + observation-state suites 315/315 (pre-WP-2) | VERIFIED AT CLOSURE |
| WP-1 reviewed-patch identity | SHA-256 `efe499dd9229f2e79e94618cb0fe6831733ac3e9bc64c6020ef8b22bc173a09e` (recovery archive retained off-repository; merged `main` is the source of truth) | ENGAGEMENT RECORD |
| WP-2 change | GitHub PR #3, head `6ed234e`, merge `1d1d550` | COMMITTED |
| WP-2 validation at closure | provision CLI 28/28; combined suites 322/322 | VERIFIED AT CLOSURE |
| WP-2 reviewed-patch identity | SHA-256 `f5e7494a6c3ee4809fa0d7c389e3929c389d8036e6b94198ae2f2ba6afef43b6` (recovery archive retained off-repository; merged `main` is the source of truth) | ENGAGEMENT RECORD |
| Phase 1B cohort manifest | [`evidence/obs-103/phase-1b-cohort-manifest.json`](./evidence/obs-103/phase-1b-cohort-manifest.json) / [`.csv`](./evidence/obs-103/phase-1b-cohort-manifest.csv) | COMMITTED by WP-3 (see §13) |

> GitHub PR numbering note: PR #1 was an unrelated CI fix; the OBS-103 work-package PRs are **#2 (WP-1)** and **#3 (WP-2)**.

## 13. Cohort-manifest provenance
Only locally available, authoritative artifacts with a clear OBS-103 provenance trail were inspected. Production systems were **not** contacted; no manifest content was reconstructed from memory, prose, or assumptions.

### Phase 1B — AVAILABLE and COMMITTED
- **Canonical manifest present:** yes — generated by the deployed governed selector during Phase 1B and used for the production write (`--approve-digest df86a330…`).
- **Committed artifacts:**
  - [`evidence/obs-103/phase-1b-cohort-manifest.json`](./evidence/obs-103/phase-1b-cohort-manifest.json) — SHA-256 `652db325b176e3b291048b52dc2c6d135a736b2f9c8f16fdd8de250ca9a23a6c`
  - [`evidence/obs-103/phase-1b-cohort-manifest.csv`](./evidence/obs-103/phase-1b-cohort-manifest.csv) — SHA-256 `572ca9fbc73ab31b3455f127260f9c73a80a4474e8ea3c9f0fa338dd9578a085`
- **Cohort digest:** `df86a330d93ddb4b2b7ac2ed908d240076e55072f85832a1d60fdfc9e2fde70e` (embedded `cohortDigest`).
- **Independent validation:** `validateManifest` PASS and `verifyManifestIdentity` PASS via [`cohort-ranking.js`](../observation-state/cohort-ranking.js) — the recomputed digest equals the embedded digest and equals the closure digest.
- **Organisation count:** 400 unique ids. **Schema:** `obs-103-cohort-manifest/v1`; `cohortSalt=:cohort:v1`; `requestedSize=400`. Fields per entry: `position, rank, organisationId, organisationName, domain, eligibilityBasis`. **Credential-free and timestamp-free** (verified).
- **Byte-integrity:** `evidence/obs-103/.gitattributes` marks `*.json`/`*.csv` as `-text` so the recorded SHA-256 holds on any checkout.
- **Classification:** ENGAGEMENT RECORD, now COMMITTED by WP-3.

### Phase 1A — MISSING (canonical manifest absent)
- **Canonical manifest present:** **no.** The Phase 1A manifest was never persisted as a file; at Phase 1B baseline its digest was *reconstructed from live provisioned state* and matched the approved value.
- **Available:** the digest `27ddbc2ae6d3bbec53bacbdbc6f5cd25ba3fbbf48c841635ccf9d45fb559ad1a` only (VERIFIED AT CLOSURE). Per the TD-07 rule, a digest is **not** the manifest and does not preserve provenance.
- **Not committed:** no ordered organisation-id list, metadata, or CSV for Phase 1A is available locally; none was reconstructed.
- **Closure condition:** TD-07 closes only when a canonical Phase 1A manifest (ordered ids + metadata, digest-validated against `27ddbc…`) is durably committed here. That artifact is currently unavailable and cannot be produced in this pass without a governed re-derivation (out of WP-3 scope; must not contact production).

### TD-07 determination
**PARTIALLY REMEDIATED** — Phase 1B canonical manifest preserved and validated; Phase 1A canonical manifest absent.

## 14. Closure criteria
- **WP-3 closes** when this record and the available, validated manifest evidence are committed to `main`, with every WP/TD appearing once in its canonical register and all CLOSED items citing evidence.
- **TD-07 closes** only when the Phase 1A canonical manifest is durably committed and digest-validated (see §13).
- **OBS-103 programme closes** when WP-4 … WP-8 reach their defined dispositions and the Phase 4 acceptance gate (all-five-signal coverage) is met (authority: [OBS-103-FULL-COVERAGE.md](./OBS-103-FULL-COVERAGE.md)).

## 15. Residual risks and ambiguities
1. **Phase 1A manifest absent** — provenance for Phase 1A rests on a reconstructed digest only (TD-07 partial).
2. **Current production totals not asserted** — 505/2,525 are VERIFIED AT CLOSURE, not re-queried by WP-3.
3. **FULL-COVERAGE rollout wording** (`--limit 200`) is stale vs governed manifest flow + WP-2 gate — WP-5.
4. **Registers are ENGAGEMENT RECORD** — first committed here; WP-1/WP-2/TD closures they reference are independently COMMITTED, but the register structure itself had no prior committed source.
5. **Parent-repo registration** of this record in `DOCUMENT_REGISTER.md` is a Founder-ratified follow-up, not performed by WP-3.

## 16. Next authorised work package
Per the rollout gates, **WP-4 (Observability & reconciliation)** is the recommended next package before any expansion beyond the current cohort; **WP-7 (repo/worktree hygiene)** is low-risk and may proceed at any time. Actual authorisation and sequencing are the owner's decision.

## 17. Change history
| Date (UTC) | Change | By |
|--|--|--|
| 2026-07-20 | Initial record created (WP-3): baseline, rollout/WP/TD registers, decision & evidence registers, Phase 1B manifest provenance committed; TD-07 marked PARTIALLY REMEDIATED. | Backend engineering (OBS-103) |
