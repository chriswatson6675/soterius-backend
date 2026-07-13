TRN class per ADR-SYS-009. Do not add new scanners here.

This directory holds the raw per-check collectors (`ssl-check.js`,
`headers-check.js`, `dns-check.js`, `dns-collect.js`, `tech-detect.js`,
`gdpr-check.js`) consumed exclusively by
`backend/api/legacy-compat/legacy-scan-engine.js` — the historical
compatibility scoring engine. No new scans use these collectors as of the
Trust Profile / Observatory Quality Model migration
(`docs/signal-lab/decisions/ADR-SYS-011 — Retirement of Legacy Scanner as
Live Scoring Engine`). They are retained only so historical `scans` rows
(scoring_version `v1.0` / `legacy-scan-v1`) can still be interpreted and
re-rendered. All new scoring belongs in `backend/observatory/quality/`.

`port-scan.js` and `subdomains.js` were retired in WS2 Phase P5 (WP-12): a
`require()` audit across the whole `backend/` tree found zero callers for
either file, confirming ADR-SYS-009's "unwired" characterisation. They are
removed from this directory, not merely quarantined — their history remains
in git if ever needed.
