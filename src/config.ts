import os from 'node:os';

function primaryIPv4(): { address: string; netmask: string } {
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(os.networkInterfaces())]) {
    const a = os.networkInterfaces()[name]?.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a;
  }
  return { address: '127.0.0.1', netmask: '255.0.0.0' };
}

function broadcastOf(ip: string, mask: string): string {
  const i = ip.split('.').map(Number), m = mask.split('.').map(Number);
  return i.map((o, k) => (o & m[k]) | (~m[k] & 0xff)).join('.');
}

const net = primaryIPv4();
const env = process.env;

export const config = {
  hostIp: env.HOST_IP ?? net.address,
  broadcast: env.BROADCAST_IP ?? broadcastOf(net.address, net.netmask),
  dongleIp: env.DONGLE_IP || undefined,
  tcpPort: Number(env.COLLECTOR_PORT ?? 8899),
  pollMs: Number(env.POLL_MS ?? 2000),
  keepaliveMs: Number(env.KEEPALIVE_MS ?? 0),
  debugFrames: env.DEBUG_FRAMES === '1',
  webPort: Number(env.WEB_PORT ?? 8080),
  dbPath: env.DB_PATH ?? 'data/lenox.db',
};
