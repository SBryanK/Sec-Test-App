import { EventEmitter } from 'node:events';

import type {
  AttackConfig,
  Finding,
  RunProgress,
  RunRecord,
  RunStatus,
  RunSummary,
  Severity,
  TestId,
  Verdict,
} from '@teo/shared';
import {
  getTest,
  hasBlockingIssue,
  maxSeverity,
  normaliseTarget,
  totalCreditCost,
  validateConfig,
} from '@teo/shared';

import { executorFor, planProbes } from './executors/index.ts';
import type { ExecutorContext, FindingDraft, TraceDraft } from './executors/context.ts';
import type { OperatorIdentity } from './anonymity.ts';
import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Store contract
 * ------------------------------------------------------------------ */

export interface RunStore {
  /** Persist a batch of traces. Batching keeps high-volume runs cheap. */
  insertTraces(runId: string, drafts: TraceDraft[]): Promise<void>;
  insertFindings(runId: string, findings: Array<FindingDraft & { id: string }>): Promise<void>;
  markStarted(runId: string, startedAt: Date): Promise<void>;
  markProgress(runId: string, patch: Partial<RunRecord>): Promise<void>;
  markFinished(runId: string, patch: Partial<RunRecord>): Promise<void>;
  /**
   * Reserve a run's cost atomically with the balance check. Returns false when
   * the balance is insufficient, having written nothing.
   */
  reserveCredits(userId: string, runId: string, credits: number): Promise<boolean>;
  /**
   * Settle a run's reserved cost against the tests that actually executed.
   * Returns the amount charged. Must be idempotent per run: the runner treats a
   * repeated settlement as a no-op rather than a second charge.
   */
  settleCredits(runId: string, userId: string, actual: number): Promise<number>;
  /**
   * Release a reservation in full because the run never executed. Used when the
   * execution queue rejects the run: the target was never touched, so the
   * operator must not be left holding the cost.
   */
  refundCredits(runId: string, userId: string): Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Progress bus (drives the SSE stream for the live run screen)
 * ------------------------------------------------------------------ */

export class ProgressBus extends EventEmitter {
  publish(progress: RunProgress): void {
    this.emit(`run:${progress.runId}`, progress);
  }

