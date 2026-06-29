# SRA Collection Platform — Technical Debt Register (v1.0 backlog)

**Document ID:** TDR-SRA-001 (registered in `docs/DOCUMENT_REGISTER.md` → ENGINEERING; governance identity assigned by SLG-027 §7; non-authoritative pending Founder Review per SLG-019)

Items deliberately **NOT** addressed in Collection Platform v1.0. These are backlog
only — do not implement as part of the frozen baseline. Each is outside v1.0 scope
(benchmarking, frontend, commercial validation, and future sources come first/next).

| ID | Item | Why deferred | Trigger / when to do it |
|----|------|--------------|--------------------------|
| ~~**TD-1**~~ | **Worker snapshot dedup** (content-hash) | Source exposes no production timestamp | ✅ **RESOLVED 2026-06-29** — content-hash dedup implemented in `sra-worker.js`, deployed to Railway, confirmed live (collects on change, skips when unchanged). Continuous unattended polling unblocked. |
| TD-2 | **Streaming extraction / verification** | Extract holds ~1 M record objects in memory; works under default heap at ~25 k orgs | When a source/dataset pushes memory toward the heap limit |
| TD-3 | **Object storage / retention** for Collection Packages (vs Railway Volume) | Volume is sufficient for single-writer v1.0; **commissioning confirmed ~1 GB per sealed package** | Size the volume + adopt a retention policy now; object storage when off-box durability / multi-consumer access is needed |
| TD-4 | **Horizontal scaling** (multi-replica workers) | Single-writer avoids package/listing races; one daily bulk pull is cheap | Many sources or sub-daily cadence needing parallelism |
| TD-5 | **Metrics / dashboard** | Lightweight health (status file + optional HTTP) is enough for v1.0 | Operational observability needs grow |
| TD-6 | **Production-timestamp source discovery** | GetAll has none; a separate SRA metadata/last-updated endpoint may exist | Investigate alongside TD-1 |
| TD-7 | **Rate-limit confirmation** from the SRA Technical Document | Single daily bulk call is well within any plausible cap | Before increasing poll frequency |
| TD-8 | **Subscription-key rotation** (primary `SRAP_API_KEY` ↔ secondary `SRAS_API_KEY`) | Single key works; rotation is operational hygiene | Routine credential rotation policy |
| TD-9 | **Benchmarking / derivation / scoring** over Collection Packages | Explicitly out of Collection Platform scope; the platform only collects evidence | The next major workstream, built above the frozen baseline |

## Resolved during Railway commissioning (2026-06-29)

- **TD-1 — worker snapshot dedup:** RESOLVED. Content-hash duplicate detection (compares the live snapshot SHA-256 against the latest sealed package's recorded raw hash) implemented in the worker, deployed, and confirmed live. Continuous unattended polling is no longer blocked. *(TD-6 production-timestamp discovery is consequently optional, not required.)*
- **Response-body timeout (production defect — discovered + fixed):** the fixed 60 s response-body timeout was too short for the ~24 MB SRA `GetAll` body over Railway egress (`"response body timeout"` CONNECTION_ERROR at commissioning). Corrected to a configurable timeout, default **300 s**, override via `SRA_REQUEST_TIMEOUT_MS` (single source of truth in `sra-client.js`; `checkConnectivity`/`acquireSnapshot` inherit it through the transport client). An accepted production-defect correction to the otherwise-frozen Collection Layer (SLG-027 §7); no behaviour/retry/output change.

These are recorded for planning only. The frozen Collection Platform v1.0 baseline is
defined in `PLATFORM-v1.0-BASELINE.md`.
