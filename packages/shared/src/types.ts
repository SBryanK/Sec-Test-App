/**
 * Core domain types for the EdgeOne Security Test platform.
 *
 * Design note: the test catalog is fully declarative. Each of the 12 tests is
 * described as data (sections -> fields), and a single schema-driven renderer in
 * the mobile app draws every config screen from it. The same definitions drive
 * server-side validation and the execution engine, so a test can never drift
 * between what the UI collects and what the engine runs.
 */

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

export type TestCategoryId =
  | 'dos_protection'
  | 'web_protection'
  | 'bot_management'
  | 'api_protection';

export interface TestCategory {
  id: TestCategoryId;
  label: string;
  /** Ionicons glyph name rendered in the category card. */
  icon: string;
  /** Accent colour for the icon; keeps the grid visually scannable. */
  accent: string;
  blurb: string;
  testIds: TestId[];
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

export type TestId =
  | 'http_spike'
  | 'connection_flood'
  | 'sql_injection'
  | 'xss'
  | 'path_traversal'
  | 'oversized_body'
  | 'user_agent_anomaly'
  | 'web_crawler'
  | 'brute_force'
  | 'idor_enumeration'
  | 'schema_validation'
  | 'business_logic';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Where a payload is substituted into the request. */
export type InjectionPoint = 'query' | 'body' | 'header' | 'path' | 'json_field';

/* ------------------------------------------------------------------ *
 * Declarative field schema
 * ------------------------------------------------------------------ */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'lines' // one entry per line -> string[]
  | 'number'
  | 'select'
  | 'slider'
  | 'checkbox'
  | 'segmented'
  | 'keyvalue' // repeatable Key/Value rows
  | 'note' // static informational callout
  | 'section' // sub-heading inside a section
  | 'divider';

export type FieldValue = string | number | boolean | string[] | KvPair[];

export interface KvPair {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface FieldDef {
  /** Dotted config path, e.g. `spike.burst`. Stable across releases. */
  id: string;
  type: FieldType;
  label: string;
  /** Helper line rendered under the control, e.g. `Total number of requests to send (10-1000)`. */
  hint?: string;
  placeholder?: string;
  /** Which section this field belongs to (matching a SectionDef id). */
  section: string;
  /** Numeric bounds; enforced on client and server. */
  min?: number;
  max?: number;
  step?: number;
  /** For `select` / `segmented`. */
  options?: SelectOption[];
  /** Static body for `note` fields. */
  body?: string;
  /** Note tone. */
  tone?: 'info' | 'warn' | 'danger';
  /** Collapsed under an "Advanced" disclosure by default. */
  advanced?: boolean;
  /** Render the value monospace (bodies, payload lists, paths). */
  mono?: boolean;
  /** Required to leave the config screen. */
  required?: boolean;
  /** Default value. `null` means intentionally empty (matches screenshots). */
  default?: FieldValue | null;
}

export interface SectionDef {
  id: string;
  title: string;
  /** Blue accent heading style used by the screenshots ("HTTP Spike Parameters"). */
  accent?: boolean;
}

export interface TestDefinition {
  id: TestId;
  category: TestCategoryId;
  /** Display name, e.g. "HTTP Spike Test". */
  label: string;
  /** Short name for history rows, e.g. "DoS Spike". */
  shortLabel: string;
  icon: string;
  /** One-line description for the catalog row. */
  blurb: string;
  /**
   * Whether this test can originate meaningful load from a handset.
   * `phone`  - fully effective from the device
   * `hybrid` - device can drive it but real intensity needs the server executor
   * `server` - physically impossible from a phone (raw sockets / volumetric)
   */
  feasibility: 'phone' | 'hybrid' | 'server';
  /** Explains the feasibility verdict to the operator. */
  feasibilityNote: string;
  /** Credits consumed per execution (Profile -> User Credits). */
  creditCost: number;
  /** Expected wall-clock duration for the default config, in ms. */
  defaultDurationMs: number;
  sections: SectionDef[];
  fields: FieldDef[];
  /** Default HTTP block, present on request-bearing tests. */
  http?: Partial<HttpBlock>;
}

/* ------------------------------------------------------------------ *
 * Runtime configuration
 * ------------------------------------------------------------------ */

export interface HttpBlock {
  method: HttpMethod;
  path: string;
  query: KvPair[];
  headers: KvPair[];
  body: string;
}

export interface TargetBlock {
  /** Bare host, host:port, URL, or IP. Normalised by the engine. */
  domain: string;
  /** Explicit TLS override; when undefined the engine infers from the scheme. */
  useTls?: boolean;
  /** TCP port override. */
  port?: number;
}

/** A complete, self-contained attack configuration. Serializable end to end. */
export interface AttackConfig {
  /** Stable id for the cart line item. */
  id: string;
  testId: TestId;
  target: TargetBlock;
  http: HttpBlock;
  /** Field-id -> value map for everything the renderer collected. */
  values: ConfigValues;
  options: ExecutionOptions;
}

export type ConfigValues = Record<string, FieldValue>;

/**
 * How the executor presents itself to the target.
 *
 *  identify  Sends the tool's own User-Agent and a header identifying the
 *            engagement. Use this when the customer's SOC has asked to
 *            allow-list you, or for a purple-team exercise where being seen is
 *            the point.
 *  neutral   No tool identity, no browser mimicry. Generic but unremarkable.
 *            The default, because leaking "a pentest tool is running" into a
 *            target's logs is a finding in itself.
 *  browser   A complete, internally-consistent modern browser fingerprint:
 *            matching User-Agent / Sec-CH-UA / Sec-Fetch header family, sent in
 *            the canonical browser header order, rotated per request.
 */
export type AnonymityMode = 'identify' | 'neutral' | 'browser';

export interface ExecutionOptions {
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  /** Requests per second ceiling enforced by the engine (typo guard). */
  maxRps: number;
  /** Hard ceiling on total requests emitted by one run. */
  maxRequests: number;
  /** Randomise payload order and inter-request delay. */
  jitter: boolean;
  /** Send a benign baseline request first and diff against it. */
  baselineDiff: boolean;
  /** Concurrency ceiling for the executor pool. */
  maxConcurrency: number;
  /** How the executor presents itself. See {@link AnonymityMode}. */
  anonymity: AnonymityMode;
  /**
   * Rotate the User-Agent (and matching Sec-CH-UA family) on every request.
   * Only meaningful in `browser` mode; forces it otherwise.
   */
  rotateUserAgent: boolean;
  /**
   * Explicit User-Agent override. When set, wins over the profile. Use for an
   * engagement where the customer allow-lists a specific string.
   */
  userAgentOverride: string | null;
  /**
   * Egress proxy URL (`http://user:pass@host:port`). When set, all attack
   * traffic is tunnelled through it so the target never sees the executor's
   * own address.
   */
  egressProxy: string | null;
}

/* ------------------------------------------------------------------ *
 * Platform fingerprint
 * ------------------------------------------------------------------ */

export interface PlatformIdentity {
  /** Short stable code, e.g. `cloudflare`. */
  code: string;
  name: string;
}

/**
 * What is in front of, and behind, the target.
 *
 * The two layers are reported separately on purpose. A Tencent COS bucket
 * behind EdgeOne is `edge: edgeone` with `origin: tencent-cos`; reporting either
 * as the other would mislead an operator about what they are testing.
 */
export interface PlatformFingerprint {
  /** CDN / WAF / edge platform, if one was detected. */
  edge: PlatformIdentity | null;
  /** Origin server software, if identifiable. */
  origin: PlatformIdentity | null;
  /** Raw `Server` header value, verbatim. */
  server: string | null;
  /** Cache outcome the edge reported (HIT / MISS / …). */
  cacheStatus: string | null;
  /** Every signature that matched, so the conclusion can be checked. */
  signals: string[];
  /** No edge identified — the request likely went straight to an origin. */
  directToOrigin: boolean;
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type RunMode = 'single' | 'batch' | 'custom';

/** Security outcome of an individual probe. */
export type Verdict =
  | 'blocked' // protection stopped it — the desired result for a defended target
  | 'bypassed' // attack reached the origin / succeeded — a real finding
  | 'passed' // normal, expected behaviour; not a finding
  | 'error' // transport or protocol failure
  | 'inconclusive';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RunRecord {
  id: string;
  mode: RunMode;
  status: RunStatus;
  /** Display label: the single test name, or "All Tests (12)" for a batch. */
  label: string;
  /** Target host for quick display and history grouping. */
  target: string;
  testIds: TestId[];
  configs: AttackConfig[];
  /** Wall-clock duration in ms; matches the `Duration 15233ms` history row. */
  durationMs: number | null;
  creditsUsed: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Roll-up counters. */
  summary: RunSummary | null;
  error: string | null;
  /** Operator + provenance stamp. Present on every run. */
  provenance: Provenance;
}

export interface RunSummary {
  totalProbes: number;
  blocked: number;
  bypassed: number;
  passed: number;
  errors: number;
  inconclusive: number;
  /** Peak observed severity across all findings. */
  maxSeverity: Severity | null;
  /** Bytes sent / received, aggregated. */
  bytesSent: number;
  bytesReceived: number;
  /** Mean first-byte latency across probes, ms. */
  meanTtfbMs: number | null;
  /** Requests per second actually achieved. */
  achievedRps: number | null;
  /** Per-test outcome and the executor's own metrics. */
  tests?: TestOutcome[];
}

/** What one test in a run concluded, plus its measured metrics. */
export interface TestOutcome {
  testId: TestId;
  verdict: Verdict;
  severity: Severity | null;
  reason: string;
  /** Executor-specific numbers; keys vary by test. */
  metrics: Record<string, number | string | boolean | null>;
}

/**
 * Provenance + forensic stamp. Written as row 0 of a run's trace log so every
 * request in the database can be attributed to an operator, a time and an
 * exact parameter set — the audit trail counterpart to the request telemetry.
 */
export interface Provenance {
  operatorId: string;
  operatorEmail: string;
  /** Device that launched the run. */
  device: string;
  platform: string;
  appVersion: string;
  /** SHA-256 over the canonicalised config set — proves what was run. */
  configHash: string;
  /** Client IP as seen by the API. */
  sourceIp: string;
  /** How the executor presented itself to the target. */
  anonymity: AnonymityMode;
  /** Egress proxy used, with credentials redacted. */
  egressProxy: string | null;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Forensic request telemetry
 * ------------------------------------------------------------------ */

/** Where a probe's timing went. All values in milliseconds, null if not reached. */
export interface TimingBreakdown {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  /** Time to first byte of the response body. */
  ttfbMs: number | null;
  /** Full response received. Null when the exchange never completed. */
  totalMs: number | null;
}

export interface RequestTrace {
  id: string;
  runId: string;
  configId: string;
  testId: TestId;
  /** 1-based index within the run, across all tests. */
  seq: number;
  /**
   * 1-based attempt number *within this test*. For load tests this is the
   * request number, which is what answers "when did blocking start?". For
   * payload tests it is the payload's position in the dictionary.
   */
  iteration: number;
  method: HttpMethod;
  url: string;
  /** Resolved IP:port that answered, e.g. `43.174.196.51:443`. */
  remoteAddress: string | null;
  /** Header set actually transmitted, secrets redacted. */
  requestHeaders: Record<string, string>;
  /** First 2 KB of the request body that was sent. */
  requestBodyPreview: string | null;
  /** Exact request body size in bytes, including the oversized-body case. */
  requestBytes: number;
  /** The payload substituted for this probe, if any. */
  payload: string | null;
  /** Where the payload was injected. */
  injectionPoint: InjectionPoint | null;
  statusCode: number | null;
  /** Header bytes + body bytes as reported by the server. */
  responseBytes: number;
  responseHeaders: Record<string, string>;
  /** First 2 KB of the response, for evidence. */
  responseBodyPreview: string | null;
  /** SHA-256 of the full response body — lets two probes be compared cheaply. */
  responseHash: string | null;
  timing: TimingBreakdown;
  verdict: Verdict;
  severity: Severity | null;
  /** Human-readable explanation of the verdict. */
  reason: string | null;
  /** Matched detector signature, when one fired. */
  signature: string | null;
  error: string | null;
  createdAt: string;
}

export interface Finding {
  id: string;
  runId: string;
  testId: TestId;
  title: string;
  severity: Severity;
  verdict: Verdict;
  description: string;
  /** Concrete proof: the payload, status code, and the matched evidence. */
  evidence: string;
  remediation: string;
  /** Trace rows that back this finding. */
  traceIds: string[];
  /** External references (OWASP, CWE). */
  references: string[];
}

/** Live progress pushed over SSE while a run executes. */
export interface RunProgress {
  runId: string;
  status: RunStatus;
  /** 0..1 */
  progress: number;
  completedProbes: number;
  plannedProbes: number;
  currentTestId: TestId | null;
  achievedRps: number | null;
  elapsedMs: number;
  /** Rolling counters so the UI can animate live. */
  blocked: number;
  bypassed: number;
  errors: number;
  message: string | null;
}

/* ------------------------------------------------------------------ *
 * History / filters / export
 * ------------------------------------------------------------------ */

export interface HistoryFilter {
  status?: RunStatus | 'any';
  categories?: TestCategoryId[];
  /** Free-text match against the target. */
  domainContains?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface HistoryPage {
  runs: RunRecord[];
  nextCursor: string | null;
  total: number;
}

/**
 * Report formats.
 *
 * `html` is a self-contained, print-styled report that renders to PDF through
 * the platform share sheet — no headless browser is required on the server, and
 * it works identically on iOS and Android.
 */
export type ExportFormat = 'json' | 'csv' | 'html';

export interface ExportRequest {
  runIds: string[];
  format: ExportFormat;
  /** Include the per-request trace log (can be very large). */
  includeTraces: boolean;
}

/* ------------------------------------------------------------------ *
 * Portability (Import / Export config)
 * ------------------------------------------------------------------ */

/** The `TestParameters` JSON document referenced by the import templates. */
export interface TestParametersDocument {
  $schema?: string;
  version: 1;
  tests: Array<{
    testId: TestId;
    target: TargetBlock;
    http?: Partial<HttpBlock>;
    values?: ConfigValues;
    options?: Partial<ExecutionOptions>;
  }>;
}

/* ------------------------------------------------------------------ *
 * Account
 * ------------------------------------------------------------------ */

export type UserStatus = 'pending' | 'active' | 'suspended';

export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  role: 'operator' | 'admin';
  /**
   * Invitation-only access. `pending` means the account has been requested but
   * not yet approved by an administrator, and cannot sign in.
   */
  status: UserStatus;
  /** Incremented to revoke every token this operator currently holds. */
  tokenVersion: number;
  creditsUsed: number;
  creditsRemaining: number;
  language: 'en' | 'zh';
  requestedAt?: string;
  approvedAt?: string | null;
}

export interface AuthSession {
  token: string;
  refreshToken: string;
  expiresAt: string;
  user: UserAccount;
}
