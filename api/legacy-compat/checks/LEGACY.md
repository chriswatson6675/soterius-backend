TRN class per ADR-SYS-009. Do not add new scanners here.

`port-scan.js` and `subdomains.js` were retired in WS2 Phase P5 (WP-12): a
`require()` audit across the whole `backend/` tree found zero callers for
either file, confirming ADR-SYS-009's "unwired" characterisation. They are
removed from this directory, not merely quarantined — their history remains
in git if ever needed.
