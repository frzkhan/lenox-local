// REST + WebSocket API.
//   GET /api/live                 latest snapshot (503 until the first one)
//   GET /api/status               dongle connection, PN, storage stats
//   GET /api/history?range=6h     downsampled series (1h|6h|24h|7d|30d|365d)
//   GET /api/energy/daily?days=30 inverter day counters per date
//   WS  /ws/live                  pushes {type:'snapshot'|'status', data}
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { isRange, type Store } from '../store/db.ts';
import type { Snapshot } from '../registers/deye-1p.ts';

const require = createRequire(import.meta.url);

export interface Status {
  dongleConnected: boolean;
  /** False when the dongle is connected but the inverter stopped answering Modbus reads. */
  inverterResponding: boolean;
  donglePn: string;
  lastRxAgoSec: number | null;
  lastSnapshotAt: string | null;
  startedAt: string;
}

/** What the API needs from the running collector (keeps the API testable without a dongle). */
export interface LiveSource extends EventEmitter<{ snapshot: [Snapshot]; status: [Status] }> {
  latest(): Snapshot | null;
  status(): Status;
}

export async function buildApi(store: Store, live: LiveSource, opts: { logger?: boolean; webRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);
  if (opts.webRoot) {
    await app.register(fastifyStatic, { root: opts.webRoot });
    // uPlot served from node_modules so the dashboard works without internet
    await app.register(fastifyStatic, { root: path.join(path.dirname(require.resolve('uplot')), '..', 'dist'), prefix: '/vendor/uplot/', decorateReply: false });
  }

  app.get('/api/live', async (_req, reply) => {
    const s = live.latest();
    if (!s) return reply.code(503).send({ error: 'no data yet', status: live.status() });
    return s;
  });

  app.get('/api/status', async () => ({ ...live.status(), storage: store.stats() }));

  app.get<{ Querystring: { range?: string } }>('/api/history', async (req, reply) => {
    const range = req.query.range ?? '6h';
    if (!isRange(range)) return reply.code(400).send({ error: 'range must be one of 1h,6h,24h,7d,30d,365d' });
    return store.history(range);
  });

  app.get<{ Querystring: { days?: string } }>('/api/energy/daily', async (req, reply) => {
    const days = Number(req.query.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 3660) return reply.code(400).send({ error: 'days must be 1..3660' });
    return { days: store.daily(days) };
  });

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const onSnap = (s: Snapshot) => broadcast({ type: 'snapshot', data: s });
  const onStatus = (s: Status) => broadcast({ type: 'status', data: s });
  live.on('snapshot', onSnap);
  live.on('status', onStatus);
  app.addHook('onClose', async () => { live.off('snapshot', onSnap); live.off('status', onStatus); });

  app.get('/ws/live', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'status', data: live.status() }));
    const s = live.latest();
    if (s) socket.send(JSON.stringify({ type: 'snapshot', data: s }));
    socket.on('close', () => clients.delete(socket));
  });

  return app;
}
