# Pipeline scripts — not canonical migrations

`migrate.sql`, `migrate_v2.sql`, `migrate_v3.sql`, and `migrate_v4.sql` in this
directory are the **Research Pipeline** schema history (V1–V4) for the
`prospects`/`cohorts` tables — applied manually via the Supabase Dashboard SQL
Editor, in order, before the numbered sequence below existed.

They are **not** part of the canonical, ordered migration sequence in
`backend/db/migrations/` (`000_*.sql` … `022_*.sql`) and must not be renumbered
into it. `005_dataset_governance.sql` in `db/migrations/` was originally
`migrate_v5.sql` — the one member of this family that received a dedicated
apply script (`migrate_v5.js`) and a real slot in the numbered sequence; it was
renamed and moved during WS2 Phase P2 (WP-05) to close the numbering gap
between `004` and `006`. `migrate.sql`/`v2`/`v3`/`v4` were not similarly
promoted — they predate the numbered sequence and have already been applied.

Utility scripts, not migrations of record — annotated per WS2-MIGRATION-PLAN-R2
WP-05.
