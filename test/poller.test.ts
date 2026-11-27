import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { Poller } from '../src/poller.ts';
import type { CollectorServer } from '../src/collector/server.ts';
import type { Announcer } from '../src/collector/announcer.ts';
import { crc16 } from '../src/protocol/modbus.ts';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/registers-2026-11-27.json', import.meta.url), 'utf8')) as Record<string, number>;

/** Fake dongle: answers reads from the fixture until `silent`, then returns empty FC4 payloads. */
class FakeCollector extends EventEmitter {
  connected = true;
  silent = false;
  restarts = 0;
  requests = 0;
  async request(payload: Buffer): Promise<Buffer> {
    this.requests++;
    if (this.silent) return Buffer.alloc(0);
    const start = payload.readUInt16BE(2), count = payload.readUInt16BE(4);
    const body = Buffer.alloc(3 + count * 2);
    body[0] = 1; body[1] = 3; body[2] = count * 2;
    for (let i = 0; i < count; i++) body.writeUInt16BE(raw[start + i] ?? 0, 3 + i * 2);
    const c = crc16(body);
    return Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])]);
  }
  restartDongle(): boolean {
    this.restarts++;
    // simulate reboot: socket drops, dongle comes back healthy and reconnects
    this.connected = false;
    this.emit('disconnected', 'restart');
    setTimeout(() => { this.silent = false; this.connected = true; this.emit('connected', 'fake'); }, 30);
    return true;
  }
  disconnect(): void { this.connected = false; }
}
const announcer = { announce: async () => {} } as unknown as Announcer;
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

test('restarts the dongle once when the inverter goes silent, then resumes polling', async () => {
  const c = new FakeCollector();
  const p = new Poller(c as unknown as CollectorServer, announcer, { fastIntervalMs: 20, quietAfterErrorMs: 0, silentProbeMs: 50, minRestartIntervalMs: 60_000 });
  const snaps: number[] = [];
  p.on('snapshot', () => snaps.push(Date.now()));
  p.start();
  await until(() => snaps.length >= 2);
  c.silent = true;
  await until(() => c.restarts === 1);
  assert.equal(p.inverterResponding, false);
  await until(() => p.inverterResponding);           // probe after reconnect succeeds
  const before = snaps.length;
  await until(() => snaps.length > before + 2);       // normal polling resumed
  assert.equal(c.restarts, 1);
  assert.equal(p.dongleRestarts, 1);
  p.stop();
});

test('does not restart more often than minRestartIntervalMs while still silent', async () => {
  const c = new FakeCollector();
  c.restartDongle = function () { this.restarts++; return true; }; // reboot doesn't help: stays silent
  const p = new Poller(c as unknown as CollectorServer, announcer, { fastIntervalMs: 10, quietAfterErrorMs: 0, silentProbeMs: 10, minRestartIntervalMs: 60_000 });
  p.start();
  await until(() => p.dongleRestarts >= 1 || c.requests > 0);
  c.silent = true;
  await until(() => c.restarts === 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.restarts, 1);
  p.stop();
});

test('scheduled restart after N requests', async () => {
  const c = new FakeCollector();
  const p = new Poller(c as unknown as CollectorServer, announcer, { fastIntervalMs: 10, restartEveryRequests: 6 });
  p.start();
  await until(() => c.restarts >= 1);
  assert.ok(c.requests >= 6);
  p.stop();
});
