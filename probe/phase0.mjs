#!/usr/bin/env node
// Phase 0 probe: READ-ONLY.
// Redirects the Eybond dongle to this machine (temporary, reverts to cloud on its own),
// logs every frame, and sends only query commands to the inverter.
//
// Usage: node probe/phase0.mjs [dongleIp] [hostIp] [seconds]

import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DONGLE_IP = process.argv[2] || '192.168.0.100';
const HOST_IP = process.argv[3] || guessHostIp();
const RUN_SECONDS = Number(process.argv[4] || 120);
const TCP_PORT = 8899;
const UDP_PORT = 58899;

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'captures');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = (type, data) => {
  const rec = { t: new Date().toISOString(), type, ...data };
  fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
  console.log(`[${rec.t.slice(11, 23)}] ${type}`, JSON.stringify(data));
};

function guessHostIp() {
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

// ---------- PI30 / PI17 helpers ----------
function crc16xmodem(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
const esc = (v) => ([0x28, 0x0d, 0x0a].includes(v) ? v + 1 : v);
function pi30Frame(cmd) {
  const p = Buffer.from(cmd, 'ascii');
  const c = crc16xmodem(p);
  return Buffer.concat([p, Buffer.from([esc(c >> 8), esc(c & 0xff), 0x0d])]);
}
function modbusRead(addr, reg, count, fc = 3) {
  const b = Buffer.from([addr, fc, reg >> 8, reg & 0xff, count >> 8, count & 0xff]);
  let crc = 0xffff;
  for (const x of b) { crc ^= x; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; }
  return Buffer.concat([b, Buffer.from([crc & 0xff, crc >> 8])]);
}

// SAFETY: only query commands may ever leave this script.
function assertReadOnly(kind, payload) {
  if (kind === 'pi30' && /^Q[A-Z0-9]+$/.test(payload.subarray(0, -3).toString('latin1'))) return;
  if (kind === 'pi17' && payload.toString('ascii').startsWith('^P')) return;
  if (kind === 'modbus' && (payload[1] === 3 || payload[1] === 4)) return;
  throw new Error(`Refusing to send non-read command: ${kind} ${payload.toString('hex')}`);
}

// ---------- Eybond framing ----------
const HDR = 8;
let tid = 0;
const nextTid = () => (tid = (tid % 0xffff) + 1);
function eyFrame(t, devcode, devaddr, fc, payload) {
  const h = Buffer.alloc(HDR);
  h.writeUInt16BE(t, 0); h.writeUInt16BE(devcode, 2);
  h.writeUInt16BE(HDR + payload.length - 6, 4);
  h.writeUInt8(devaddr, 6); h.writeUInt8(fc, 7);
  return Buffer.concat([h, payload]);
}
function heartbeat() {
  const n = new Date();
  const p = Buffer.from([n.getUTCFullYear() - 2000, n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds(), 0, 30]);
  return eyFrame(nextTid(), 0, 1, 1, p);
}

// ---------- UDP redirect ----------
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, r) => log('udp_rx', { from: `${r.address}:${r.port}`, ascii: msg.toString('latin1'), hex: msg.toString('hex') }));
udp.on('error', (e) => log('udp_error', { msg: e.message }));
function announce() {
  const cmd = Buffer.from(`set>server=${HOST_IP}:${TCP_PORT};`, 'ascii');
  const targets = [DONGLE_IP, '255.255.255.255', HOST_IP.replace(/\.\d+$/, '.255')];
  for (const ip of targets) udp.send(cmd, UDP_PORT, ip, (e) => log('udp_tx', { to: ip, cmd: cmd.toString(), err: e?.message }));
}

// ---------- TCP collector ----------
let devcodeSeen = null;
let sock = null;
const pending = new Map();

