#!/usr/bin/env node
// READ-ONLY Modbus register scan through the Eybond dongle (FC3 / FC4 reads only).
// Usage: node probe/modbus-scan.mjs [dongleIp] [hostIp]
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

const DONGLE_IP = process.argv[2] || '192.168.0.101';
const HOST_IP = process.argv[3] || '192.168.0.102';
const outFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'captures', `modbus-scan-${Date.now()}.json`);

function crc16modbus(b) { let c = 0xffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; } return c; }
function readReq(fc, reg, n) {
  if (fc !== 3 && fc !== 4) throw new Error('read-only: FC3/FC4 only');
  const b = Buffer.from([1, fc, reg >> 8, reg & 0xff, n >> 8, n & 0xff]);
  const c = crc16modbus(b); return Buffer.concat([b, Buffer.from([c & 0xff, c >> 8])]);
}
let tid = 0;
function ey(fc, payload) {
  const h = Buffer.alloc(8); tid = (tid % 0xffff) + 1;
  h.writeUInt16BE(tid, 0); h.writeUInt16BE(0x0993, 2); h.writeUInt16BE(payload.length + 2, 4); h[6] = 1; h[7] = fc;
  return [tid, Buffer.concat([h, payload])];
}
function heartbeat() {
  const n = new Date();
  return ey(1, Buffer.from([n.getUTCFullYear() - 2000, n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds(), 0, 30]))[1];
}

const pending = new Map();
const udp = dgram.createSocket('udp4');
const announce = () => udp.send(`set>server=${HOST_IP}:8899;`, 58899, DONGLE_IP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(s, fc, reg, n) {
  const [t, f] = ey(4, readReq(fc, reg, n));
  return new Promise((res) => {
    const to = setTimeout(() => { pending.delete(t); res(null); }, 2500);
    pending.set(t, (p) => { clearTimeout(to); res(p); });
    s.write(f);
  });
}

const results = {};
const server = net.createServer(async (s) => {
  console.log('dongle connected from', s.remoteAddress);
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const total = buf.readUInt16BE(4) + 6; if (buf.length < total) break;
      const f = buf.subarray(0, total); buf = buf.subarray(total);
      const w = pending.get(f.readUInt16BE(0)); if (w) { pending.delete(f.readUInt16BE(0)); w(f.subarray(8)); }
    }
  });
  s.write(heartbeat()); await sleep(1500);
  const blocks = [];
  for (const fc of [3, 4]) for (let r = 0; r < 0x0500; r += 16) blocks.push([fc, r]);
  // decimal-addressed maps (SMG-II style) live around 100..700
  for (let r = 100; r < 700; r += 10) blocks.push([3, r]);
  for (const [fc, reg] of blocks) {
    const p = await request(s, fc, reg, fc === 3 && reg >= 100 && reg < 700 && reg % 16 ? 10 : 16);
    if (p && p.length >= 5 && p[1] === fc) {
      const regs = []; for (let i = 0; i < p[2] / 2; i++) regs.push(p.readUInt16BE(3 + i * 2));
      results[`fc${fc}:${reg}`] = regs;
      console.log(`FC${fc} ${String(reg).padStart(4)} (0x${reg.toString(16).padStart(4, '0')}):`, regs.join(' '));
    } else if (p && p.length >= 3 && p[1] === (fc | 0x80)) {
      results[`fc${fc}:${reg}`] = `exception ${p[2]}`;
    }
    await sleep(120);
  }
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  console.log('saved', outFile, Object.keys(results).length, 'blocks');
  s.destroy(); server.close(); udp.close(); process.exit(0);
});
server.listen(8899, '0.0.0.0', () => udp.bind(() => { announce(); setInterval(announce, 15000); }));
setTimeout(() => { console.log('timeout'); fs.writeFileSync(outFile, JSON.stringify(results, null, 1)); process.exit(1); }, 420000);
