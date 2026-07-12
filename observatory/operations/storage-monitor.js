'use strict';

// storage-monitor.js — production-hardening (Blocker 1): storage capacity &
// growth telemetry for the Observatory persistence layer.
//
// The Observatory NEVER deletes evidence: Observations and the Event log are
// immutable and append-only (OBS-CONST-001 P-3/P-4). Storage therefore only ever
// grows, and the operational risk is running out of it silently. This module is
// the early-warning system: it measures table sizes and row counts, tracks growth
// between snapshots, forecasts when configurable thresholds will be crossed, and
// raises warnings — WITHOUT ever proposing deletion of constitutional evidence.
//
// It is strictly READ + APPEND: it reads table stats and appends an immutable
// telemetry snapshot. It touches no Observation and no Event. (The snapshot table
// itself is a temporary operational artefact and MAY be given a retention policy —
// unlike evidence — see migration 044.)
//
// Pure helpers (linearForecast / computeGrowth / evaluateThresholds) carry the
// maths and are unit-tested with no database. captureSnapshot orchestrates the
// reads and is fully injectable.

const logger = require('../../infra/utils/logger');

// The tables the monitor watches, grouped by the growth metric each feeds. The
// list is a sensible default; callers may override via opts.groups. Unknown/
// absent tables are skipped gracefully (count 0) so this never fails a run.
const DEFAULT_GROUPS = Object.freeze({
  // Evidence — immutable Observations. The bulk of national-collection growth.
  observations: [
    'signal_facts_spf', 'signal_facts_dkim', 'signal_facts_dkim_keys', 'signal_facts_dmarc',
    'signal_facts_mtasts', 'signal_facts_tlsrpt', 'signal_facts_dnssec', 'signal_facts_caa',
    'signal_securitytxt_v1', 'signal_securityheaders_v1', 'signal_tls_v1', 'signal_certificate_v1',
  ],
  // Derived quality (also append-only per national baseline).
  quality: [
    'signal_quality_spf', 'signal_quality_dkim', 'signal_quality_dmarc', 'signal_quality_caa',
    'signal_quality_dnssec', 'signal_quality_mtasts', 'signal_quality_tls', 'signal_quality_certificate',
    'signal_quality_securitytxt', 'signal_quality_securityheaders',
  ],
  // Collection Sessions — the operational run/ledger objects.
  sessions: ['collection_runs', 'collection_run_items', 'observation_sessions'],
  // The Event log.
  events: ['events'],
});

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

// Default warning thresholds — all configurable via env or opts.thresholds.
function defaultThresholds() {
  return {
    totalBytesWarn: envNum('STORAGE_WARN_TOTAL_BYTES', 8 * 1024 ** 3),       // 8 GiB
    totalBytesCritical: envNum('STORAGE_CRIT_TOTAL_BYTES', 12 * 1024 ** 3),  // 12 GiB (e.g. plan ceiling)
    tableRowsWarn: envNum('STORAGE_WARN_TABLE_ROWS', 50_000_000),
    growthPerDayBytesWarn: envNum('STORAGE_WARN_GROWTH_BYTES_PER_DAY', 512 * 1024 ** 2), // 512 MiB/day
    forecastHorizonDays: envNum('STORAGE_FORECAST_HORIZON_DAYS', 90),
  };
}

// linearForecast(points, horizonDays) — least-squares linear projection.
// points: [{ day, value }] where `day` is a numeric day index (or ms). Returns
// { slopePerDay, projected, daysUntil(threshold) }. With <2 points, slope is 0
// (not enough history to forecast) and projected = last value.
function linearForecast(points, horizonDays) {
  const pts = (points || []).filter((p) => Number.isFinite(p.day) && Number.isFinite(p.value));
  if (pts.length === 0) return { slopePerDay: 0, projected: 0, daysUntil: () => null };
  const last = pts[pts.length - 1];
  if (pts.length === 1) return { slopePerDay: 0, projected: last.value, daysUntil: () => null };

  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.day, 0);
  const sy = pts.reduce((a, p) => a + p.value, 0);
  const sxx = pts.reduce((a, p) => a + p.day * p.day, 0);
  const sxy = pts.reduce((a, p) => a + p.day * p.value, 0);
  const denom = n * sxx - sx * sx;
  const slopePerDay = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const projected = last.value + slopePerDay * horizonDays;

  return {
    slopePerDay,
    projected,
    // days from the last point until `threshold` is reached at the current slope.
    daysUntil: (threshold) => {
      if (slopePerDay <= 0) return null;          // not growing (or shrinking) → never
      if (last.value >= threshold) return 0;       // already past it
      return (threshold - last.value) / slopePerDay;
    },
  };
}

