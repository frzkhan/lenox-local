// Glues collector + poller into the LiveSource the API consumes.
import { EventEmitter } from 'node:events';
import type { CollectorServer } from './collector/server.ts';
import type { Poller } from './poller.ts';
import type { Snapshot } from './registers/deye-1p.ts';
import type { LiveSource, Status } from './api/http.ts';

export class CollectorLive extends EventEmitter<{ snapshot: [Snapshot]; status: [Status] }> implements LiveSource {
  #collector: CollectorServer;
  #poller: Poller;
  #startedAt = new Date().toISOString();

  constructor(collector: CollectorServer, poller: Poller) {
    super();
    this.#collector = collector;
    this.#poller = poller;
    poller.on('snapshot', (s) => this.emit('snapshot', s));
    const pushStatus = () => this.emit('status', this.status());
    collector.on('connected', pushStatus);
    collector.on('disconnected', pushStatus);
    collector.on('pn', pushStatus);
    poller.on('responding', pushStatus);
  }

  latest(): Snapshot | null {
    return this.#poller.lastSnapshot;
  }

  status(): Status {
    const c = this.#collector;
    return {
      dongleConnected: c.connected,
      inverterResponding: this.#poller.inverterResponding,
      donglePn: c.pn,
      lastRxAgoSec: c.lastRx ? Math.round((Date.now() - c.lastRx) / 1000) : null,
      lastSnapshotAt: this.#poller.lastSnapshot?.time ?? null,
      startedAt: this.#startedAt,
    };
  }
}
