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
  chargeCredits(runId: string, userId: string, credits: number): Promise<void>;
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
  /** Tests that produced at least one probe, and so were charged for. */
  chargedTestIds: TestId[];
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

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    flushing = flushing.then(() => store.insertTraces(run.id, batch));
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
    name: run.provenance.device ? '' : '',
  };

  const buildContext = (config: AttackConfig): ExecutorContext => {
    const test = getTest(config.testId);
    return {
      config,
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
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
    await flushing;
    activeRuns.delete(run.id);
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

  // Tests that produced at least one probe. Used for billing and for the
  // run's reported outcome.
  const ranTestIds = new Set<TestId>(Object.keys(metricsByTest) as TestId[]);

  // Charge only for tests that actually ran.
  //
  // This previously charged `totalCreditCost(configs)` — the full planned cost —
  // regardless of how much work happened, so a run that failed after one of
  // twelve tests still billed for twelve.
  if (status !== 'cancelled') {
    const billable = run.configs.filter((config) => ranTestIds.has(config.testId));
    const credits = totalCreditCost(billable);
    if (credits > 0) {
      await store.chargeCredits(run.id, run.provenance.operatorId, credits);
    }
  }

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

  const chargedTestIds = [...ranTestIds];
  return { status, summary, durationMs, error: runError, chargedTestIds };
}

/** Findings for a completed run, ready to be persisted. */
export type { Finding };