// computeGrowth(current, previous) — delta and per-day rate between two snapshots.
function computeGrowth(current, previous) {
  if (!previous) return { deltaBytes: null, deltaRows: null, days: null, bytesPerDay: null, rowsPerDay: null };
  const days = Math.max(
    (new Date(current.captured_at).getTime() - new Date(previous.captured_at).getTime()) / 86_400_000,
    0,
  );
  const deltaBytes = (current.total_bytes ?? 0) - (previous.total_bytes ?? 0);
  const deltaRows = (current.total_rows ?? 0) - (previous.total_rows ?? 0);
  return {
    deltaBytes, deltaRows, days,
    bytesPerDay: days > 0 ? deltaBytes / days : null,
    rowsPerDay: days > 0 ? deltaRows / days : null,
  };
}

// evaluateThresholds(snapshot, growth, forecast, thresholds) → warnings[]
function evaluateThresholds(snapshot, growth, forecast, thresholds) {
  const warnings = [];
  const add = (level, metric, value, threshold, message) => warnings.push({ level, metric, value, threshold, message });

  if (snapshot.total_bytes != null) {
    if (snapshot.total_bytes >= thresholds.totalBytesCritical) {
      add('CRITICAL', 'total_bytes', snapshot.total_bytes, thresholds.totalBytesCritical,
        `Total storage ${fmtBytes(snapshot.total_bytes)} has reached the critical ceiling ${fmtBytes(thresholds.totalBytesCritical)}.`);
    } else if (snapshot.total_bytes >= thresholds.totalBytesWarn) {
      add('WARN', 'total_bytes', snapshot.total_bytes, thresholds.totalBytesWarn,
        `Total storage ${fmtBytes(snapshot.total_bytes)} has crossed the warning threshold ${fmtBytes(thresholds.totalBytesWarn)}.`);
    }
  }

  for (const t of snapshot.tables) {
    if (t.rows >= thresholds.tableRowsWarn) {
      add('WARN', 'table_rows', t.rows, thresholds.tableRowsWarn, `Table ${t.table} has ${t.rows.toLocaleString()} rows.`);
    }
  }

  if (growth.bytesPerDay != null && growth.bytesPerDay >= thresholds.growthPerDayBytesWarn) {
    add('WARN', 'growth_bytes_per_day', growth.bytesPerDay, thresholds.growthPerDayBytesWarn,
      `Storage is growing ${fmtBytes(growth.bytesPerDay)}/day, above ${fmtBytes(thresholds.growthPerDayBytesWarn)}/day.`);
  }

  if (forecast && snapshot.total_bytes != null) {
    const daysUntilCritical = forecast.daysUntil(thresholds.totalBytesCritical);
    if (daysUntilCritical != null && daysUntilCritical <= thresholds.forecastHorizonDays) {
      add('WARN', 'forecast_days_until_critical', Math.round(daysUntilCritical), thresholds.forecastHorizonDays,
        `At the current growth rate, the critical ceiling is reached in ~${Math.round(daysUntilCritical)} days.`);
    }
  }

  return warnings;
}

