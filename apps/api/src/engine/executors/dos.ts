import type { ProbeResult } from '../httpClient.ts';
import { http, https, openConnection } from '../httpClient.ts';
import {
  analyseLoad,
  detectLoadResilience,
  type LoadAnalysis,
} from '../detectors.ts';
import { buildRequest, num } from '../requestBuilder.ts';
import { describeFingerprint, fingerprint } from '../fingerprint.ts';
import {
  probeWith,
  buildFor,
  effectiveRps,
  findingFrom,
  makePacer,
  makeSeqFactory,
  REFERENCES,
  runPool,
  type Executor,
  type ExecutorContext,
  type ExecutorOutcome,
  type TraceDraft,
} from './context.ts';

interface LoadSample {
  statusCode: number | null;
  totalMs: number | null;
  error: string | null;
  /** Request number within the test, so blocking can be pinned to an iteration. */
  iteration?: number;
}

/** Keep-alive agent sized to the configured thread count. */
function makeAgent(target: { origin: string }, threads: number): http.Agent | https.Agent {
  const isHttps = target.origin.startsWith('https:');
  const Ctor = isHttps ? https.Agent : http.Agent;
  return new Ctor({
    keepAlive: true,
    maxSockets: Math.max(1, threads),
    maxFreeSockets: Math.max(1, threads),
  });
}

/* ------------------------------------------------------------------ *
 * HTTP Spike Test
 * ------------------------------------------------------------------ */

export const httpSpikeExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const burst = Math.min(num(ctx.config.values, 'spike.burst', 500), ctx.budget.maxRequests);
  const interval = num(ctx.config.values, 'spike.interval', 50);
  const threads = Math.min(num(ctx.config.values, 'spike.threads', 20), ctx.budget.maxConcurrency);
  const durationSec = num(ctx.config.values, 'spike.duration', 60);

  const agent = makeAgent(ctx.target, threads);
  const built = buildFor(ctx, null);
  const samples: LoadSample[] = [];

  // What the config asks for, versus what the platform ceiling will allow.
  // `interval` is the per-thread delay, so the requested rate is
  // `threads / interval`; the pacer then enforces it globally.
  const requestedRps = interval > 0 ? (threads * 1000) / interval : ctx.budget.maxRps;
  const { rps: targetRps, clamped } = effectiveRps(requestedRps, ctx.budget.maxRps);

  ctx.log(
    `Spiking ${burst} requests across ${threads} threads ` +
      `(~${Math.round(targetRps)} rps target, ${interval}ms per-thread interval)` +
      (clamped ? ` — capped from ${Math.round(requestedRps)} rps by the server limit` : ''),
  );

  const startedAt = Date.now();
  const deadline = startedAt + durationSec * 1000;

  let dispatchIndex = 0;
  const nextSeq = makeSeqFactory(ctx);
  let stoppedByDeadline = false;
  const pace = makePacer(targetRps, ctx.signal);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (ctx.signal.aborted) return;
      if (Date.now() > deadline) {
        stoppedByDeadline = true;
        return;
      }
      const index = dispatchIndex;
      dispatchIndex += 1;
      if (index >= burst) return;

      // Global pacing. The per-worker `sleep(interval)` that used to live here
      // multiplied the dispatch rate by the thread count and ignored
      // `budget.maxRps` entirely, so a config could exceed the platform's own
      // ceiling without any field being out of range.
      await pace();
      if (ctx.signal.aborted) return;

      const result = await probeWith(ctx, {
        url: built.url,
        method: built.method,
        headers: built.headers,
        body: built.body,
        timeoutMs: ctx.config.options.timeoutMs,
        followRedirects: false,
        verifyTls: ctx.config.options.verifyTls,
        agent,
      });

      const seq = nextSeq();

      samples.push({
        statusCode: result.statusCode,
        totalMs: result.timing.totalMs,
        error: result.error,
        iteration: seq,
      });
      await ctx.emit(makeLoadTrace(ctx, seq, seq, built, result));
    }
  };

  await runPool(Array.from({ length: threads }), threads, worker, ctx.signal);
  agent.destroy();

  const elapsed = Date.now() - startedAt;
  const analysis = analyseLoad(samples, elapsed);
  const detection = detectLoadResilience(analysis, 'HTTP spike');

  const findings: ReturnType<typeof findingFrom>[] = [];
  if (detection.verdict === 'bypassed') {
    findings.push(
      findingFrom(ctx.config.testId, detection, [], {
        title: 'Origin degraded under HTTP spike load',
        description: detection.reason,
        evidence: summariseLoad(analysis, burst, threads, interval),
        remediation:
          'Enforce origin connection limits and a request-rate policy at the edge. Review autoscaling thresholds and upstream timeouts so a burst cannot saturate workers.',
        references: REFERENCES.http_spike,
      }),
    );
  }

  if (stoppedByDeadline) {
    ctx.log(`Duration cap reached after ${elapsed}ms; stopped early.`);
  }

  return {
    detection,
    findings: findings.filter((f): f is NonNullable<typeof f> => f !== null),
    metrics: loadMetrics(analysis, {
      burst,
      threads,
      interval,
      durationSec,
      stoppedByDeadline,
      requestedRps: Math.round(requestedRps * 100) / 100,
      targetRps: Math.round(targetRps * 100) / 100,
      rateCappedByServerLimit: clamped,
    }),
  };
};

