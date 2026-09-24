import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import {
  effectiveRps,
  makePacer,
  runPool,
  sleep,
} from '../src/engine/executors/context.ts';

/**
 * Regression tests for the load-test concurrency primitives.
 *
 * These cover three bugs that were all silent — the run completed and reported
 * success while doing something other than what was configured or recorded:
 *
 *   1. `runPool` siblings kept claiming work after one worker threw, so the
 *      target took the full attack while the evidence held almost none of it.
 *   2. `sleep` left its abort listener attached on every call, growing one
 *      listener per sleep on a run-long signal.
 *   3. Dispatch pacing was per worker, which multiplied the real request rate
 *      by the worker count and made the server's `maxRps` ceiling unenforceable.
 */

describe('runPool', () => {
  it('runs every item when nothing throws', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(Array.from({ length: 40 }), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(1);
      inFlight -= 1;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  });

  it('stops claiming new items once a worker throws', async () => {
    const attempted: number[] = [];
    await assert.rejects(
      () =>
        runPool(
          Array.from({ length: 100 }, (_, i) => i),
          1,
          async (item) => {
            attempted.push(item);
            if (item === 3) throw new Error('boom');
          },
        ),
      /boom/,
    );

    // With one worker the blow-up is deterministic: items 0..3 only. The bug
    // this guards is the multi-worker case below, where siblings used to keep
    // draining the list.
    assert.deepEqual(attempted, [0, 1, 2, 3]);
  });

  it('does not let sibling workers drain the list after a failure', async () => {
    const attempted: number[] = [];
    await assert.rejects(
      () =>
        runPool(
          Array.from({ length: 500 }, (_, i) => i),
          5,
          async (item) => {
            attempted.push(item);
            // The first item fails immediately. Under the old implementation
            // `Promise.all` rejected at once and the caller moved on — but the
            // four sibling workers were still looping in the background and
            // went on to dispatch the remaining ~495 requests at the target.
            if (item === 0) throw new Error('first item failed');
            await sleep(5);
          },
        ),
      /first item failed/,
    );

    const atRejection = attempted.length;
    // Give the stragglers time to reveal themselves. This is the assertion that
    // matters: it is not enough for the pool to *reject* early, it must also
    // stop attacking.
    await sleep(300);

    assert.ok(
      attempted.length <= 10,
      `expected the pool to stop early, but it dispatched ${attempted.length} items (${atRejection} at rejection)`,
    );
  });

  it('waits for in-flight items before rethrowing', async () => {
    let finished = 0;
    await assert.rejects(
      () =>
        runPool([0, 1, 2, 3], 2, async (item) => {
          if (item === 0) throw new Error('early failure');
          await sleep(30);
          finished += 1;
        }),
      /early failure/,
    );
    // The rejection must not surface while a probe is still writing evidence.
    assert.equal(finished, 1);
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    let count = 0;
    await runPool(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      async () => {
        count += 1;
        if (count === 3) controller.abort();
        await sleep(1);
      },
      controller.signal,
    );
    assert.ok(count < 100, `expected early exit, ran ${count} items`);
  });
});

describe('sleep', () => {
  it('resolves after roughly the requested delay', async () => {
    const began = Date.now();
    await sleep(30);
    assert.ok(Date.now() - began >= 20, 'sleep returned too early');
  });

  it('returns immediately for a non-positive delay', async () => {
    const began = Date.now();
    await sleep(0);
    assert.ok(Date.now() - began < 20);
  });

  it('does not leak an abort listener on the normal path', async () => {
    const controller = new AbortController();
    // Node warns above 10 listeners; the old implementation added one per call
    // and never removed it, so a long load test tripped MaxListenersExceeded.
    for (let i = 0; i < 50; i += 1) await sleep(0, controller.signal);
    for (let i = 0; i < 50; i += 1) await sleep(1, controller.signal);
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      0,
      'abort listeners accumulated across sleep calls',
    );
  });

  it('resolves early when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const began = Date.now();
    const pending = sleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await pending;
    assert.ok(Date.now() - began < 1000, 'sleep ignored the abort');
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const began = Date.now();
    await sleep(5000, controller.signal);
    assert.ok(Date.now() - began < 50);
  });
});

describe('makePacer', () => {
  it('enforces one dispatch per interval regardless of caller count', async () => {
    // 50 rps across 10 concurrent callers must mean 50 rps in total, not 500.
    const pace = makePacer(50);
    const began = Date.now();
    let dispatched = 0;

    await runPool(Array.from({ length: 10 }), 10, async () => {
      for (let i = 0; i < 5; i += 1) {
        await pace();
        dispatched += 1;
      }
    });

    const elapsed = Date.now() - began;
    const achievedRps = dispatched / (elapsed / 1000);
    assert.equal(dispatched, 50);
    // 50 dispatches at 50 rps is ~1000ms; the gap is one interval, so a
    // generous band still catches the 10x per-worker bug decisively.
    assert.ok(
      elapsed > 700,
      `pacer dispatched 50 requests in ${elapsed}ms — the rate is not global`,
    );
    assert.ok(achievedRps < 90, `achieved ${Math.round(achievedRps)} rps against a 50 rps target`);
  });

  it('is a no-op for a non-positive rate', async () => {
    const pace = makePacer(0);
    const began = Date.now();
    for (let i = 0; i < 100; i += 1) await pace();
    assert.ok(Date.now() - began < 100, 'a zero rate should not introduce delay');
  });

  it('does not burst to catch up after the schedule slips', async () => {
    const pace = makePacer(20); // 50ms gap
    await pace();
    await sleep(300);
    const began = Date.now();
    await pace();
    // The backlog must be discarded, not replayed as an immediate burst.
    assert.ok(Date.now() - began < 30, 'pacer replayed a backlog instead of rebasing');
  });

  it('stops waiting when the signal aborts', async () => {
    const controller = new AbortController();
    const pace = makePacer(1, controller.signal); // 1000ms gap
    await pace();
    const began = Date.now();
    const pending = pace();
    setTimeout(() => controller.abort(), 10);
    await pending;
    assert.ok(Date.now() - began < 500, 'pacer ignored the abort signal');
  });
});

describe('effectiveRps', () => {
  it('passes through a request inside the ceiling', () => {
    assert.deepEqual(effectiveRps(50, 1000), { rps: 50, clamped: false });
  });

  it('clamps a request above the ceiling and says so', () => {
    assert.deepEqual(effectiveRps(5000, 1000), { rps: 1000, clamped: true });
  });

  it('uses the ceiling when the request is not a usable number', () => {
    assert.deepEqual(effectiveRps(Number.NaN, 1000), { rps: 1000, clamped: false });
    assert.deepEqual(effectiveRps(0, 1000), { rps: 1000, clamped: false });
  });
});
