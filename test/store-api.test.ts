import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { decode, type Snapshot } from '../src/registers/deye-1p.ts';
import { Store, localDate } from '../src/store/db.ts';
import { buildApi, type LiveSource, type Status } from '../src/api/http.ts';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/registers-2026-11-27.json', import.meta.url), 'utf8')) as Record<string, number>;
const base = decode(new Map(Object.entries(raw).map(([k, v]) => [Number(k), v])));

function snap(t: Date, patch: { pv?: number; pvDay?: number; load?: number } = {}): Snapshot {
  const s = structuredClone(base);
  s.time = t.toISOString();
  if (patch.pv !== undefined) s.pv.powerW = patch.pv;
  if (patch.load !== undefined) s.load.powerW = patch.load;
  if (patch.pvDay !== undefined) s.today.pvKWh = patch.pvDay;
  return s;
}

test('decoder exposes plausible lifetime totals', () => {
  assert.ok(base.total.pvKWh > base.today.pvKWh);
  assert.ok(base.total.loadKWh > 0 && base.total.batteryChargeKWh > 0);
});

test('stores samples, rolls up minutes and downsamples history', () => {
  const st = new Store(':memory:');
  const t0 = Date.UTC(2026, 10, 27, 4, 0, 0);
  for (let i = 0; i < 90; i++) st.addSnapshot(snap(new Date(t0 + i * 2000), { pv: i < 30 ? 1000 : 2000 })); // 3 minutes
  st.rollupMinutes(t0);
  assert.equal(st.stats().samples, 90);
  assert.equal(st.stats().minutes, 3);
  const h = st.history('1h', t0 + 180_000);
  assert.equal(h.bucketSec, 10);
  assert.equal(h.points.length, 18);
  assert.equal(h.points[0].pv_w, 1000);
  assert.equal(h.points.at(-1)!.pv_w, 2000);
  const m = st.db.prepare('SELECT pv_w, n FROM minutes ORDER BY ts').all() as { pv_w: number; n: number }[];
  assert.deepEqual(m.map((r) => r.n), [30, 30, 30]);
  assert.equal(m[0].pv_w, 1000);
  st.close();
});

test('prune drops only raw samples older than retention', () => {
  const st = new Store(':memory:');
  const now = Date.UTC(2026, 10, 27, 4);
  st.addSnapshot(snap(new Date(now - 8 * 86400e3)));
  st.addSnapshot(snap(new Date(now - 1000)));
  st.rollupMinutes(0);
  assert.equal(st.prune(now), 1);
  assert.equal(st.stats().samples, 1);
  assert.equal(st.stats().minutes, 2);
  st.close();
});

test('daily counters keep the max per local date and start fresh after midnight', () => {
  const st = new Store(':memory:');
  const day1 = new Date(2026, 10, 27, 23, 58), day1late = new Date(2026, 10, 27, 23, 59, 50), day2 = new Date(2026, 10, 28, 0, 1);
  st.addSnapshot(snap(day1, { pvDay: 12.3 }));
  st.addSnapshot(snap(day1late, { pvDay: 0 })); // inverter reset its counter a bit early
  st.addSnapshot(snap(day2, { pvDay: 0.1 }));
  const rows = st.daily(5, day2);
  assert.deepEqual(rows.map((r) => [r.date, r.pvKWh]), [[localDate(day1), 12.3], [localDate(day2), 0.1]]);
  st.close();
});

class FakeLive extends EventEmitter<{ snapshot: [Snapshot]; status: [Status] }> implements LiveSource {
  snap: Snapshot | null = null;
  latest() { return this.snap; }
  status(): Status { return { dongleConnected: !!this.snap, inverterResponding: true, donglePn: 'E60000230574080288', lastRxAgoSec: 0, lastSnapshotAt: this.snap?.time ?? null, startedAt: 'x' }; }
}

test('REST endpoints', async () => {
  const st = new Store(':memory:');
  const live = new FakeLive();
  const app = await buildApi(st, live);
  assert.equal((await app.inject('/api/live')).statusCode, 503);
  live.snap = snap(new Date());
  st.addSnapshot(live.snap);
  const liveRes = await app.inject('/api/live');
  assert.equal(liveRes.statusCode, 200);
  assert.equal(liveRes.json().battery.soc, base.battery.soc);
  assert.equal((await app.inject('/api/status')).json().storage.samples, 1);
  assert.equal((await app.inject('/api/history?range=1h')).json().points.length, 1);
  assert.equal((await app.inject('/api/history?range=2h')).statusCode, 400);
  assert.equal((await app.inject('/api/energy/daily?days=7')).json().days.length, 1);
  assert.equal((await app.inject('/api/energy/daily?days=0')).statusCode, 400);
  await app.close();
  st.close();
});

test('WebSocket pushes status on connect and snapshots as they arrive', async () => {
  const st = new Store(':memory:');
  const live = new FakeLive();
  const app = await buildApi(st, live);
  await app.ready();
  const msgs: { type: string }[] = [];
  let done!: () => void;
  const got = new Promise<void>((res) => { done = res; });
  // attach the listener before the handshake completes: the server sends status immediately
  const ws = await app.injectWS('/ws/live', {}, {
    onInit: (w) => w.on('message', (m) => { msgs.push(JSON.parse(String(m))); if (msgs.length === 2) done(); }),
  });
  live.emit('snapshot', snap(new Date()));
  await got;
  assert.deepEqual(msgs.map((m) => m.type), ['status', 'snapshot']);
  ws.terminate();
  await app.close();
  st.close();
});
