# SUPERSEDED — FCA Organisation Registry (legacy)

`registry.ndjson` (+ `manifest.json`, `snapshots/`) in this directory is a
**legacy organisation registry**, now **superseded** by the canonical
Organisation Dataset — `ORG-AUTHORITY-001` (`backend/authority/dataset/`).

- **No longer authoritative** and **no longer part of the operational execution
  path.** The Observatory resolves organisations only from the canonical dataset.
- **Retained for historical provenance** and as a **reconstruction input** to
  `backend/authority/build.js` (which merges it, with every other legacy
  registry, into the canonical dataset).

Do not consume this registry directly from any product/Observatory code. Resolve
organisations through the canonical dataset and their immutable Organisation IDs.
See `ORG-AUTHORITY-001` in `docs/DOCUMENT_REGISTER.md`.
