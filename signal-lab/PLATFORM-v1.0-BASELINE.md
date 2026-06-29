# SRA Collection Platform — v1.0 Engineering Baseline (FROZEN)

**Document ID:** BAS-SRA-001 (registered in `docs/DOCUMENT_REGISTER.md` → ENGINEERING; governance identity assigned by SLG-027 §7; non-authoritative pending Founder Review per SLG-019)
**Version:** Collection Platform v1.0 · collector `sra-snapshot-collector/0.1.0`
**Status:** COMPLETE — first live acquisition succeeded; platform frozen.
**Baseline date:** 2026-06-29

This document is the immutable engineering baseline. The modules listed under
"Frozen" are not to be modified except to fix a genuine production defect. Future
effort (benchmarking, frontend, commercial validation, new sources) builds on top of
this baseline, not inside it.

---

## 1. Architectural summary

A constitutional, append-only **Collection Layer** that turns a live regulatory
source into an immutable, integrity-verified **Collection Package**, plus an
**Operational Worker** that drives it on Railway. Strict separation: the Collection
Layer knows nothing about Railway, scheduling, or deployment.

```
Observe → Preserve → Manifest → Extract → Provenance → Integrity → Seal → Report
   (pure, deterministic, append-only, byte-faithful, fully traceable)

Operational Worker  ── drives ──▶  collectSnapshot()  +  generateReports()
   (poll · graceful shutdown · health)        (the frozen Collection Layer)
```

A Collection Package becomes authoritative only when `SEALED` is written, and only
after integrity verification passes. Raw evidence is preserved byte-for-byte and is
never mutated; structured evidence, provenance, and reports are all regenerable from
the immutable raw.

## 2. Module inventory (v1.0)

### Collection Layer — `backend/signal-lab/sources/sra/` — **FROZEN**
| Stage | Modules |
|---|---|
| Observe | `sra-client.js`, `snapshot-source.js`, `acquire-snapshot.js`, `connectivity-check.js` |
| Preserve + Manifest | `preserve-snapshot.js`, `evidence-path.js`, `manifest.js` |
| Extract | `extract.js`, `sra-extract-map.js`, `structured-evidence.js` |
| Provenance | `provenance.js` |
| Integrity | `integrity.js` |
| Seal / lifecycle | `collection-package.js`, `collection-run.js` |
| Orchestration | `run-snapshot.js` |
| Report | `report.js`, `snapshot-run-model.js`, `coverage.js`, `sra-report-profile.js` |
| Resilience (shared) | `retry.js` |

### Operational Worker — `backend/signal-lab/workers/` — **FROZEN**
`sra-worker.js` (poll loop, graceful shutdown, config validation), `worker-health.js`
(operational health state; status file + optional HTTP).

### Deployment — **FROZEN (operational)**
`workers/DEPLOYMENT.md` (Railway runbook), `workers/.env.example`, `package.json`
`worker` script, `sources/sra/.gitignore`.

### Configuration
`snapshot-source.js` holds the SRA-confirmed locators (see §6). The subscription key
and `RUN_ROOT`/`CHECK_INTERVAL`/`LOG_LEVEL` are supplied via environment.

### Testing — `*.test.js` co-located with each module (see §4).

## 3. Production hardening applied (this baseline)

Two genuine production defects were found during the live run and fixed; the
remaining same-class whole-file string operations were then hardened (permitted
exception: "remove identified production-scale memory limitations"). All are
mechanism-only changes — identical outputs, identical APIs, no redesign.

| Module | Change | Why |
|---|---|---|
| `provenance.js` | batched lineage write; Buffer-based structured read; stream (no full 1M-object array) | lineage 599 MB `.join()` → `Invalid string length` |
| `snapshot-run-model.js` | Buffer-based NDJSON iteration (`eachLine`) | lineage read `readFileSync('utf8')` → `ERR_STRING_TOO_LONG` |
| `integrity.js` | Buffer-based structured iteration | 344 MB structured read would crash > ~512 MB |
| `extract.js` | batched structured write (5 000-line flush) | per-segment `.join()` would crash > ~512 MB |

**Result:** the full live dataset (≈24 MB raw → ~1 M structured records → ~600 MB
lineage) now processes end-to-end **under default Node heap** (no `--max-old-space-size`
needed). No remaining whole-file utf8 string read/write exceeds the limit at any file
size below the ~2 GB Buffer ceiling. Small files (raw-index, manifest, SEALED) keep
simple reads.

