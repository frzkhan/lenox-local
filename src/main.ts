#!/usr/bin/env node
// Full app: collector + poller + SQLite logging + REST/WebSocket API.
//   npm start   (env: DONGLE_IP, HOST_IP, BROADCAST_IP, WEB_PORT, DB_PATH, POLL_MS, KEEPALIVE_MS)
import { config } from './config.ts';
import { CollectorServer } from './collector/server.ts';
import { Announcer } from './collector/announcer.ts';
import { Poller } from './poller.ts';
import { Store } from './store/db.ts';
import { CollectorLive } from './live.ts';
import { buildApi } from './api/http.ts';

const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

const store = new Store(config.dbPath);
const collector = new CollectorServer({ port: config.tcpPort });
const announcer = new Announcer({ hostIp: config.hostIp, tcpPort: config.tcpPort, broadcast: config.broadcast, dongleIp: config.dongleIp });
const poller = new Poller(collector, announcer, { fastIntervalMs: config.pollMs, keepaliveMs: config.keepaliveMs, restartEveryRequests: config.restartEveryRequests });
const live = new CollectorLive(collector, poller);

collector.on('connected', (r) => log(`dongle connected from ${r}`));
collector.on('disconnected', (why) => log(`dongle disconnected: ${why}`));
collector.on('pn', (pn) => log(`dongle PN ${pn}`));
collector.on('error', (e) => log('collector error:', e.message));
announcer.on('error', (e) => log('UDP error:', e.message));
poller.on('status', (s) => log(s));
poller.on('readError', (b, why) => log(`read ${b.start}+${b.count} failed: ${why}`));

let stored = 0;
poller.on('snapshot', (s) => {
  try { store.addSnapshot(s); stored++; } catch (e) { log('store error:', (e as Error).message); }
});

const timers = [
  setInterval(() => { try { store.rollupMinutes(Date.now() - 3 * 60_000); } catch (e) { log('rollup error:', (e as Error).message); } }, 60_000),
  setInterval(() => { try { const n = store.prune(); if (n) log(`pruned ${n} old samples`); } catch (e) { log('prune error:', (e as Error).message); } }, 3600_000),
  setInterval(() => { if (stored) log(`stored ${stored} snapshots in the last 5 min`); stored = 0; }, 300_000),
];

const api = await buildApi(store, live, { webRoot: new URL('../web', import.meta.url).pathname });

async function shutdown(code: number): Promise<never> {
  for (const t of timers) clearInterval(t);
  poller.stop();
  announcer.close();
  await collector.close();
  await api.close();
  try { store.rollupMinutes(Date.now() - 3 * 60_000); } catch { /* ignore */ }
  store.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  await collector.listen();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${config.tcpPort} is in use: another collector (npm run live, SolarPulse, …) is running. Stop it first.`);
    process.exit(1);
  }
  throw e;
}
await api.listen({ port: config.webPort, host: '0.0.0.0' });
log(`collector :${config.tcpPort} | API http://${config.hostIp}:${config.webPort} | db ${config.dbPath}`);
poller.start();
