# Scaling the backend

The local development setup runs everything in one process. This document
describes how each piece scales out, and what to change.

---

## Current shape

```
Fastify API ──► RunQueue (in-process, concurrency 4) ──► executeRun() ──► Postgres
     │                                                                       ▲
     └── SSE progress ◄── ProgressBus (EventEmitter) ────────────────────────┘
```

This is correct for a single node and for the whole of a small engagement. Every
seam that needs to change for horizontal scale is already an interface.

---

## 1. Move the queue to Redis (BullMQ)

**Why.** The in-process queue is bounded by `MAX_QUEUE_DEPTH` and lives in one
process's memory. Two API replicas would each have their own queue and their own
concurrency budget, so the effective concurrency doubles silently.

**What to change.** `RunQueue` in `apps/api/src/server.ts` has a deliberately
narrow surface — `enqueue(task): boolean` and a `depth` getter. Replace it with:

```ts
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL!);

const runQueue = new Queue('runs', { connection });

// API side
await runQueue.add('run', { runId }, {
  attempts: 1,                 // a pentest run is not idempotent; never auto-retry
  removeOnComplete: 500,
});

// Worker side (separate deployment, scale by adding replicas)
new Worker('runs', async (job) => {
  const run = await getRun(job.data.runId);
  if (!run) return;
  await executeRun({ run, store: runStore, bus, limits: config.limits });
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
```

The worker process needs no HTTP surface. `executeRun` is already pure with
respect to transport: it takes a `RunStore`, a `ProgressBus` and a `RunRecord`.

**Cancellation across processes.** `activeRuns` is a local `Map`. With a
distributed queue, publish a `cancel` message on a Redis pub/sub channel and have
the worker holding that run abort its controller. The route already returns 409
when it cannot find a local controller, so behaviour degrades honestly rather
than silently pretending to cancel.

---

## 2. Fan out the SSE progress bus

`ProgressBus` extends `EventEmitter`, which is per-process. Once runs execute on
worker nodes, a client connected to API replica A will never see progress
emitted on worker B.

**Fix.** Back the bus with Redis pub/sub:

```ts
class RedisProgressBus extends ProgressBus {
  publish(p: RunProgress) {
    void pub.publish(`run:${p.runId}`, JSON.stringify(p));
  }
  subscribe(runId: string, listener: (p: RunProgress) => void) {
    const sub = subClient.duplicate();
    void sub.subscribe(`run:${runId}`);
    sub.on('message', (_ch, msg) => listener(JSON.parse(msg)));
    return () => void sub.unsubscribe(`run:${runId}`);
  }
}
```

The SSE route (`/api/runs/:id/stream`) is unchanged — it already only depends on
`subscribe`.

---

## 3. Partition `request_traces`

This is the only table that grows without bound. A single 1000-request spike
writes 1000 rows; a full Run-All writes roughly 1200–2500. At a few hundred runs
a month that is tens of millions of rows.

```sql
-- Convert to a range-partitioned table on created_at.
CREATE TABLE request_traces (
  ...
) PARTITION BY RANGE (created_at);

CREATE TABLE request_traces_2026_09
  PARTITION OF request_traces
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

Then automate:

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman;
SELECT partman.create_parent(
  p_parent_table => 'public.request_traces',
  p_control      => 'created_at',
  p_interval     => '1 month',
  p_premake      => 3
);
```

Retention becomes a `DROP TABLE` on an old partition rather than a `DELETE` that
bloats the heap. Indexes are defined on the parent and inherited.

**Batching already exists.** `insertTraces` writes up to 1000 rows per statement
(chunked to stay under the 65535-parameter limit) and the runner flushes every
250 ms. No change needed.

---

## 4. Run workers close to the target

Latency measurements are only meaningful if the executor is not fighting its own
network path. For an EdgeOne engagement, run workers in the region under test.
`TimingBreakdown` already separates DNS, TCP, TLS and first-byte so you can see
where the time actually went rather than guessing.

---

## 5. Read replicas for history

`GET /api/history`, `GET /api/runs/:id/traces` and `POST /api/export` are pure
reads and dominate query volume once a few hundred runs exist. Point them at a
streaming replica via a second pool. Writes (`createRun`, `insertTraces`,
`markFinished`) stay on the primary.

---

## 6. Connection pooling

`PG_POOL_MAX` defaults to 20 per process. With N API replicas plus M workers,
size it so `(N + M) × PG_POOL_MAX` stays below the Postgres `max_connections`
budget, or put PgBouncer in transaction mode in front. Note that `withTransaction`
in `db/pool.ts` takes a dedicated client — that is compatible with transaction
pooling, but not with statement pooling.

---

## Operational notes

**Run provenance is immutable.** `runs.provenance` is written once at creation
and never updated. It carries the operator, device, source IP and a SHA-256 of
the canonicalised config set, so any run in the database can be traced back to a
specific operator and an exact parameter set.

**Never auto-retry a run.** `executeRun` emits real network traffic. A retry
re-attacks the target. BullMQ's `attempts` must stay at 1.

**Backpressure is honest.** Three independent ceilings apply: a per-run request
budget, a global per-run ceiling, and a queue depth limit that returns HTTP 503
rather than silently queueing without bound.

**Health endpoint.** `GET /api/health` reports `queueDepth` and `activeRuns` —
wire these to your orchestrator's readiness probe so a saturated node stops
receiving new runs.
