#!/usr/bin/env node
// Milestone 1: print live inverter values to the console.
//   npm run live            (env: HOST_IP, BROADCAST_IP, DONGLE_IP, POLL_MS, KEEPALIVE_MS, DEBUG_FRAMES=1)
//   node src/cli.ts --once  (print one snapshot as JSON and exit)
import { config } from './config.ts';
import { CollectorServer } from './collector/server.ts';
import { Announcer } from './collector/announcer.ts';
import { Poller } from './poller.ts';
import type { Snapshot } from './registers/deye-1p.ts';

const once = process.argv.includes('--once');
const ts = () => new Date().toLocaleTimeString();
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

const collector = new CollectorServer({ port: config.tcpPort });
const announcer = new Announcer({ hostIp: config.hostIp, tcpPort: config.tcpPort, broadcast: config.broadcast, dongleIp: config.dongleIp });
const poller = new Poller(collector, announcer, { fastIntervalMs: config.pollMs, keepaliveMs: config.keepaliveMs });

collector.on('connected', (r) => log(`dongle connected from ${r}`));
collector.on('disconnected', (why) => log(`dongle disconnected: ${why}`));
collector.on('pn', (pn) => log(`dongle PN ${pn}`));
collector.on('error', (e) => log('collector error:', e.message));
if (config.debugFrames) collector.on('frame', (d, f) => log(d, `tid=${f.tid} fc=${f.fc} ${f.payload.toString('hex')}`));
announcer.on('reply', (m, from) => log(`dongle UDP reply from ${from}: ${m}`));
announcer.on('error', (e) => log('UDP error:', e.message));
poller.on('status', (s) => log(s));
poller.on('readError', (b, why) => log(`read ${b.start}+${b.count} failed: ${why}`));

const w = (n: number) => `${n}`.padStart(5) + ' W';
function render(s: Snapshot): void {
  if (once) { console.log(JSON.stringify(s, null, 2)); void shutdown(0); return; }
  const b = s.battery, g = s.grid;
  const line = [
    `PV ${w(s.pv.powerW)} (${s.pv.strings.map((x) => `${x.voltage}V/${x.current}A`).join(', ')})`,
    `Load ${w(s.load.powerW)}`,
    `Batt ${b.soc}% ${b.voltage}V ${w(b.powerW)} ${b.state}`,
    `Grid ${g.connected ? `${g.voltage}V ${w(g.powerW)}` : 'OFF'}`,
    `Inv ${s.inverter.state} ${s.inverter.tempRadiatorC}°C`,
    `Today PV ${s.today.pvKWh} kWh`,
  ].join(' | ');
  log(line);
}
poller.on('snapshot', render);

async function shutdown(code: number): Promise<never> {
  poller.stop();
  announcer.close();
  await collector.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  await collector.listen();
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.tcpPort} is already in use. Another collector (e.g. SolarPulse) is probably running; stop it first.`);
    process.exit(1);
  }
  throw e;
}
log(`listening on :${config.tcpPort}; announcing "${announcer.command}" to ${config.dongleIp ?? config.broadcast}`);
poller.start();
