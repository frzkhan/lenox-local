// Polls register blocks through the collector, keeps a register cache, emits decoded snapshots,
// and keeps the dongle pointed at us (announce while disconnected, watchdog on repeated failures).
import { EventEmitter } from 'node:events';
import { buildReadHolding, parseReadResponse } from './protocol/modbus.ts';
import { BLOCKS, decode, MissingRegisterError, type Snapshot } from './registers/deye-1p.ts';
import type { CollectorServer } from './collector/server.ts';
import type { Announcer } from './collector/announcer.ts';

export interface PollerOptions {
  slave?: number;
  fastIntervalMs?: number;
  slowIntervalMs?: number;
  /** Re-announce interval while disconnected. */
  announceIntervalMs?: number;
  /** Optional re-announce while connected (0 = off; persistence of the redirect is still untested). */
  keepaliveMs?: number;
  /** Consecutive failed cycles before acting (reconnect if the dongle is silent, back off if the inverter is). */
  maxFailedCycles?: number;
  /** While the inverter isn't answering, try one tiny read this often. */
  silentProbeMs?: number;
}

type Events = {
  snapshot: [Snapshot];
  status: [string];
  responding: [boolean];
  readError: [block: { start: number; count: number }, reason: string];
};

export class Poller extends EventEmitter<Events> {
  readonly cache = new Map<number, number>();
  readonly opts: Required<PollerOptions>;
  #collector: CollectorServer;
  #announcer: Announcer;
  #running = false;
  #lastSlow = 0;
  #failedCycles = 0;
  #linkFailures = 0;
  #lastProbe = 0;
  #timers: NodeJS.Timeout[] = [];
  lastSnapshot: Snapshot | null = null;
  lastGoodReadAt = 0;
  inverterResponding = true;

  constructor(collector: CollectorServer, announcer: Announcer, opts: PollerOptions = {}) {
    super();
    this.#collector = collector;
    this.#announcer = announcer;
    this.opts = {
      slave: 1, fastIntervalMs: 2000, slowIntervalMs: 60_000, announceIntervalMs: 10_000,
      keepaliveMs: 0, maxFailedCycles: 3, silentProbeMs: 20_000, ...opts,
    };
  }

  start(): void {
    this.#running = true;
    this.#collector.on('connected', () => { this.#lastSlow = 0; this.#failedCycles = 0; this.#linkFailures = 0; });
    void this.#announcer.announce();
    this.#timers.push(setInterval(() => {
      if (!this.#collector.connected) { this.emit('status', 'waiting for dongle, re-announcing'); void this.#announcer.announce(); }
    }, this.opts.announceIntervalMs));
    if (this.opts.keepaliveMs > 0)
      this.#timers.push(setInterval(() => { if (this.#collector.connected) void this.#announcer.announce(); }, this.opts.keepaliveMs));
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  /**
   * 'ok' = registers cached; 'silent' = the dongle answered but the inverter didn't (empty FC4 / garbled);
   * 'link' = no frame from the dongle at all (timeout / disconnected).
   */
  async readBlock(start: number, count: number): Promise<'ok' | 'silent' | 'link'> {
    let raw: Buffer;
    try {
      raw = await this.#collector.request(buildReadHolding(this.opts.slave, start, count));
    } catch (e) {
      this.emit('readError', { start, count }, (e as Error).message);
      return 'link';
    }
    const res = parseReadResponse(raw, this.opts.slave, count);
    if (res.kind !== 'ok') {
      this.emit('readError', { start, count }, res.kind === 'exception' ? `exception ${res.code}` : res.kind === 'invalid' ? res.reason : 'inverter did not answer');
      return 'silent';
    }
    res.registers.forEach((v, i) => this.cache.set(start + i, v));
    return 'ok';
  }

  #setResponding(v: boolean): void {
    if (v === this.inverterResponding) return;
    this.inverterResponding = v;
    this.emit('status', v ? 'inverter answering again' : `inverter not answering; probing every ${this.opts.silentProbeMs / 1000}s`);
    this.emit('responding', v);
  }

  async #cycle(): Promise<void> {
    // While the inverter is silent, don't hammer the bus: one tiny read per silentProbeMs.
    if (!this.inverterResponding) {
      if (Date.now() - this.#lastProbe < this.opts.silentProbeMs) return;
      this.#lastProbe = Date.now();
      const r = await this.readBlock(184, 1);
      if (r === 'ok') { this.#setResponding(true); this.#lastSlow = 0; }
      else if (r === 'link') this.#linkFailure();
      return;
    }

    const blocks = [...BLOCKS.fast];
    const slowDue = Date.now() - this.#lastSlow >= this.opts.slowIntervalMs;
    if (slowDue) blocks.push(...BLOCKS.slow);
    let ok = 0, silent = 0;
    for (const b of blocks) {
      const r = await this.readBlock(b.start, b.count);
      if (r === 'ok') ok++;
      else if (r === 'silent') silent++;
    }
    if (slowDue && ok === blocks.length) this.#lastSlow = Date.now();
    if (ok === 0) {
      if (silent > 0) {
        // The dongle link is fine; reconnecting doesn't help a silent inverter.
        if (++this.#failedCycles >= this.opts.maxFailedCycles) { this.#failedCycles = 0; this.#lastProbe = Date.now(); this.#setResponding(false); }
      } else {
        this.#linkFailure();
      }
      return;
    }
    this.#failedCycles = 0;
    this.lastGoodReadAt = Date.now();
    try {
      this.lastSnapshot = decode(this.cache);
      this.emit('snapshot', this.lastSnapshot);
    } catch (e) {
      if (!(e instanceof MissingRegisterError)) throw e;
      this.emit('status', `incomplete data: ${e.message}`);
    }
  }

  #linkFailure(): void {
    if (++this.#linkFailures >= this.opts.maxFailedCycles) {
      this.emit('status', `watchdog: dongle not replying, reconnecting`);
      this.#linkFailures = 0;
      this.#collector.disconnect('watchdog');
      void this.#announcer.announce();
    }
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const t0 = Date.now();
      if (this.#collector.connected) {
        try { await this.#cycle(); } catch (e) { this.emit('status', `cycle error: ${(e as Error).message}`); }
      }
      await new Promise((r) => setTimeout(r, Math.max(200, this.opts.fastIntervalMs - (Date.now() - t0))));
    }
  }
}
