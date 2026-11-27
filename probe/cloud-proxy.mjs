#!/usr/bin/env node
// Transparent logging relay: dongle -> this host -> real Eybond cloud, both directions unchanged.
// Usage: node probe/cloud-proxy.mjs [dongleIp] [hostIp] [seconds]
import net from 'node:net'; import dgram from 'node:dgram'; import fs from 'node:fs'; import path from 'node:path';
const [DONGLE = '192.168.0.101', HOST = '192.168.0.102', SECS = '180'] = process.argv.slice(2);
const UP_HOST = 'iot.eybond.com', UP_PORT = 18899; // from AT+CLDSRVHOST1?
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'captures', `cloud-proxy-${Date.now()}.jsonl`);
const log = (dir, d) => {
  const rec = { t: new Date().toISOString(), dir, hex: d.toString('hex'), ascii: d.toString('latin1').replace(/[^\x20-\x7e]/g, '.') };
  fs.appendFileSync(out, JSON.stringify(rec) + '\n');
  console.log(rec.t.slice(11, 23), dir.padEnd(14), rec.hex.slice(0, 120), rec.ascii.slice(0, 60));
};
const srv = net.createServer((dongle) => {
  log('dongle-connect', Buffer.from(dongle.remoteAddress));
  const cloud = net.connect(UP_PORT, UP_HOST, () => log('cloud-connect', Buffer.from(UP_HOST)));
  dongle.on('data', (d) => { log('dongle->cloud', d); cloud.write(d); });
  cloud.on('data', (d) => { log('cloud->dongle', d); dongle.write(d); });
  const end = (who) => () => { log(`${who}-close`, Buffer.alloc(0)); dongle.destroy(); cloud.destroy(); };
  dongle.on('close', end('dongle')); cloud.on('close', end('cloud'));
  dongle.on('error', () => {}); cloud.on('error', (e) => log('cloud-error', Buffer.from(e.message)));
});
const u = dgram.createSocket('udp4');
srv.listen(8899, () => u.send(`set>server=${HOST}:8899;`, 58899, DONGLE));
setTimeout(() => { console.log('saved', out); process.exit(0); }, Number(SECS) * 1000);