const server = net.createServer((s) => {
  log('tcp_connect', { from: `${s.remoteAddress}:${s.remotePort}` });
  if (sock) sock.destroy();
  sock = s;
  s.setKeepAlive(true, 10000);
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    log('tcp_raw', { hex: d.toString('hex') });
    buf = Buffer.concat([buf, d]);
    while (buf.length >= HDR) {
      const total = buf.readUInt16BE(4) + 6;
      if (total < HDR || total > 4096) { log('frame_garbage', { hex: buf.toString('hex') }); buf = Buffer.alloc(0); break; }
      if (buf.length < total) break;
      const f = buf.subarray(0, total); buf = buf.subarray(total);
      const fr = { tid: f.readUInt16BE(0), devcode: f.readUInt16BE(2), addr: f[6], fc: f[7], payload: f.subarray(HDR) };
      log('frame', { tid: fr.tid, devcode: '0x' + fr.devcode.toString(16), addr: fr.addr, fc: fr.fc, hex: fr.payload.toString('hex'), ascii: fr.payload.toString('latin1').replace(/[^\x20-\x7e]/g, '.') });
      if (fr.devcode) devcodeSeen = fr.devcode;
      const w = pending.get(fr.tid);
      if (w) { pending.delete(fr.tid); w(fr); }
    }
  });
  s.on('close', () => { log('tcp_close', {}); if (sock === s) sock = null; });
  s.on('error', (e) => log('tcp_error', { msg: e.message }));
  runQueries(s).catch((e) => log('query_error', { msg: e.message }));
});

function request(s, devcode, kind, payload, label, timeoutMs = 4000) {
  assertReadOnly(kind, payload);
  const t = nextTid();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(t); log('timeout', { label }); resolve(null); }, timeoutMs);
    pending.set(t, (fr) => { clearTimeout(timer); resolve(fr); });
    const f = eyFrame(t, devcode, 1, 4, payload);
    log('tx', { label, kind, devcode: '0x' + devcode.toString(16), hex: f.toString('hex') });
    s.write(f);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQueries(s) {
  const hb = heartbeat();
  log('tx', { label: 'heartbeat', hex: hb.toString('hex') });
  s.write(hb);
  await sleep(2000);

  const codes = [...new Set([devcodeSeen, 0x0993, 0x0994].filter(Boolean))];
  let ok = false;
  for (const dc of codes) {
    for (const q of ['QPI', 'QMOD', 'QPIGS', 'QPIRI', 'QPIWS', 'QFLAG', 'QID', 'QVFW', 'QPIGS2']) {
      const r = await request(s, dc, 'pi30', pi30Frame(q), `PI30 ${q} @0x${dc.toString(16)}`);
      if (r && r.payload[0] === 0x28) ok = true;
      await sleep(250);
    }
    if (ok) break;
  }
  if (!ok) {
    for (const dc of codes) {
      for (const q of ['^P005PI', '^P005GS', '^P006MOD']) {
        const body = Buffer.from(q, 'ascii');
        const c = crc16xmodem(body);
        await request(s, dc, 'pi17', Buffer.concat([body, Buffer.from([esc(c >> 8), esc(c & 0xff), 0x0d])]), `PI17 ${q} @0x${dc.toString(16)}`);
        await sleep(250);
      }
      await request(s, dc, 'modbus', modbusRead(1, 0x0100, 10), `Modbus FC3 0x0100 x10 @0x${dc.toString(16)}`);
      await request(s, dc, 'modbus', modbusRead(1, 0x0000, 10, 4), `Modbus FC4 0x0000 x10 @0x${dc.toString(16)}`);
    }
  }
  log('queries_done', { pi30: ok });
  // keep polling QPIGS to measure latency/stability while time remains
  while (ok && sock === s && !s.destroyed) {
    const t0 = Date.now();
    const r = await request(s, codes[0], 'pi30', pi30Frame('QPIGS'), 'QPIGS poll');
    if (r) log('latency', { ms: Date.now() - t0 });
    await sleep(2000);
  }
}

server.listen(TCP_PORT, '0.0.0.0', () => {
  log('start', { dongle: DONGLE_IP, host: HOST_IP, tcp: TCP_PORT, seconds: RUN_SECONDS, logFile });
  udp.bind(() => { udp.setBroadcast(true); announce(); });
});
const reAnnounce = setInterval(() => { if (!sock) announce(); }, 10000);
setTimeout(() => {
  log('stop', { note: 'exiting; dongle falls back to cloud by itself' });
  clearInterval(reAnnounce); sock?.destroy(); server.close(); udp.close(); process.exit(0);
}, RUN_SECONDS * 1000);
