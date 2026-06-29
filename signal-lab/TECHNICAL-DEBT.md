# SRA Collection Platform — Technical Debt Register (v1.0 backlog)

Items deliberately **NOT** addressed in Collection Platform v1.0. These are backlog
only — do not implement as part of the frozen baseline. Each is outside v1.0 scope
(benchmarking, frontend, commercial validation, and future sources come first/next).

| ID | Item | Why deferred | Trigger / when to do it |
|----|------|--------------|--------------------------|
| **TD-1** | **Worker snapshot dedup** (raw content-hash compare and/or fixed daily cadence) | Source exposes no production timestamp, so the worker can't tell snapshots apart and would re-collect every poll | **Before** enabling continuous unattended polling. Until then run on a daily schedule. (Highest priority.) |
| TD-2 | **Streaming extraction / verification** | Extract holds ~1 M record objects in memory; works under default heap at ~25 k orgs | When a source/dataset pushes memory toward the heap limit |
| TD-3 | **Object storage** for Collection Packages (vs Railway Volume / local FS) | Volume is sufficient and simplest for single-writer v1.0 | Multi-consumer access, off-box durability, or volume size limits |
| TD-4 | **Horizontal scaling** (multi-replica workers) | Single-writer avoids package/listing races; one daily bulk pull is cheap | Many sources or sub-daily cadence needing parallelism |
| TD-5 | **Metrics / dashboard** | Lightweight health (status file + optional HTTP) is enough for v1.0 | Operational observability needs grow |
| TD-6 | **Production-timestamp source discovery** | GetAll has none; a separate SRA metadata/last-updated endpoint may exist | Investigate alongside TD-1 |
| TD-7 | **Rate-limit confirmation** from the SRA Technical Document | Single daily bulk call is well within any plausible cap | Before increasing poll frequency |
| TD-8 | **Subscription-key rotation** (primary `SRAP_API_KEY` ↔ secondary `SRAS_API_KEY`) | Single key works; rotation is operational hygiene | Routine credential rotation policy |
| TD-9 | **Benchmarking / derivation / scoring** over Collection Packages | Explicitly out of Collection Platform scope; the platform only collects evidence | The next major workstream, built above the frozen baseline |

These are recorded for planning only. The frozen Collection Platform v1.0 baseline is
defined in `PLATFORM-v1.0-BASELINE.md`.