/* ------------------------------------------------------------------ *
 * Connection Flood Test
 * ------------------------------------------------------------------ */

export const connectionFloodExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const durationSec = num(ctx.config.values, 'flood.duration', num(ctx.config.values, 'traffic.duration', 60));
  const connections = Math.min(
    num(ctx.config.values, 'flood.connections', 100),
    ctx.budget.maxConcurrency * 2,
  );
  const rps = Math.min(num(ctx.config.values, 'flood.rps', 50), ctx.budget.maxRps);

  const built = buildFor(ctx, null);
  const path = new URL(built.url).pathname + new URL(built.url).search;
  const port = ctx.target.port ?? (ctx.target.useTls ? 443 : 80);
  const intervalMs = Math.max(1, Math.round(1000 / rps));

  ctx.log(
    `Opening ${connections} parallel connections to ${ctx.target.host}:${port} ` +
      `at ~${rps} rps total (1 request per ${intervalMs}ms)`,
  );

  // Establish the connection pool first so handshake cost is measured, not mixed
  // into the request rate.
  const handles = Array.from({ length: connections }, () =>
    openConnection(
      ctx.target.host,
      port,
      ctx.target.useTls,
      ctx.config.options.timeoutMs,
      ctx.config.options.verifyTls,
      built.userAgent,
      ctx.config.options.egressProxy,
    ),
  );

  const handshakes = await Promise.all(handles.map((h) => h.ready));
  const liveSockets = handles.filter((_handle, i) => handshakes[i]?.error == null);

  const handshakeFailures = handshakes.filter((h) => h.error !== null).length;
  const meanHandshake =
    handshakes.filter((h) => h.error === null).reduce((sum, h) => sum + (h.tcpMs ?? 0) + (h.tlsMs ?? 0), 0) /
    Math.max(1, liveSockets.length);

  ctx.log(
    `${liveSockets.length}/${connections} connections established` +
      (handshakeFailures > 0 ? ` (${handshakeFailures} failed)` : ''),
  );

  const samples: LoadSample[] = [];
  const startedAt = Date.now();
  const durationMs = durationSec * 1000;

  // `flood.rps` is documented as the *target request rate*, so it is paced
  // across the whole test rather than per connection. The per-connection sleep
  // that used to be here multiplied the real rate by the connection count:
  // 100 connections at 50 rps put 5000 rps on the target while the config and
  // the report both said 50.
  const pace = makePacer(rps, ctx.signal);

  const nextSeq = makeSeqFactory(ctx);
  let sendCount = 0;

  await runPool(
    liveSockets,
    liveSockets.length,
    async (handle) => {
      while (!ctx.signal.aborted && Date.now() - startedAt < durationMs) {
        await pace();
        if (ctx.signal.aborted) return;

        const began = Date.now();
        const outcome = await handle.send(`${built.method} ${path} HTTP/1.1`);
        const elapsed = Date.now() - began;

        const seq = nextSeq();
        sendCount += 1;

        samples.push({
          statusCode: outcome.statusCode,
          totalMs: elapsed,
          error: outcome.statusCode === null ? 'No status line received' : null,
          iteration: seq,
        });

        // Reused sockets cannot report per-phase timings; record the ones we
        // genuinely have and leave the handshake phases null rather than fake them.
        const synthetic: ProbeResult = {
          statusCode: outcome.statusCode,
          statusMessage: '',
          responseHeaders: {},
          bodyPreview: '',
          bodyBytes: outcome.bytesRead,
          responseHeaderBytes: 0,
          responseBytes: outcome.bytesRead,
          wireBytes: outcome.bytesRead,
          contentEncoding: null,
          responseHash: null,
          requestBytes: Buffer.byteLength(`${built.method} ${path} HTTP/1.1\r\n\r\n`),
          requestHeaderBytes: 0,
          timing: {
            dnsMs: null,
            tcpMs: null,
            tlsMs: null,
            ttfbMs: null,
            totalMs: elapsed,
          },
          redirectChain: [],
          tls: null,
          viaProxy: false,
          remoteAddress: `${ctx.target.host}:${port}`,
          error: outcome.statusCode === null ? 'No status line received within timeout' : null,
        };

        await ctx.emit(makeLoadTrace(ctx, seq, seq, built, synthetic));
      }
    },
    ctx.signal,
  );

  for (const handle of handles) handle.close();

  const elapsed = Date.now() - startedAt;
  const analysis = analyseLoad(samples, elapsed);
  const detection = detectLoadResilience(analysis, 'connection flood');

  const findings: ReturnType<typeof findingFrom>[] = [];
  if (detection.verdict === 'bypassed') {
    findings.push(
      findingFrom(ctx.config.testId, detection, [], {
        title: 'Origin degraded under sustained connection flood',
        description: detection.reason,
        evidence:
          `${summariseLoad(analysis, sendCount, connections, intervalMs)}\n` +
          `Handshakes: ${liveSockets.length}/${connections} succeeded; ` +
          `mean TCP+TLS ${Math.round(meanHandshake)}ms`,
        remediation:
          'Cap concurrent connections per client at the edge, enable connection queuing, and tune keep-alive/idle timeouts so slow or held sockets cannot exhaust the origin pool.',
        references: REFERENCES.connection_flood,
      }),
    );
  }

  return {
    detection,
    findings: findings.filter((f): f is NonNullable<typeof f> => f !== null),
    metrics: {
      ...loadMetrics(analysis, { connections, rps, durationSec, intervalMs, sendCount }),
      connectionsEstablished: liveSockets.length,
      connectionFailures: handshakeFailures,
      meanHandshakeMs: Math.round(meanHandshake * 100) / 100,
    },
  };
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function makeLoadTrace(
  ctx: ExecutorContext,
  seq: number,
  /** Request number within this test — the attack iteration. */
  iteration: number,
  built: ReturnType<typeof buildRequest>,
  result: ProbeResult,
): TraceDraft {
  const blocked = [403, 429, 503, 406].includes(result.statusCode ?? 0);
  const serverError = (result.statusCode ?? 0) >= 500;
  return {
    configId: ctx.config.id,
    testId: ctx.config.testId,
    seq,
    iteration,
    method: built.method,
    url: built.url,
    requestHeaders: built.headers,
    requestBodyPreview: built.body ? built.body.slice(0, 2048) : null,
    requestBytes: result.requestBytes,
    payload: null,
    injectionPoint: null,
    platformSummary: describeFingerprint(fingerprint(result.responseHeaders)),
    result,
    verdict: result.error ? 'error' : blocked ? 'blocked' : serverError ? 'bypassed' : 'passed',
    severity: serverError ? 'high' : null,
    reason: result.error
      ? `Transport failure: ${result.error}`
      : blocked
        ? `Rate limited or blocked with HTTP ${result.statusCode}`
        : serverError
          ? `Server error HTTP ${result.statusCode} under load`
          : `Completed with HTTP ${result.statusCode} in ${Math.round(result.timing.totalMs ?? 0)}ms`,
    signature: blocked ? `load:blocked-${result.statusCode}` : serverError ? `load:error-${result.statusCode}` : null,
  };
}

