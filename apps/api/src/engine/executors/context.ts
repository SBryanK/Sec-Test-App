import type {
  AttackConfig,
  Finding,
  HttpMethod,
  InjectionPoint,
  NormalisedTarget,
  Severity,
  TestId,
  Verdict,
} from '@teo/shared';
import { probe, type ProbeOptions, type ProbeResult } from '../httpClient.ts';
import type { Detection } from '../detectors.ts';
import { BROWSER_PROFILES, type BrowserProfile, type OperatorIdentity } from '../anonymity.ts';
import { buildRequest, type BuildRequestOptions, type BuiltRequest } from '../requestBuilder.ts';
import { describeFingerprint, fingerprint } from '../fingerprint.ts';

/** A trace row before it is assigned a database id. */
export interface TraceDraft {
  configId: string;
  testId: TestId;
  seq: number;
  /**
   * 1-based attempt number within this test. Load tests use the request number
   * (so a run can say when blocking started); payload tests use the payload's
   * position in the dictionary.
   */
  iteration: number;
  method: HttpMethod;
  url: string;
  requestHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  requestBytes: number;
  payload: string | null;
  injectionPoint: InjectionPoint | null;
  /** Edge/origin identification for this response. */
  platformSummary: string | null;
  result: ProbeResult;
  verdict: Verdict;
  severity: Severity | null;
  reason: string | null;
  signature: string | null;
}

export interface FindingDraft {
  testId: TestId;
  title: string;
  severity: Severity;
  verdict: Verdict;
  description: string;
  evidence: string;
  remediation: string;
  /** `seq` values of the traces that back this finding. */
  traceSeqs: number[];
  references: string[];
}

export interface ExecutionBudget {
  maxRequests: number;
  maxConcurrency: number;
  maxRps: number;
}

export interface ExecutorContext {
  config: AttackConfig;
  target: NormalisedTarget;
  /**
   * Who is running this. Passed to `buildRequest` so nothing identifying can
   * reach the wire, and never transmitted itself.
   */
  identity: OperatorIdentity | null;
  /** Persist + broadcast one probe. Awaited so back-pressure is respected. */
  emit(draft: TraceDraft): Promise<void>;
  signal: AbortSignal;
  budget: ExecutionBudget;
  /** Human-readable progress line for the live run screen. */
  log(message: string): void;
  /** Number of probes this executor expects to run, for the progress bar. */
  plannedProbes: number;
  /**
   * Allocates the next run-wide sequence number. Shared across every config in
   * the run, so `seq` is unique within a run.
   */
  allocateSeq: () => number;
  /**
   * Carries the previously used browser profile across requests in a run so
   * rotation actually rotates. Without this, each independent pick can land on
   * the same profile twice in a row, which is exactly what a fingerprinting
   * system treats as suspicious.
   */
  rotation: { previous: BrowserProfile | null; warnedOverridden?: boolean };
}

/** Convenience: build a request with this context's identity already applied. */
export function buildFor(
  ctx: ExecutorContext,
  payload: string | null,
  options: Omit<BuildRequestOptions, 'identity' | 'previousProfile'> = {},
): BuiltRequest {
  const built = buildRequest(ctx.config, ctx.target, payload, {
    ...options,
    identity: ctx.identity,
    previousProfile: ctx.rotation.previous,
  });

  if (built.profileId) {
    ctx.rotation.previous =
      BROWSER_PROFILES.find((p) => p.id === built.profileId) ?? ctx.rotation.previous;
  }

  // Warn once, not per request: an operator who selected browser anonymity but
  // pinned a User-Agent in the Headers section is getting no rotation at all,
  // and nothing on screen said so.
  if (built.profileOverridden && !ctx.rotation.warnedOverridden) {
    ctx.rotation.warnedOverridden = true;
    ctx.log(
      'Browser anonymity is on, but the Headers section sets its own User-Agent, ' +
        'so no profile rotation is reaching the target. Clear that header to rotate.',
    );
  }

  return built;
}

/**
 * Issue a probe with the run's execution options applied.
 *
 * Executors must never call `probe()` directly: doing so would silently drop the
 * egress proxy and send traffic from the executor's own address. Routing every
 * request through here makes that impossible to get wrong.
 */
export function probeWith(
  ctx: ExecutorContext,
  options: Omit<ProbeOptions, 'proxyUrl'>,
): Promise<ProbeResult> {
  return probe({ ...options, proxyUrl: ctx.config.options.egressProxy });
}

export interface ExecutorOutcome {
  /** Roll-up verdict for the whole test. */
  detection: Detection;
  findings: FindingDraft[];
  metrics: Record<string, number | string | boolean | null>;
}

export type Executor = (ctx: ExecutorContext) => Promise<ExecutorOutcome>;

/* ------------------------------------------------------------------ *
 * Shared helpers used by every executor
 * ------------------------------------------------------------------ */

const seqCounters = new WeakMap<object, number>();

export function makeSeqFactory(ctx: ExecutorContext): () => number {
  let counter = seqCounters.get(ctx) ?? 0;
  return () => {
    counter += 1;
    seqCounters.set(ctx, counter);
    return counter;
  };
}

export interface RecordProbeArgs {
  ctx: ExecutorContext;
  nextSeq: () => number;
  /** Attempt number within this test; defaults to the run sequence number. */
  iteration?: number;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  payload: string | null;
  injectionPoint: InjectionPoint | null;
  result: ProbeResult;
  detection: Detection;
}

