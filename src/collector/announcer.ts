// Points the Eybond dongle at our TCP server via UDP 58899 "set>server=IP:PORT;".
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

export const DONGLE_UDP_PORT = 58899;

export interface AnnouncerOptions {
  hostIp: string;
  tcpPort: number;
  /** Subnet broadcast, e.g. 192.168.0.255 (worked in Phase 0; unicast hit EHOSTUNREACH). */
  broadcast: string;
  /** Optional unicast target as well. */
  dongleIp?: string;
}

export class Announcer extends EventEmitter<{ reply: [msg: string, from: string]; error: [Error] }> {
  #sock = dgram.createSocket('udp4');
  #ready: Promise<void>;
  readonly opts: AnnouncerOptions;

  constructor(opts: AnnouncerOptions) {
    super();
    this.opts = opts;
    this.#sock.on('message', (m, r) => this.emit('reply', m.toString('latin1').trim(), r.address));
    this.#sock.on('error', (e) => this.emit('error', e));
    this.#ready = new Promise((res) => this.#sock.bind(() => { this.#sock.setBroadcast(true); res(); }));
  }

  get command(): string {
    return `set>server=${this.opts.hostIp}:${this.opts.tcpPort};`;
  }

  async announce(): Promise<void> {
    await this.#ready;
    // Send to ONE target: each set>server the dongle receives makes it reconnect.
    // Unicast when the dongle IP is known, falling back to broadcast if unicast fails.
    const send = (ip: string, onErr: (e: Error) => void) =>
      this.#sock.send(this.command, DONGLE_UDP_PORT, ip, (err) => { if (err) onErr(err); });
    const toBroadcast = () => send(this.opts.broadcast, (e) => this.emit('error', e));
    if (this.opts.dongleIp) send(this.opts.dongleIp, toBroadcast);
    else toBroadcast();
  }

  close(): void {
    this.#sock.close();
  }
}
