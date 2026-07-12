# National Observatory Baseline Report — NOB-001

**Baseline ID:** NOB-001
**Repository Authority:** ORG-AUTHORITY-001 (selection `org-authority-599986411945`)
**Scoring model:** TS-RUBRIC-v1.0 (Signal scope: Core — Categories A, B, C)
**Collection window:** 2026-07-06T23:56:55.336Z → 2026-07-07T08:50:07.222Z  (31992s)
**Status:** COMPLETE_PARTIAL_COVERAGE

> Organisation selection came exclusively from the canonical Repository Authority
> (ORG-AUTHORITY-001), VERIFIED domains only. No legacy cohort registry was referenced.

> ⚠️ **PARTIAL COVERAGE.** Eight of the nine Core signals reached the full VERIFIED
> population (17,057). The following did not and are **pending backfill** — until then
> they score as NON_OBSERVED (excluded from attainable) for the un-observed organisations:
> - **SOT-SECURITYTXT-001** — 7,428 / 17,057 (43.5%)
>
> This baseline was produced over current coverage by explicit Founder decision; it will
> be superseded once the outstanding signal(s) complete. All integrity checks still pass.

---

## 1. Population & scan outcome

| Metric | Value |
|---|---|
| Organisations in Authority | 35,752 |
| **Eligible (domainStatus = VERIFIED)** | **17,057** |
| Successfully scanned (≥1 observation) | 17,057 (100.0%) |
| Not scanned (no observation in window) | 0 (0.0%) |
| Observations persisted | 126,827 |
| Evidence points (domain × signal) | 126,827 |
| Orphan observations (unresolved to an Org ID) | 0 |

## 2. Trust Profile & Trust Score coverage

| Metric | Value |
|---|---|
| Organisations with a Trust Profile | 17,057 (100.0% of eligible) |
| Trust Scores computed (attainable ≥ 500) | 4,903 (28.7% of profiles) |
| INSUFFICIENT_OBSERVATION (attainable < 500) | 12,154 (71.3% of profiles) |
| Core-complete profiles (all 8 A/B/C signals observed) | 2,013 |

> **Why so many INSUFFICIENT?** TS-RUBRIC-v1.0 sets a hard "scoreable" floor at
> attainable ≥ 500/999, calibrated against the full A–H model. Baseline 001 collects
> Categories A, B, C only (max attainable 567), so any organisation missing DKIM
> (−70, and DKIM absence is unprovable → NON_OBSERVED) or a live web endpoint
> (−90 headers+security.txt) falls under the floor. This is the faithful, spec-compliant
> outcome — the scoring engine was **not** extended. Categories D/E/H are the Founder-
> designated enrichment phases that will lift most of these into scoreable range.

## 3. National Trust Score distribution (scored organisations)

| Statistic | Score (001–999) |
|---|---|
| n scored | 4,903 |
| min / max | 53 / 923 |
| mean | 319 |
| Q1 / median / Q3 | 243 / 302 / 392 |
| deciles (10→90) | 201, 223, 254, 267, 302, 338, 370, 412, 456 |

Provisional band distribution (SLG-038 §1 overlay — not canonical):

| Band | Organisations |
|---|---|
| Excellent | 1 |
| Good | 8 |
| Moderate | 64 |
| High | 1,074 |
| Critical | 3,756 |
| Insufficient | 12,154 |

## 4. Dynamic cohorts (generated views over the Authority)

Cohorts are predicates over organisation attributes carried on each Trust Profile —
no separate cohort registry exists. See the Signal Coverage Report for per-signal
national benchmarks, and `dataset/benchmarks.json` for full cohort statistics.

| Cohort | Orgs | Scored | Insufficient | Median | DMARC enforce | SPF | DNSSEC anchored | Web reachable |
|---|---|---|---|---|---|---|---|---|
| FCA-regulated | 7,376 | 2,332 | 5,044 | 303 | 32.6% | 77.4% | 3.9% | 90.1% |
| PRA-regulated | 9 | 0 | 9 | — | 55.6% | 11.1% | 11.1% | 66.7% |
| SRA-regulated | 9,543 | 2,557 | 6,986 | 299 | 36.4% | 73.3% | 4% | 86.6% |
| Higher Education | 142 | 15 | 127 | 379 | 59.9% | 18.3% | 4.2% | 81.7% |
| FCA & PRA (dual) | 9 | 0 | 9 | — | 55.6% | 11.1% | 11.1% | 66.7% |
| FCA & SRA (dual) | 4 | 1 | 3 | 454 | 75% | 50% | 0% | 100% |
| Multi-regulated | 13 | 1 | 12 | 454 | 61.5% | 23.1% | 7.7% | 76.9% |

---
*Generated 2026-07-07T08:50:07.222Z · NOB-001 · deterministic derivation over the baseline window.*