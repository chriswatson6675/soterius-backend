# UTIL-01 — Ofgem Electricity Spine Staging Acquisition — FAIL-CLOSED RECORD

**Package ID:** UTIL-01 (SOTERIUS-UTIL-01-OFGEM-ELECTRICITY-SPINE-STAGING-ACQUISITION-01)
**Outcome:** **STOPPED FAIL-CLOSED AT STAGE 1.** The authoritative source could not be retrieved.
**Date:** 2026-09-03
**Design reference:** `research/UTIL-ACQ-001-uk-utilities-public-source-census-and-acquisition-design.md`

> ## OUTCOME IN ONE LINE
>
> **No acquisition was performed. No dataset exists. Every census figure requested by
> Stages 2–16 is `BLOCKED — NOT MEASURED`, and no number appears anywhere in this
> document.**
>
> The package's own stop condition was triggered exactly as specified: *"If the current
> source cannot be retrieved because of egress restrictions: STOP FAIL-CLOSED. Do not
> substitute search snippets. Do not use model knowledge. Do not construct synthetic
> rows."*

---

## 1. Stage 0 — Environment and repository verification

**Completed.** Recorded before the retrieval attempt.

| Item | Value |
|---|---|
| Repository | `https://github.com/chriswatson6675/soterius-backend` |
| Branch | `claude/soterius-utilities-regulatory-mapping-1cnewe` |
| HEAD | `3496fa1926b7a66787b7933b0290090701955b0d` |
| HEAD subject | `docs(research): add UTIL-ACQ-001 utilities public-source census and acquisition design` |
| Worktrees | One: `/home/user/soterius-backend` (no additional worktree created — see §6) |
| Working-tree status | **Clean.** No modified, staged or untracked files at Stage 0 |
| Unrelated user changes | **None present.** Nothing was disturbed |

### 1.1 Existing acquisition conventions inspected

| Convention | Location | Relevance to UTIL-01 |
|---|---|---|
| Collection Layer pipeline (Observe → Preserve → Manifest → Extract → Provenance → Integrity → Seal → Report) | `collection/sources/sra/`, `collection/sources/fca/` — **FROZEN** per `collection/PLATFORM-v1.0-BASELINE.md` | The pattern UTIL-01 would follow: `snapshot-source.js`, `preserve-snapshot.js`, `evidence-path.js`, `manifest.js`, `extract.js`, `provenance.js`, `integrity.js`, `collection-package.js` |
| Run evidence layout | `acquisition/runs/<source>/` — `manifest.json`, `registry.ndjson` | Where UTIL-01 staging artefacts would live (`acquisition/runs/ofgem-electricity/`) |
| Identity precedence | `organisation/identity.js` → `primaryKeyOf()` | Companies House number is **first** in the chain; `domain` is read **only** in the keyless fallback `nd:sha(normalisedName\|domain)` |
| Provenance semantics | `organisation/schema.js` → `Provenance` | Existing vocabulary `verified` / `corroborated` / `inferred`. **UTIL-01 would use `corroborated`** for the Ofgem list (§5) — no new confidence vocabulary needed or invented |
| Frozen-signal / ADR discipline | `collection/signals/FROZEN.md`, ADR-COL-006, SLG-019 | Confirms repository authority governs; no integration without governance |

**Divergence from UTIL-ACQ-001 noted:** UTIL-ACQ-001 §20.1 recorded `Relationship` and `Attribution` as absent and `memberships` as customer-tenancy. Stage 0 re-inspection confirms this. It does not affect UTIL-01 (which produces no relationships), but it remains true and unchanged.

---

## 2. Stage 1 — Retrieval attempt and blocker

**Result: BLOCKED. This is the stop point.**

### 2.1 Attempts made

