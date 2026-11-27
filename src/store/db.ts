// SQLite storage (built-in node:sqlite).
//   samples  – one row per snapshot (~2 s), kept RAW_RETENTION_DAYS
//   minutes  – 1-minute averages, kept forever (~525k rows/year)
//   daily    – inverter's own day counters (kWh), one row per local date
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { EnergyCounters, Snapshot } from '../registers/deye-1p.ts';

export const RAW_RETENTION_DAYS = 7;

const SERIES_COLS = ['pv_w', 'pv1_w', 'pv2_w', 'load_w', 'batt_w', 'batt_soc', 'batt_v', 'grid_w', 'grid_v', 'inv_temp'] as const;
export type SeriesCol = (typeof SERIES_COLS)[number];

export interface HistoryPoint { ts: number; [k: string]: number }
export interface DailyRow extends EnergyCounters { date: string }

export type Range = '1h' | '6h' | '24h' | '7d' | '30d' | '365d';
const RANGES: Record<Range, { ms: number; bucketSec: number }> = {
  '1h': { ms: 3600e3, bucketSec: 10 },
  '6h': { ms: 6 * 3600e3, bucketSec: 60 },
  '24h': { ms: 24 * 3600e3, bucketSec: 300 },
  '7d': { ms: 7 * 86400e3, bucketSec: 1800 },
  '30d': { ms: 30 * 86400e3, bucketSec: 3600 * 3 },
  '365d': { ms: 365 * 86400e3, bucketSec: 86400 },
};
export const isRange = (r: unknown): r is Range => typeof r === 'string' && r in RANGES;

/** Local calendar date (YYYY-MM-DD) in the host's timezone. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Store {
  readonly db: DatabaseSync;
  #insertSample;
  #upsertDaily;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS samples (
        ts INTEGER PRIMARY KEY, pv_w REAL, pv1_w REAL, pv2_w REAL, load_w REAL, batt_w REAL, batt_soc REAL,
        batt_v REAL, grid_w REAL, grid_v REAL, grid_on INTEGER, inv_temp REAL);
      CREATE TABLE IF NOT EXISTS minutes (
        ts INTEGER PRIMARY KEY, pv_w REAL, pv1_w REAL, pv2_w REAL, load_w REAL, batt_w REAL, batt_soc REAL,
        batt_v REAL, grid_w REAL, grid_v REAL, inv_temp REAL, n INTEGER);
      CREATE TABLE IF NOT EXISTS daily (
        date TEXT PRIMARY KEY, pv_kwh REAL, load_kwh REAL, grid_import_kwh REAL, grid_export_kwh REAL,
        batt_charge_kwh REAL, batt_discharge_kwh REAL, updated INTEGER);
    `);
    this.#insertSample = this.db.prepare(`INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Day counters only grow during a day; MAX() guards against a counter reset landing on the old date.
    this.#upsertDaily = this.db.prepare(`
      INSERT INTO daily VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        pv_kwh = MAX(pv_kwh, excluded.pv_kwh), load_kwh = MAX(load_kwh, excluded.load_kwh),
        grid_import_kwh = MAX(grid_import_kwh, excluded.grid_import_kwh),
        grid_export_kwh = MAX(grid_export_kwh, excluded.grid_export_kwh),
        batt_charge_kwh = MAX(batt_charge_kwh, excluded.batt_charge_kwh),
        batt_discharge_kwh = MAX(batt_discharge_kwh, excluded.batt_discharge_kwh),
        updated = excluded.updated`);
  }

  addSnapshot(s: Snapshot): void {
    const ts = Date.parse(s.time);
    this.#insertSample.run(
      ts, s.pv.powerW, s.pv.strings[0]?.powerW ?? 0, s.pv.strings[1]?.powerW ?? 0, s.load.powerW,
      s.battery.powerW, s.battery.soc, s.battery.voltage, s.grid.powerW, s.grid.voltage,
      s.grid.connected ? 1 : 0, s.inverter.tempRadiatorC,
    );
    const t = s.today;
    this.#upsertDaily.run(localDate(new Date(ts)), t.pvKWh, t.loadKWh, t.gridImportKWh, t.gridExportKWh,
      t.batteryChargeKWh, t.batteryDischargeKWh, ts);
  }

  /** Recompute minute averages for samples at or after `sinceMs` (call every minute with a small lookback). */
  rollupMinutes(sinceMs: number): void {
    const avg = SERIES_COLS.map((c) => `AVG(${c})`).join(', ');
    this.db.prepare(`
      INSERT OR REPLACE INTO minutes (ts, ${SERIES_COLS.join(', ')}, n)
      SELECT (ts / 60000) * 60000 AS m, ${avg}, COUNT(*) FROM samples
      WHERE ts >= ? GROUP BY m`).run(Math.floor(sinceMs / 60000) * 60000);
  }

  prune(nowMs = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM samples WHERE ts < ?').run(nowMs - RAW_RETENTION_DAYS * 86400e3).changes);
  }

  /** Downsampled time series. Uses raw samples for ranges up to 24 h, minute rollups beyond. */
  history(range: Range, nowMs = Date.now()): { range: Range; bucketSec: number; points: HistoryPoint[] } {
    const { ms, bucketSec } = RANGES[range];
    const table = ms <= 24 * 3600e3 ? 'samples' : 'minutes';
    const b = bucketSec * 1000;
    const cols = SERIES_COLS.map((c) => `ROUND(AVG(${c}), 2) AS ${c}`).join(', ');
    const rows = this.db.prepare(`
      SELECT (ts / ${b}) * ${b} AS bucket, ${cols} FROM ${table}
      WHERE ts >= ? GROUP BY bucket ORDER BY bucket`).all(nowMs - ms) as Record<string, number>[];
    const points = rows.map(({ bucket, ...rest }) => ({ ts: bucket, ...rest }));
    return { range, bucketSec, points };
  }

  daily(days: number, now = new Date()): DailyRow[] {
    const from = new Date(now); from.setDate(from.getDate() - (days - 1));
    return (this.db.prepare(`SELECT * FROM daily WHERE date >= ? ORDER BY date`).all(localDate(from)) as Record<string, number | string>[])
      .map((r) => ({
        date: r.date as string, pvKWh: r.pv_kwh as number, loadKWh: r.load_kwh as number,
        gridImportKWh: r.grid_import_kwh as number, gridExportKWh: r.grid_export_kwh as number,
        batteryChargeKWh: r.batt_charge_kwh as number, batteryDischargeKWh: r.batt_discharge_kwh as number,
      }));
  }

  stats(): { samples: number; minutes: number; days: number; oldestSample: number | null } {
    const one = (sql: string) => Object.values(this.db.prepare(sql).get() as object)[0] as number | null;
    return {
      samples: one('SELECT COUNT(*) FROM samples') ?? 0,
      minutes: one('SELECT COUNT(*) FROM minutes') ?? 0,
      days: one('SELECT COUNT(*) FROM daily') ?? 0,
      oldestSample: one('SELECT MIN(ts) FROM samples'),
    };
  }

  close(): void {
    this.db.close();
  }
}
