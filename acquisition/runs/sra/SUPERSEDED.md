# SUPERSEDED — SRA Organisation Registry (legacy)

`registry.ndjson` (+ `manifest.json`, `snapshots/`) in this directory is the
**legacy derived SRA registry** (the 10,354 website-bearing subset of the
2026-06-29 `live-003` package), now **superseded** by the canonical Organisation
Dataset — `ORG-AUTHORITY-001` (`backend/authority/dataset/`).

- **No longer authoritative** and **no longer part of the operational execution
  path.** The Observatory resolves organisations only from the canonical dataset.
- The **authoritative SRA raw dataset** is now the sealed Collection Package
  `backend/collection/sources/sra/runs/live-004/raw/snapshot.json` (whole
  register, 25,089 organisations, SHA-256 `cc8c47ea…`). The canonical build reads
  that package directly and ingests **every** SRA organisation — including the
  no-website firms this derived registry excluded — as VERIFIED / PENDING /
  NO_DOMAIN.
- **Retained for historical provenance** only.

See `ORG-AUTHORITY-001` in `docs/DOCUMENT_REGISTER.md`.
