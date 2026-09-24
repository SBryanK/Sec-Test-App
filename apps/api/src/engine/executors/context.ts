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
   * Carries the previously used browser profile across requests in a run so
   * rotation actually rotates. Without this, each independent pick can land on
   * the same profile twice in a row, which is exactly what a fingerprinting
   * system treats as suspicious.
   */
  rotation: { previous: BrowserProfile | null };
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

let seqCounters = new WeakMap<object, number>();

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

/** Bounded-concurrency worker pool that respects an abort signal. */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