## 4. Test baseline

- **Total: 132 tests, 0 failures**, across 18 files (Node built-in `node:test`).
- **Collection Layer: 114** — every constitutional stage has dedicated unit tests:

| Stage | Test file(s) | Tests |
|---|---|---|
| Observe | sra-client (7), snapshot-source via acquire (7), connectivity-check (7) | 21 |
| Preserve / Manifest / Seal | preserve-snapshot (6), manifest (5), evidence-path (4), collection-package (8) | 23 |
| Extract | extract (10), sra-extract-map (12) | 22 |
| Provenance | provenance (7) | 7 |
| Integrity | integrity (11) | 11 |
| Coverage / Report | coverage (6), report (9) | 15 |
| Lifecycle / Orchestration | collection-run (6), run-snapshot (9) | 15 |

- **Operational Worker: 18** — sra-worker (9), worker-health (4), deployment (5;
  restart / duplicate-prevention / resume against a real persistent `RUN_ROOT`).
- **Live operational validation: PASSED** (see §5).

## 5. Operational validation summary (live, 2026-06-29)

| Metric | Result |
|---|---|
| Endpoint | `GET https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll` |
| Connectivity / auth | 200 OK, `Ocp-Apim-Subscription-Key` |
| Firms observed | **25,078** organisations (= payload `Count`) |
| Structured observations | **1,008,920** (firm 25,078 · firm.field 476,482 · office 33,824 · office.field 473,536); distinct anchors 25,078 |
| Integrity | **VERIFIED** — 1,008,920 / 1,008,920 reconstructed; raw hash 1/1; manifest consistent |
| Package | **SEALED**; coverageComplete = true; discoveries = 0 |
| Runtime / memory | ~22 s, default Node heap |
| Reports | collection / coverage / health / discoveries all generated |

## 6. Confirmed source values (Technical Document, empirical)

`SRA_BASE_URL = https://sra-prod-apim.azure-api.net` · `datasetPath =
/datashare/api/V1/organisation/GetAll` · auth header `Ocp-Apim-Subscription-Key` ·
payload `{ Count, Organisations[] }` · `recordsPath ['Organisations']` · `anchorPath
['SraNumber']` (numeric) · `officesPath ['Offices']` · single document, no pagination.
**No dataset production timestamp** is exposed (body or headers) → resolves to `null`.

## 7. Known limitations (v1.0)

1. **No production timestamp from the source.** GetAll exposes no dataset production
   time. The worker's "newer snapshot" check therefore cannot distinguish snapshots
   and would re-collect every poll. → continuous worker operation needs dedup by
   raw content-hash or a fixed daily cadence (backlog item TD-1). One-shot /
   scheduled collection is unaffected and fully validated.
2. **In-memory record set.** Extraction holds ~1 M record objects in memory; this
   completes under default heap at the current dataset (~25 k orgs). Much larger
   datasets would need streaming (TD-2). String-limit crashes are removed.
3. **Single writer / local volume.** One worker replica; packages on a Railway
   Volume (local FS). No horizontal scaling, no object storage (TD-3, TD-4).
4. **Rate-limit number unconfirmed** (Technical Document, registration-gated); the
   single daily bulk call is well within any plausible cap.

## 8. Production readiness assessment

- **One-shot / scheduled collection: PRODUCTION-READY.** Proven live end-to-end with
  a sealed, integrity-verified package under default heap; full test coverage.
- **Continuous unattended worker: READY pending TD-1** (snapshot dedup). Until then,
  run the worker on a fixed daily cadence or add content-hash dedup, else it will
  create a new package every `CHECK_INTERVAL`.
- Deployment is documented (`DEPLOYMENT.md`): separate Railway worker service, volume
  at `RUN_ROOT`, env vars, graceful shutdown, fail-fast config validation.

## 9. Recommendations for future development

Build on top of this frozen baseline (do not modify it):
- **TD-1 (next):** worker snapshot dedup — raw content-hash comparison and/or
  scheduled daily cadence, given the absent production timestamp.
- Then: benchmarking / derivation over Collection Packages; frontend; commercial
  validation; additional collection sources (reuse this constitutional pattern).

## 10. Frozen declaration

All modules in §2 constitute **Collection Platform v1.0** and are **frozen** as of
this baseline. Changes are limited to genuine production-defect fixes. New
capability is delivered in new modules/layers above this baseline, not by editing it.