| # | Target | Method | Result |
|---|---|---|---|
| 1 | `https://www.ofgem.gov.uk/data/list-all-electricity-licensees-including-suppliers` (publication page) | WebFetch | `EGRESS_BLOCKED` — "Access to www.ofgem.gov.uk is blocked by the network egress proxy" |
| 2 | Same publication page | `curl` via the session's HTTPS proxy | `curl: (56) CONNECT tunnel failed, response 403` |
| 3 | `https://epr.ofgem.gov.uk/` (Electronic Public Register — the formal authority) | `curl` via proxy | `curl: (56) CONNECT tunnel failed, response 403` |

### 2.2 Proxy-recorded failure detail

Retrieved from the agent proxy's own status endpoint — this is the gateway's record, not an inference:

```json
[
  {
    "ts": "2026-09-03T11:46:04.407Z",
    "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.ofgem.gov.uk:443"
  },
  {
    "ts": "2026-09-03T11:46:04.644Z",
    "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "epr.ofgem.gov.uk:443"
  }
]
```

Proxy state at time of attempt: `enabled: true`, `selective: false`. The block is an
**organisation egress-policy denial at the gateway**, not a TLS-trust failure, not a
misconfiguration, and not a transient network error.

### 2.3 Actions deliberately NOT taken

The proxy documentation states that 403/407 responses are policy denials which must be
reported, not retried or routed around. Accordingly:

- **No retry loop or alternative transport** was attempted.
- **No TLS verification was disabled**; `HTTPS_PROXY` was not unset.
- **No mirror or third-party copy** of the PDF was sought or used. A cached or
  republished copy is not the authoritative artefact and would break the provenance
  chain UTIL-01 exists to establish.
- **No search-index snippet was used as data.** Search can identify a source; it cannot
  supply source bytes.
- **No model knowledge was used** to populate licence types, company names or counts.
- **No synthetic rows were constructed** for any purpose, including test fixtures.

### 2.4 Repository checked for a pre-existing copy

Before declaring the blocker, the repository was searched for any already-preserved copy
of the artefact:

- `find` for `*ofgem*`, `*licensee*`, `*electricity*` — **no matches**
- `find` for `*.pdf` anywhere outside `node_modules` — **no matches**

There is no previously preserved source to fall back on. The blocker is total.

### 2.5 Required Stage 1 evidence — all unobtainable

| Required field | Status |
|---|---|
| Publication-page URL | Known (target), **not retrieved** |
| PDF URL (resolved from the page) | **BLOCKED — cannot resolve.** The brief correctly forbids hard-coding a historic PDF URL as the authority, and the page that would resolve the current one is unreachable |
| Retrieval UTC timestamp | **N/A — no successful retrieval** |
| HTTP metadata | **BLOCKED** — no response beyond the gateway's 403 to CONNECT |
| Source publication/update date | **NOT VERIFIED.** The brief states the page was last updated 17 August 2026 and explicitly instructs that this is not a substitute for retrieving the source. It has not been verified here and is **not** relied upon |
| SHA-256 of raw PDF bytes | **BLOCKED — no bytes** |
| Byte size | **BLOCKED — no bytes** |

---

## 3. Stages 2–16 — not attempted, and why implementation was not substituted

**No stage beyond Stage 1 was attempted.** Every downstream stage depends on the source
bytes. Two of them are structurally impossible to pre-build without violating the brief's
own instructions:

- **Stage 2** states *"Do not assume the exact header spelling until inspected."* Writing a
  parser now would require exactly that assumption.
- **Stage 4** states *"Do not begin with the provisional role vocabulary from UTIL-ACQ-001.
  Derive the exact distinct `licence_type_raw` values from the retrieved source."* The
  classification mapping cannot be authored against values that have not been observed.
- **Stage 14** requires tests over parsing, Scottish numbers, malformed numbers and
  multi-licence entities. Every fixture would be **synthetic source data**, which §2.3
  prohibits — and tests passing against invented fixtures would create false confidence in
  a parser never exposed to the real artefact.

Building a speculative parser would therefore not be partial progress. It would be
unverifiable code plus fabricated fixtures, presented as readiness. That is the failure
mode the stop condition exists to prevent, and the brief's closing instruction —
*"Do not solve a blocker by weakening provenance"* — rules it out directly.