function summariseLoad(
  analysis: LoadAnalysis,
  planned: number,
  concurrency: number,
  intervalMs: number,
): string {
  return [
    `Planned: ${planned} requests, concurrency ${concurrency}, dispatch interval ${intervalMs}ms`,
    `Completed: ${analysis.total} in ${analysis.durationMs}ms (${analysis.achievedRps} rps achieved)`,
    `Status mix: ${analysis.ok} ok, ${analysis.blocked} blocked/limited, ${analysis.serverErrors} 5xx, ${analysis.transportErrors} transport errors`,
    `Latency: mean ${analysis.meanMs}ms, p50 ${analysis.p50Ms}ms, p95 ${analysis.p95Ms}ms, p99 ${analysis.p99Ms}ms, max ${analysis.maxMs}ms`,
  ].join('\n');
}

function loadMetrics(
  analysis: LoadAnalysis,
  extra: Record<string, number | string | boolean | null>,
): Record<string, number | string | boolean | null> {
  return {
    totalRequests: analysis.total,
    achievedRps: analysis.achievedRps,
    ok: analysis.ok,
    blocked: analysis.blocked,
    serverErrors: analysis.serverErrors,
    transportErrors: analysis.transportErrors,
    timeouts: analysis.timeouts,
    firstBlockedIteration: analysis.firstBlockedIteration,
    firstErrorIteration: analysis.firstErrorIteration,
    meanMs: analysis.meanMs,
    p50Ms: analysis.p50Ms,
    p95Ms: analysis.p95Ms,
    p99Ms: analysis.p99Ms,
    maxMs: analysis.maxMs,
    durationMs: analysis.durationMs,
    ...extra,
  };
}
