// TCP server the dongle dials into. Owns exactly one dongle connection at a time and
// exposes a serialized request() for Modbus payloads (the RS485 bus is half-duplex).
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_DEVCODE, FC_FORWARD, FC_HEARTBEAT, FrameDecoder, encodeFrame, heartbeatPayload,
  type EybondFrame,
} from '../protocol/eybond.ts';

export interface CollectorOptions {
  port: number;
  host?: string;
  requestTimeoutMs?: number;
  /** Gap between consecutive bus requests. */
  interRequestGapMs?: number;
  heartbeatSec?: number;
  devcode?: number;
}

type Events = {
  connected: [remote: string];
  disconnected: [reason: string];
  pn: [pn: string];
  frame: [dir: 'rx' | 'tx', frame: EybondFrame];
  error: [Error];
};

interface Pending { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class NotConnectedError extends Error {}
export class TimeoutError extends Error {}

export class CollectorServer extends EventEmitter<Events> {
  readonly opts: Required<CollectorOptions>;
  #server: net.Server;
  #sock: net.Socket | null = null;
  #tid = 0;
  #pending = new Map<number, Pending>();
  #queue: Promise<unknown> = Promise.resolve();
  #heartbeat: NodeJS.Timeout | null = null;
  pn = '';
  lastRx = 0;

  constructor(opts: CollectorOptions) {
    super();
    this.opts = {
      host: '0.0.0.0', requestTimeoutMs: 4000, interRequestGapMs: 120, heartbeatSec: 30,
      devcode: DEFAULT_DEVCODE, ...opts,
    };
    this.#server = net.createServer((s) => this.#accept(s));
    this.#server.on('error', (e) => this.emit('error', e));
  }

  get connected(): boolean {
    return !!this.#sock && !this.#sock.destroyed;
  }

  listen(): Promise<void> {
    return new Promise((res, rej) => {
      this.#server.once('error', rej);
      this.#server.listen(this.opts.port, this.opts.host, () => { this.#server.off('error', rej); res(); });
    });
  }

  #accept(s: net.Socket): void {
    const remote = `${s.remoteAddress}:${s.remotePort}`;
    if (this.#sock) this.#drop('replaced by new connection');
    this.#sock = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10_000);
    const decoder = new FrameDecoder();
    s.on('data', (chunk) => {
      this.lastRx = Date.now();
      let frames: EybondFrame[];
      try { frames = decoder.push(chunk); } catch (e) { this.emit('error', e as Error); this.#drop('corrupt stream'); return; }
      for (const f of frames) this.#onFrame(f);
    });
    s.on('close', () => { if (this.#sock === s) this.#drop('socket closed'); });
    s.on('error', (e) => this.emit('error', e));
    this.emit('connected', remote);
    this.#sendHeartbeat();
    this.#heartbeat = setInterval(() => this.#sendHeartbeat(), this.opts.heartbeatSec * 1000);
  }

  #drop(reason: string): void {
    const s = this.#sock;
    if (!s) return;
    this.#sock = null;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    s.destroy();
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(new NotConnectedError(reason)); }
    this.#pending.clear();
    this.emit('disconnected', reason);
  }

  /** Close the current dongle socket (e.g. watchdog). The dongle will dial back after a re-announce. */
  disconnect(reason = 'requested'): void {
    this.#drop(reason);
  }

  #nextTid(): number {
    this.#tid = (this.#tid % 0xffff) + 1;
    return this.#tid;
  }

  #write(f: EybondFrame): void {
    if (!this.#sock) throw new NotConnectedError('dongle not connected');
    this.emit('frame', 'tx', f);
    this.#sock.write(encodeFrame(f));
  }

  #sendHeartbeat(): void {
    try {
      this.#write({ tid: this.#nextTid(), devcode: 0, addr: 1, fc: FC_HEARTBEAT, payload: heartbeatPayload(new Date(), this.opts.heartbeatSec) });
    } catch { /* not connected */ }
  }

  #onFrame(f: EybondFrame): void {
    this.emit('frame', 'rx', f);
    if (f.fc === FC_HEARTBEAT) {
      const pn = f.payload.toString('latin1').replace(/\0/g, '').trim();
      if (pn && pn !== this.pn) { this.pn = pn; this.emit('pn', pn); }
      return;
    }
    if (f.fc === FC_FORWARD) {
      const p = this.#pending.get(f.tid);
      if (p) { this.#pending.delete(f.tid); clearTimeout(p.timer); p.resolve(f.payload); }
    }
  }

  /** Forward a raw device payload (Modbus RTU frame) and resolve with the device's reply payload. Serialized. */
  request(payload: Buffer): Promise<Buffer> {
    const run = async () => {
      const tid = this.#nextTid();
      const reply = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => { this.#pending.delete(tid); reject(new TimeoutError(`no reply for TID ${tid}`)); }, this.opts.requestTimeoutMs);
        this.#pending.set(tid, { resolve, reject, timer });
      });
      try {
        this.#write({ tid, devcode: this.opts.devcode, addr: 1, fc: FC_FORWARD, payload });
      } catch (e) {
        const p = this.#pending.get(tid);
        if (p) { clearTimeout(p.timer); this.#pending.delete(tid); }
        throw e;
      }
      try { return await reply; } finally { await sleep(this.opts.interRequestGapMs); }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.#drop('shutdown');
    await new Promise<void>((res) => this.#server.close(() => res()));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