### 3.1 The census that cannot be produced

Recorded explicitly so no reader mistakes absence for zero. **No figure below is
estimated, inferred or carried over from any other document.**

| Stage 16 metric | Value |
|---|---|
| Source rows | **BLOCKED — NOT MEASURED** |
| Parsed rows | **BLOCKED — NOT MEASURED** |
| Rejected rows | **BLOCKED — NOT MEASURED** |
| Unique legal entities | **BLOCKED — NOT MEASURED** |
| Entities with valid company numbers | **BLOCKED — NOT MEASURED** |
| Missing company numbers | **BLOCKED — NOT MEASURED** |
| Malformed company numbers | **BLOCKED — NOT MEASURED** |
| Multi-licence entities | **BLOCKED — NOT MEASURED** |
| Exact licence vocabulary | **BLOCKED — NOT DERIVED** |
| Infrastructure operators | **BLOCKED — NOT MEASURED** |
| Generation / infrastructure-adjacent | **BLOCKED — NOT MEASURED** |
| Market / retail | **BLOCKED — NOT MEASURED** |
| Infrastructure support (smart meter comms) | **BLOCKED — NOT MEASURED** |
| Unresolved | **BLOCKED — NOT MEASURED** |
| Infrastructure breakdown by class (DNO/IDNO/transmission/offshore/interconnector/system operator/other) | **BLOCKED — NOT MEASURED** |
| Overlaps (infra+generation, infra+retail, generation+retail, 3+ classes) | **BLOCKED — NOT MEASURED** |
| Multi-role entity list | **BLOCKED — NOT PRODUCED** |
| Deterministic replay hashes | **BLOCKED — NOTHING TO REPLAY** |

**The ten critical-goal questions (1–10) are all unanswered.** Not one can be addressed
without the source.

---

## 4. Stage 12 — Zero-domain / zero-scan audit

**PASSES — trivially, and worth recording precisely.**

| Prohibited activity | Count | Evidence |
|---|---|---|
| Domain searches | **0** | No domain search of any kind was issued |
| Website inference | **0** | No organisation names were obtained, so none could be inferred from |
| DNS queries | **0** | No resolver was invoked |
| HTTP requests to organisation websites | **0** | The only network targets were `www.ofgem.gov.uk` and `epr.ofgem.gov.uk` — the authoritative publisher and its formal register |
| Monitoring enrolments | **0** | No observation state, cohort or schedule was touched |
| Scans | **0** | No collector was invoked |
| Companies House calls | **0** | Optional validation was not reached; it remains optional and is not a domain-discovery pathway |
| Production writes | **0** | No database connection was opened |
| Canonical data modified | **0** | Working tree clean at Stage 0; only this record added |
| Schema / migration changes | **0** | None |
| Scoring / scheduler changes | **0** | None |
| Deploys / merges / PRs | **0** | None |

Total network egress attempted this package: **three requests, to two Ofgem hosts, all
refused by the gateway.**

---

## 5. Stage 11 — Provenance position (recorded, unexercised)

Recorded so it is settled before retrieval, not after. Had the source been obtained, the
staging provenance would have been:

| Field | Value |
|---|---|
| Publisher | Ofgem |
| Artefact | List of all electricity licensees including suppliers |
| Authority status | **Ofgem-published list — non-formal-register artefact** |
| Formal authority reference | Ofgem Electronic Public Register (`epr.ofgem.gov.uk`) |
| Confidence | **`corroborated`** — existing `organisation/schema.js` vocabulary, unchanged |

The list would **not** be represented as the formal statutory Public Register. Promotion of
any fact to `verified` would require a check against the EPR — which is **also blocked**
(§2.1, attempt 3), so even the verification path is currently unavailable.

No new confidence vocabulary was introduced for UTIL-01, as instructed.

---

## 6. Isolated worktree

**No worktree or branch was created.**