function fmtBytes(n) {
  if (n == null) return 'n/a';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${(n < 0 ? '-' : '')}${v.toFixed(2)} ${u[i]}`;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

function getClient() { return require('../../infra/database').getClient(); }

// Default row-count reader — a PostgREST HEAD count (no rows transferred).
async function defaultGetRowCount(table, client) {
  try {
    const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
    if (error) return 0;
    return count ?? 0;
  } catch { return 0; }
}

// Default byte-size reader — a Postgres function installed by migration 044,
// callable via PostgREST rpc. Degrades gracefully to null (rows-only telemetry)
// if the function is not present (e.g. migration not yet applied).
async function defaultGetTableSizes(client) {
  try {
    const { data, error } = await client.rpc('observatory_table_sizes');
    if (error || !Array.isArray(data)) return null;
    const map = {};
    for (const r of data) map[r.table_name] = Number(r.total_bytes) || 0;
    return map;
  } catch { return null; }
}

// captureSnapshot(opts, deps) — measure current storage, compute growth vs the
// previous snapshot, forecast, evaluate thresholds, and (optionally) persist an
// immutable telemetry row. Returns the full report.
async function captureSnapshot(opts = {}, deps = {}) {
  const groups = opts.groups || DEFAULT_GROUPS;
  const thresholds = { ...defaultThresholds(), ...(opts.thresholds || {}) };

  // Resolve the Supabase client LAZILY — only if a default reader actually needs
  // it. Tests that inject every reader never touch the real client (and so never
  // require SUPABASE_* env vars).
  let _client = deps.client;
  const client = () => (_client ??= getClient());

  const {
    getRowCount = (t) => defaultGetRowCount(t, client()),
    getTableSizes = () => defaultGetTableSizes(client()),
    listPreviousSnapshots = defaultListPreviousSnapshots,
    insertSnapshot = defaultInsertSnapshot,
    now = () => new Date().toISOString(),
    persist = true,
  } = deps;

  const capturedAt = now();
  const sizes = await getTableSizes();

  const allTables = [];
  const groupTotals = {};
  for (const [group, tables] of Object.entries(groups)) {
    groupTotals[group] = { rows: 0, bytes: sizes ? 0 : null };
    for (const table of tables) {
      const rows = await getRowCount(table);
      const bytes = sizes ? (sizes[table] ?? 0) : null;
      allTables.push({ table, group, rows, bytes });
      groupTotals[group].rows += rows;
      if (sizes) groupTotals[group].bytes += bytes;
    }
  }

  const totalRows = allTables.reduce((a, t) => a + t.rows, 0);
  const totalBytes = sizes ? allTables.reduce((a, t) => a + (t.bytes ?? 0), 0) : null;

  const snapshot = {
    captured_at: capturedAt,
    total_rows: totalRows,
    total_bytes: totalBytes,
    tables: allTables,
    groups: groupTotals,
  };

  // Growth + forecast from history.
  const previous = await listPreviousSnapshots(10, _client);
  const prevLatest = previous && previous.length ? previous[0] : null;
  const growth = computeGrowth(snapshot, prevLatest);

  const series = [...(previous || [])].reverse().concat([snapshot])
    .map((s) => ({ day: new Date(s.captured_at).getTime() / 86_400_000, value: s.total_bytes ?? s.total_rows ?? 0 }));
  const forecast = linearForecast(series, thresholds.forecastHorizonDays);
  const forecastReport = {
    horizonDays: thresholds.forecastHorizonDays,
    metric: totalBytes != null ? 'bytes' : 'rows',
    slopePerDay: forecast.slopePerDay,
    projected: forecast.projected,
    daysUntilCritical: totalBytes != null ? forecast.daysUntil(thresholds.totalBytesCritical) : null,
  };

  const warnings = evaluateThresholds(snapshot, growth, forecast, thresholds);

  const report = { ...snapshot, growth, forecast: forecastReport, warnings, thresholds };

  if (persist) {
    try { await insertSnapshot(report, _client); }
    catch (e) { logger.error('[storage-monitor] snapshot persist failed:', { message: e.message }); }
  }
  if (warnings.length) {
    for (const w of warnings) logger.warn?.(`[storage-monitor] ${w.level}: ${w.message}`) ?? logger.error(`[storage-monitor] ${w.level}: ${w.message}`);
  }
  return report;
}

async function defaultListPreviousSnapshots(limit, client) {
  client = client || getClient();
  try {
    const { data, error } = await client
      .from('storage_capacity_snapshots')
      .select('captured_at, total_rows, total_bytes')
      .order('captured_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data ?? [];
  } catch { return []; }
}

async function defaultInsertSnapshot(report, client) {
  client = client || getClient();
  const row = {
    captured_at: report.captured_at,
    total_rows: report.total_rows,
    total_bytes: report.total_bytes,
    tables: report.tables,
    groups: report.groups,
    growth: report.growth,
    forecast: report.forecast,
    warnings: report.warnings,
  };
  const { error } = await client.from('storage_capacity_snapshots').insert([row]);
  if (error) throw new Error(error.message);
}

module.exports = {
  DEFAULT_GROUPS, defaultThresholds,
  linearForecast, computeGrowth, evaluateThresholds, fmtBytes,
  captureSnapshot,
};