/** Turn a raw probe result plus its detection into a persisted trace row. */
export async function recordProbe(args: RecordProbeArgs): Promise<number> {
  const { ctx, nextSeq, result, detection } = args;
  const seq = nextSeq();
  await ctx.emit({
    configId: ctx.config.id,
    testId: ctx.config.testId,
    seq,
    iteration: args.iteration ?? seq,
    method: args.method,
    url: args.url,
    requestHeaders: redactHeaders(args.headers),
    requestBodyPreview: args.body ? args.body.slice(0, 2048) : null,
    requestBytes: result.requestBytes,
    payload: args.payload,
    injectionPoint: args.injectionPoint,
    platformSummary: describeFingerprint(fingerprint(result.responseHeaders)),
    result,
    verdict: detection.verdict,
    severity: detection.severity,
    reason: detection.reason,
    signature: detection.signature,
  });
  return seq;
}

const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);

/**
 * Header values are retained for evidence, but credential-bearing headers are
 * truncated to a recognisable prefix so a trace log never stores a live secret.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(key.toLowerCase())) {
      out[key] = value.length > 12 ? `${value.slice(0, 12)}…[redacted ${value.length} chars]` : '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Bounded-concurrency worker pool that respects an abort signal.
 *
 * If one worker throws, the remaining runners stop *claiming new items* rather
 * than racing through the rest of the list. Without that, a load test whose
 * first worker blew up would still fire every remaining request while the run
 * recorded a single error: the target sees the whole attack and the evidence
 * captures almost none of it. In-flight items are allowed to settle before the
 * error is rethrown, so the caller never unwinds while probes are still being
 * written.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  let failed = false;
  let firstError: unknown = null;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      if (failed || signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        await worker(item, index);
      } catch (error) {
        // Keep only the first failure: the rest are almost always the same root
        // cause and would bury it.
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  });

  // `allSettled` cannot reject, so siblings still in flight can never surface as
  // an unhandled rejection while we wait for them.
  await Promise.allSettled(runners);

  if (failed) throw firstError;
}

/**
 * Abortable sleep.
 *
 * The abort listener is removed on the normal path. Leaving it attached added
 * one listener per sleep to a run-long signal, which retains the closure and
 * eventually trips Node's max-listeners warning on long load tests.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Shared dispatch pacer for the load tests.
 *
 * A per-worker sleep does not bound a run's request rate: N workers each
 * sleeping `interval` ms dispatch at `N / interval`, so "20 threads at 50 ms"
 * is 400 rps, not 20. That made the platform's own `maxRps` ceiling
 * unenforceable — a config could sit inside every documented field limit and
 * still put multiples of the intended load on the target. The pacer serialises
 * only the *scheduling*, so the ceiling holds no matter how many workers exist.
 *
 * It deliberately does not catch up after falling behind: `nextAt` is rebased
 * to "now" whenever the schedule slips, so a stalled target is never answered
 * with a compensating burst.
 */
export function makePacer(targetRps: number, signal?: AbortSignal): () => Promise<void> {
  const minGapMs = targetRps > 0 && Number.isFinite(targetRps) ? 1000 / targetRps : 0;
  let nextAt = 0;
  let chain: Promise<void> = Promise.resolve();

  return () => {
    chain = chain.then(async () => {
      if (minGapMs <= 0) return;
      const now = Date.now();
      const wait = Math.max(0, nextAt - now);
      nextAt = Math.max(now, nextAt) + minGapMs;
      if (wait > 0) await sleep(wait, signal);
    });
    return chain;
  };
}

/**
 * The request rate a config asks for, after the platform ceiling is applied.
 * The `clamped` flag lets a run state plainly that a cap changed the rate,
 * instead of quietly testing something other than what was configured.
 */
export function effectiveRps(requested: number, ceiling: number): { rps: number; clamped: boolean } {
  if (!Number.isFinite(requested) || requested <= 0) return { rps: ceiling, clamped: false };
  if (requested > ceiling) return { rps: ceiling, clamped: true };
  return { rps: requested, clamped: false };
}

/** Findings are only produced for actionable verdicts. */
export function findingFrom(
  testId: TestId,
  detection: Detection,
  traceSeqs: number[],
  detail: { title: string; description: string; evidence: string; remediation: string; references: string[] },
): FindingDraft | null {
  if (detection.verdict !== 'bypassed') return null;
  return {
    testId,
    title: detail.title,
    severity: detection.severity ?? 'medium',
    verdict: detection.verdict,
    description: detail.description,
    evidence: detail.evidence,
    remediation: detail.remediation,
    traceSeqs,
    references: detail.references,
  };
}

/** OWASP/CWE references keyed by test, used to enrich findings. */
export const REFERENCES: Record<TestId, string[]> = {
  http_spike: ['OWASP API4:2023 Unrestricted Resource Consumption'],
  connection_flood: ['OWASP API4:2023 Unrestricted Resource Consumption'],
  sql_injection: ['OWASP A03:2021 Injection', 'CWE-89'],
  xss: ['OWASP A03:2021 Injection', 'CWE-79'],
  path_traversal: ['OWASP A01:2021 Broken Access Control', 'CWE-22'],
  oversized_body: ['OWASP API4:2023 Unrestricted Resource Consumption', 'CWE-770'],
  user_agent_anomaly: ['OWASP Automated Threats to Web Applications (OAT-011)', 'CWE-1059'],
  web_crawler: ['OWASP Automated Threats to Web Applications (OAT-011)'],
  brute_force: ['OWASP A07:2021 Identification and Authentication Failures', 'CWE-307'],
  idor_enumeration: ['OWASP A01:2021 Broken Access Control', 'CWE-639'],
  schema_validation: ['OWASP API6:2023 Unrestricted Access to Sensitive Business Flows', 'CWE-20'],
  business_logic: ['OWASP A04:2021 Insecure Design', 'CWE-362'],
};

export type { Detection, ProbeResult, AttackConfig, NormalisedTarget, Finding };