Stage 0 calls for an isolated worktree/branch for the implementation. Since Stage 1 failed
closed and §3 establishes that no implementation can honestly be written, an isolated
worktree would contain nothing. Creating one would be procedural theatre, not isolation.

The working tree was clean at Stage 0 and remains clean apart from this record. This
document is added to the existing research branch alongside the two design packages it
follows.

---

## 7. Deliverables checklist

| # | Deliverable | Status |
|---|---|---|
| 1 | Branch / worktree / HEAD | **Recorded** — §1 |
| 2 | Source retrieved and SHA-256 | **BLOCKED** — §2. No bytes, no hash |
| 3 | Exact census | **BLOCKED** — §3.1 |
| 4 | Exact licence vocabulary | **BLOCKED** — not derived from source |
| 5 | Classification census | **BLOCKED** |
| 6 | Infrastructure subset census | **BLOCKED** |
| 7 | Multi-role entities | **BLOCKED** |
| 8 | Rejected / unresolved records | **BLOCKED** |
| 9 | Deterministic replay result | **BLOCKED** — nothing to replay |
| 10 | Tests | **NOT WRITTEN** — would require synthetic fixtures (§3) |
| 11 | Zero-domain / zero-scan audit | **PASS** — §4 |
| 12 | Files changed | **One:** this record. No code, no schema, no data |
| 13 | Staging artifact locations | **None created** — §3 |
| 14 | Next-layer recommendation | **WITHHELD** — §8 |

---

## 8. Stage 17 — Next-layer recommendation: WITHHELD

Stage 17 requires the recommendation to be made *"based on the real UTIL-01 data."* There
is no UTIL-01 data. Recommending a next layer now would rest on the same UTIL-ACQ-001
reasoning that already selected UTIL-01 — adding nothing, while implying a measured basis
that does not exist.

**UTIL-ACQ-001 §16's ordering therefore stands unchanged and unconfirmed.** Its two open
questions remain open:

1. Does the Ofgem electricity list carry company numbers for **all** rows? (Determines
   whether the spine reaches the strongest identity tier.)
2. What is the exact licence-type vocabulary as published? (Determines the role mapping,
   which §3 establishes cannot be authored speculatively.)

Both are answered by one retrieval. Neither is answerable without it.

**On the buyer→supplier graph:** UTIL-01 produced no evidence, so it neither strengthens
nor weakens that case. The material constraint identified in UTIL-ACQ-001 §20.1 is
unchanged and is not a data question: the `Relationship` object has no implementation in
this repository, so UTIL-06 remains blocked on a governance decision regardless of what
UTIL-01 eventually measures.

---

## 9. Unblock path

UTIL-01 is **ready to execute the moment egress permits**, and nothing else stands in its
way. Required, in order:

1. **Allow `www.ofgem.gov.uk` (and preferably `epr.ofgem.gov.uk`) in the session's egress
   policy.** This is an administrator action on the environment's network policy — it
   cannot be resolved from inside the session, and must not be worked around.
2. Re-run Stage 1: resolve the current PDF URL **from the publication page**, retrieve,
   hash, preserve.
3. Inspect the artefact before writing any parser — confirm actual header spelling
   (Stage 2) and derive the exact licence vocabulary (Stage 4).
4. Proceed through Stages 2–16 as specified.

Retrieving `epr.ofgem.gov.uk` as well would additionally allow the `corroborated` →
`verified` promotion path in §5 to be exercised rather than merely designed.

**Nothing in this package should be re-attempted until step 1 is done.** Every alternative
route to the data — mirrors, caches, search snippets, model knowledge, synthesised rows —
is a provenance failure, and this package exists to establish provenance.

---

*End of UTIL-01 fail-closed record. No acquisition performed. No dataset produced. No
production system, canonical dataset, schema, migration, cohort, monitoring state, scoring
or scheduler configuration was read for modification or modified. No organisations were
admitted. No domains were discovered, inferred or resolved. No DNS lookups. No scans. No
pull request.*