  subscribe(runId: string, listener: (p: RunProgress) => void): () => void {
    const channel = `run:${runId}`;
    this.emit(`subscribed:${runId}`, true);
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

/** In-flight runs, so a cancel request can reach the right abort controller. */
export const activeRuns = new Map<string, AbortController>();

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface ExecuteRunArgs {
  run: RunRecord;
  store: RunStore;
  bus: ProgressBus;
  /** Hard caps applied on top of the per-config options. */
  limits?: { maxRequests?: number; maxConcurrency?: number; maxRps?: number };
}

export interface ExecuteRunResult {
  status: RunStatus;
  summary: RunSummary;
  durationMs: number;
  error: string | null;
  /** Tests that emitted at least one probe, and so were charged for. */
  chargedTestIds: TestId[];
  /** Credits debited for this run, after settling the reservation. */
  creditsCharged: number;
}

/**
 * Execute a run.
 *
 * A `batch` run (the "Run All At Once" action) starts every test concurrently so
 * the target sees the full combined attack surface at once. `single` and
 * `custom` runs execute their configs in sequence, which keeps per-test timing
 * measurements clean.
 */
export async function executeRun(args: ExecuteRunArgs): Promise<ExecuteRunResult> {
  const { run, store, bus, limits } = args;
  const startedAt = new Date();
  const controller = new AbortController();
  activeRuns.set(run.id, controller);

  await store.markStarted(run.id, startedAt);

  const plannedByConfig = new Map<string, number>();
  let plannedTotal = 0;
  for (const config of run.configs) {
    const planned = planProbes(config);
    plannedByConfig.set(config.id, planned);
    plannedTotal += planned;
  }

  let completed = 0;
  let blocked = 0;
  let bypassed = 0;
  let errors = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  const ttfbSamples: number[] = [];
  /**
   * Tests that put at least one request on the wire.
   *
   * Populated as traces are emitted, not when the executor is invoked. Two
   * earlier rules were wrong in opposite directions: deriving it from
   * `metricsByTest` billed for configs that were skipped as invalid, and
   * marking it at the call site billed for an executor that threw before it
   * sent anything (a malformed config crashed the request builder and still
   * cost a credit). "Sent traffic" is the only rule the operator can check
   * against the evidence.
   */
  const emittedTestIds = new Set<TestId>();

  const publish = (patch: Partial<RunProgress> = {}): void => {
    const elapsedMs = Date.now() - startedAt.getTime();
    bus.publish({
      runId: run.id,
      status: 'running',
      progress: plannedTotal === 0 ? 0 : Math.min(1, completed / plannedTotal),
      completedProbes: completed,
      plannedProbes: plannedTotal,
      currentTestId: patch.currentTestId ?? null,
      achievedRps: elapsedMs > 0 ? Math.round((completed / (elapsedMs / 1000)) * 100) / 100 : null,
      elapsedMs,
      blocked,
      bypassed,
      errors,
      message: patch.message ?? null,
    });
  };

  // --- buffered trace writer ---------------------------------------
  const buffer: TraceDraft[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();
  /** First write failure, surfaced once at the end of the run. */
  let flushError: unknown = null;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    // The chain is anchored on a *settled* link. Chaining straight onto the
    // previous promise meant one failed INSERT left `flushing` rejected, so
    // every later `.then` was skipped: the rest of the run's evidence was
    // silently dropped. Recovery is explicit instead.
    flushing = flushing.catch(() => undefined).then(async () => {
      try {
        await store.insertTraces(run.id, batch);
      } catch (error) {
        flushError ??= error;
        throw error;
      }
    });
    await flushing;
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 250);
  };

  const emitTrace = async (draft: TraceDraft): Promise<void> => {
    emittedTestIds.add(draft.testId);
    buffer.push(draft);
    completed += 1;
    if (draft.verdict === 'blocked') blocked += 1;
    else if (draft.verdict === 'bypassed') bypassed += 1;
    else if (draft.verdict === 'error') errors += 1;

    bytesSent += draft.requestBytes;
    bytesReceived += draft.result.responseBytes;
    const ttfb = draft.result.timing.ttfbMs;
    if (ttfb !== null && ttfb !== undefined && Number.isFinite(ttfb)) {
      if (ttfbSamples.length < 20_000) ttfbSamples.push(ttfb);
    }

    if (buffer.length >= 100) await flush();
    else scheduleFlush();

    if (completed % 10 === 0 || completed === plannedTotal) publish();
  };

  // --- execute ------------------------------------------------------
  const allFindings: Array<FindingDraft & { id: string }> = [];
  const metricsByTest: Record<string, Record<string, number | string | boolean | null>> = {};
  const verdictByTest: Record<string, { verdict: Verdict; severity: Severity | null; reason: string }> = {};
  let runError: string | null = null;

  // The operator identity is used *only* to strip identifying material from
  // outgoing requests. It is never itself transmitted.
  const identity: OperatorIdentity = {
    email: run.provenance.operatorEmail,
    // Used only as extra needles for the identity sanitizer. This was
    // `device ? '' : ''` — always empty — so the operator's own display name
    // was never scrubbed from an outbound request that happened to contain it.
    name: run.provenance.operatorName ?? '',
  };

  // One counter for the whole run, shared by every executor context, so a
  // trace's seq is unique within the run and findings resolve to the right row.
  let seqCounter = 0;
  const allocateSeq = (): number => {
    seqCounter += 1;
    return seqCounter;
  };

  const buildContext = (config: AttackConfig): ExecutorContext => {
    const test = getTest(config.testId);
    return {
      config,
      allocateSeq,
      identity,
      target: normaliseTarget(config.target.domain, config.target),
      emit: emitTrace,
      signal: controller.signal,
      budget: {
        maxRequests: Math.min(config.options.maxRequests, limits?.maxRequests ?? 20_000),
        maxConcurrency: Math.min(config.options.maxConcurrency, limits?.maxConcurrency ?? 50),
        maxRps: Math.min(config.options.maxRps, limits?.maxRps ?? 1000),
      },
      log: (message: string) => publish({ currentTestId: config.testId, message: `${test.shortLabel}: ${message}` }),
      plannedProbes: plannedByConfig.get(config.id) ?? 1,
      rotation: { previous: null },
    };
  };

  const runOne = async (config: AttackConfig): Promise<void> => {
    const test = getTest(config.testId);
    const issues = validateConfig(config);
    if (hasBlockingIssue(issues)) {
      const message = issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.label}: ${i.message}`)
        .join('; ');
      verdictByTest[test.id] = { verdict: 'error', severity: null, reason: message };
      metricsByTest[test.id] = { skipped: `Invalid configuration — ${message}` };
      publish({ currentTestId: config.testId, message: `${test.shortLabel} skipped: ${message}` });
      return;
    }

    publish({ currentTestId: config.testId, message: `Running ${test.label}` });

    try {
      const outcome = await executorFor(config.testId)(buildContext(config));
      metricsByTest[test.id] = outcome.metrics;
      verdictByTest[test.id] = {
        verdict: outcome.detection.verdict,
        severity: outcome.detection.severity,
        reason: outcome.detection.reason,
      };
      for (const finding of outcome.findings) {
        allFindings.push({ ...finding, id: randomUUID() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      verdictByTest[test.id] = { verdict: 'error', severity: null, reason: message };
      metricsByTest[test.id] = { error: message };
      if (!runError) runError = `${test.label}: ${message}`;
      publish({ currentTestId: config.testId, message: `${test.shortLabel} failed: ${message}` });
    }
  };

  try {
    if (run.mode === 'batch') {
      // "Run All At Once" — everything fires concurrently.
      await Promise.all(run.configs.map((config) => runOne(config)));
    } else {
      for (const config of run.configs) {
        if (controller.signal.aborted) break;
        await runOne(config);
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  } finally {
    // Teardown must be unconditional. Previously a rejected flush escaped this
    // block, so `activeRuns.delete` never ran: the run stayed in the cancel map
    // forever and its status was never written, leaving it "running" in the
    // database with no process behind it.
    if (flushTimer) clearTimeout(flushTimer);
    try {
      await flush();
      await flushing;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      flushError ??= err;
      if (!runError) runError = `Evidence could not be stored: ${detail}`;
    } finally {
      activeRuns.delete(run.id);
    }
  }

  // --- roll up ------------------------------------------------------
  const durationMs = Date.now() - startedAt.getTime();
  const summary: RunSummary = {
    totalProbes: completed,
    blocked,
    bypassed,
    passed: Math.max(0, completed - blocked - bypassed - errors),
    errors,
    inconclusive: 0,
    maxSeverity: maxSeverity(allFindings.map((f) => f.severity)),
    bytesSent,
    bytesReceived,
    meanTtfbMs:
      ttfbSamples.length > 0
        ? Math.round((ttfbSamples.reduce((a, b) => a + b, 0) / ttfbSamples.length) * 100) / 100
        : null,
    achievedRps: durationMs > 0 ? Math.round((completed / (durationMs / 1000)) * 100) / 100 : null,
  };

  // Per-test outcomes are the practical observability payload: which test did
  // what, and how it ended. Previously computed and discarded.
  summary.tests = run.configs.map((config) => {
    const metrics = metricsByTest[config.testId] ?? {};
    const verdict = verdictByTest[config.testId];
    return {
      testId: config.testId,
      verdict: verdict?.verdict ?? 'inconclusive',
      severity: verdict?.severity ?? null,
      reason: verdict?.reason ?? 'No result was recorded for this test',
      metrics,
    };
  });

  const status: RunStatus = controller.signal.aborted
    ? 'cancelled'
    : runError !== null
      ? 'failed'
      : 'success';

  if (allFindings.length > 0) {
    await store.insertFindings(run.id, allFindings);
  }

  await store.markFinished(run.id, {
    status,
    durationMs,
    finishedAt: new Date().toISOString(),
    summary,
    error: runError,
  });

  // Charge only for tests that actually sent traffic.
  //
  // Three earlier rules were each wrong. Charging the planned cost billed for
  // twelve tests when one ran. Deriving the set from `metricsByTest` billed for
  // a config that was skipped as invalid. Marking it when the executor was
  // invoked billed for an executor that threw before its first request. The
  // reservation is settled against probes actually emitted.
  const billable = run.configs.filter((config) => emittedTestIds.has(config.testId));
  const actual = totalCreditCost(billable);
  const charged = await store.settleCredits(run.id, run.provenance.operatorId, actual);

  bus.publish({
    runId: run.id,
    status,
    progress: 1,
    completedProbes: completed,
    plannedProbes: plannedTotal,
    currentTestId: null,
    achievedRps: summary.achievedRps,
    elapsedMs: durationMs,
    blocked,
    bypassed,
    errors,
    message: runError ?? 'Run complete',
  });

  const chargedTestIds = [...emittedTestIds];
  return { status, summary, durationMs, error: runError, chargedTestIds, creditsCharged: charged };
}

/** Findings for a completed run, ready to be persisted. */
export type { Finding };
