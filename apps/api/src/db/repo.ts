import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

import type {
  AttackConfig,
  Finding,
  HistoryFilter,
  HistoryPage,
  Provenance,
  RunRecord,
  RunStatus,
  RunSummary,
  Severity,
  TestCategoryId,
  TestId,
  UserAccount,
  Verdict,
} from '@teo/shared';
import { SEVERITY_RANK } from '@teo/shared';

import { pool, query, withTransaction } from './pool.ts';
import type { RunStore } from '../engine/runner.ts';
import type { FindingDraft, TraceDraft } from '../engine/executors/context.ts';

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

interface RunRow {
  id: string;
  user_id: string | null;
  mode: string;
  status: string;
  label: string;
  target: string;
  test_ids: string[];
  configs: AttackConfig[];
  duration_ms: number | null;
  credits_used: number;
  summary: RunSummary | null;
  error: string | null;
  provenance: Provenance;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    mode: row.mode as RunRecord['mode'],
    status: row.status as RunStatus,
    label: row.label,
    target: row.target,
    testIds: row.test_ids as TestId[],
    configs: row.configs,
    durationMs: row.duration_ms,
    creditsUsed: row.credits_used,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    summary: row.summary,
    error: row.error,
    provenance: row.provenance,
  };
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export interface CreateRunInput {
  id: string;
  userId: string;
  mode: RunRecord['mode'];
  label: string;
  target: string;
  configs: AttackConfig[];
  creditsUsed: number;
  provenance: Provenance;
}

export async function createRun(input: CreateRunInput): Promise<RunRecord> {
  const testIds = [...new Set(input.configs.map((c) => c.testId))];
  const { rows } = await query<RunRow>(
    `INSERT INTO runs (id, user_id, mode, status, label, target, test_ids, configs, credits_used, provenance)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7::jsonb, $8, $9::jsonb)
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.mode,
      input.label,
      input.target,
      testIds,
      JSON.stringify(input.configs),
      input.creditsUsed,
      JSON.stringify(input.provenance),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Failed to create run');
  return mapRun(row);
}

export async function getRun(id: string, userId?: string): Promise<RunRecord | null> {
  const { rows } = await query<RunRow>(
    userId
      ? `SELECT * FROM runs WHERE id = $1 AND user_id = $2`
      : `SELECT * FROM runs WHERE id = $1`,
    userId ? [id, userId] : [id],
  );
  const row = rows[0];
  return row ? mapRun(row) : null;
}

/**
 * History listing with the filters exposed by the History screen's filter sheet
 * (status, category, domain-contains, date range, quick ranges).
 *
 * `scopeUserId` restricts results to one operator. Pass undefined for shared
 * visibility, where the whole team sees every run — the default for a team
 * engagement, and what the README documents.
 */
export async function listRuns(
  filter: HistoryFilter,
  scopeUserId?: string,
): Promise<HistoryPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (scopeUserId) {
    params.push(scopeUserId);
    where.push(`user_id = $${params.length}`);
  }

  if (filter.status && filter.status !== 'any') {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }

  if (filter.categories && filter.categories.length > 0) {
    // Category is expressed as a set of test ids; a run matches if it contains any.
    const ids = testIdsForCategories(filter.categories);
    params.push(ids);
    where.push(`test_ids && $${params.length}::text[]`);
  }

  if (filter.domainContains && filter.domainContains.trim()) {
    params.push(`%${filter.domainContains.trim().toLowerCase()}%`);
    where.push(`lower(target) LIKE $${params.length}`);
  }

  if (filter.from) {
    params.push(filter.from);
    where.push(`created_at >= $${params.length}`);
  }

  if (filter.to) {
    params.push(filter.to);
    where.push(`created_at <= $${params.length}`);
  }

  if (filter.cursor) {
    params.push(filter.cursor);
    where.push(`created_at < $${params.length}`);
  }

  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  params.push(limit + 1);

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query<RunRow>(
    `SELECT * FROM runs ${clause} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const countResult = await query<{ count: string }>(
    scopeUserId
      ? `SELECT count(*)::text AS count FROM runs WHERE user_id = $1`
      : `SELECT count(*)::text AS count FROM runs`,
    scopeUserId ? [scopeUserId] : [],
  );

  return {
    runs: page.map(mapRun),
    nextCursor: hasMore && page.length > 0 ? (page[page.length - 1]?.created_at.toISOString() ?? null) : null,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/** Map a category filter to the test ids it contains. */
function testIdsForCategories(categories: TestCategoryId[]): string[] {
  // Imported lazily to avoid a cycle at module init.
  const map: Record<TestCategoryId, string[]> = {
    dos_protection: ['http_spike', 'connection_flood'],
    web_protection: ['sql_injection', 'xss', 'path_traversal', 'oversized_body'],
    bot_management: ['user_agent_anomaly', 'web_crawler'],
    api_protection: ['brute_force', 'idor_enumeration', 'schema_validation', 'business_logic'],
  };
  return categories.flatMap((c) => map[c] ?? []);
}

export async function deleteRun(id: string, userId: string): Promise<boolean> {
  const result = await query(`DELETE FROM runs WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Traces
 * ------------------------------------------------------------------ */

const TRACE_COLUMNS = [
  'run_id',
  'config_id',
  'test_id',
  'seq',
  'iteration',
  'method',
  'url',
  'request_headers',
  'request_body_preview',
  'request_bytes',
  'payload',
  'injection_point',
  'status_code',
  'response_headers',
  'response_body_preview',
  'response_bytes',
  'response_hash',
  'remote_address',
  'platform_summary',
  'dns_ms',
  'tcp_ms',
  'tls_ms',
  'ttfb_ms',
  'total_ms',
  'verdict',
  'severity',
  'reason',
  'signature',
  'error',
] as const;

const TRACE_COLUMN_COUNT = TRACE_COLUMNS.length;

/**
 * Columns that need an explicit ::jsonb cast.
 *
 * Resolved by name, never by position: inserting a column previously left these
 * indices stale, which silently cast the wrong columns and made the whole
 * insert fail with an opaque parser error.
 */
const JSONB_COLUMNS = new Set(['request_headers', 'response_headers']);
const JSONB_INDICES = TRACE_COLUMNS.map((name, index) => (JSONB_COLUMNS.has(name) ? index : -1)).filter(
  (i) => i >= 0,
);

export interface StoredTrace extends Omit<TraceDraft, 'result'> {
  id: string;
  runId: string;
  createdAt: string;
  statusCode: number | null;
  responseHeaders: Record<string, string>;
  responseBodyPreview: string | null;
  responseBytes: number;
  responseHash: string | null;
  requestHeadersStored: Record<string, string>;
  timing: {
    dnsMs: number | null;
    tcpMs: number | null;
    tlsMs: number | null;
    ttfbMs: number | null;
    totalMs: number | null;
  };
}

/**
 * Bulk-insert traces using one multi-row statement.
 *
 * A 1000-request spike would otherwise issue 1000 round trips; batching keeps
 * the forensic log cheap enough to always be on.
 */
export async function insertTraces(runId: string, drafts: TraceDraft[]): Promise<void> {
  if (drafts.length === 0) return;

  // Chunk so a single statement never exceeds the parameter limit (65535).
  const chunkSize = Math.floor(60_000 / TRACE_COLUMN_COUNT);

  for (let start = 0; start < drafts.length; start += chunkSize) {
    const chunk = drafts.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const draft of chunk) {
      const offset = values.length;
      const placeholders = TRACE_COLUMNS.map((_, i) => `$${offset + i + 1}`);
      for (const index of JSONB_INDICES) {
        placeholders[index] = `${placeholders[index]}::jsonb`;
      }
      tuples.push(`(${placeholders.join(', ')})`);

      values.push(
        runId,
        draft.configId,
        draft.testId,
        draft.seq,
        draft.iteration,
        draft.method,
        draft.url,
        JSON.stringify(draft.requestHeaders),
        draft.requestBodyPreview,
        draft.requestBytes,
        draft.payload,
        draft.injectionPoint,
        draft.result.statusCode,
        JSON.stringify(draft.result.responseHeaders),
        draft.result.bodyPreview || null,
        draft.result.responseBytes,
        draft.result.responseHash,
        draft.result.remoteAddress,
        draft.platformSummary,
        draft.result.timing.dnsMs,
        draft.result.timing.tcpMs,
        draft.result.timing.tlsMs,
        draft.result.timing.ttfbMs,
        draft.result.timing.totalMs,
        draft.verdict,
        draft.severity,
        draft.reason,
        draft.signature,
        draft.result.error,
      );
    }

    await query(
      `INSERT INTO request_traces (${TRACE_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

export interface TraceQueryOptions {
  testId?: TestId;
  verdict?: Verdict;
  limit?: number;
  offset?: number;
  /** Include the response body preview (large). */
  includeBodies?: boolean;
}

export async function getTraces(runId: string, opts: TraceQueryOptions = {}): Promise<unknown[]> {
  const where = ['run_id = $1'];
  const params: unknown[] = [runId];

  if (opts.testId) {
    params.push(opts.testId);
    where.push(`test_id = $${params.length}`);
  }
  if (opts.verdict) {
    params.push(opts.verdict);
    where.push(`verdict = $${params.length}`);
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  params.push(limit);
  const limitIdx = params.length;
  params.push(Math.max(opts.offset ?? 0, 0));
  const offsetIdx = params.length;

  const bodyCol = opts.includeBodies === false ? 'NULL::text AS response_body_preview' : 'response_body_preview';

  const { rows } = await query(
    `SELECT id, run_id, config_id, test_id, seq, iteration, method, url, remote_address, platform_summary,
            request_headers, request_body_preview, request_bytes, payload, injection_point,
            status_code, response_headers, ${bodyCol}, response_bytes, response_hash,
            dns_ms, tcp_ms, tls_ms, ttfb_ms, total_ms,
            verdict, severity, reason, signature, error, created_at
     FROM request_traces
     WHERE ${where.join(' AND ')}
     ORDER BY seq ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return rows;
}

/**
 * Per-test outcome with iteration detail.
 *
 * This is the "what actually happened" view: for a 500-request spike it answers
 * "requests 1–247 were served, blocking began at request 248", which is far more
 * useful than a percentage. Computed in SQL so it stays exact regardless of how
 * many traces a run produced.
 */
export interface TestSummaryRow {
  testId: string;
  probes: number;
  passed: number;
  blocked: number;
  bypassed: number;
  errors: number;
  /** First attempt number the target pushed back on. */
  firstBlockedIteration: number | null;
  /** First attempt that got through. */
  firstBypassedIteration: number | null;
  /** First attempt that errored. */
  firstErrorIteration: number | null;
  firstStatusCode: number | null;
  lastStatusCode: number | null;
  /** Distinct status codes seen, ascending. */
  statusCodes: number[];
}

export async function summariseRun(runId: string): Promise<TestSummaryRow[]> {
  const { rows } = await query<{
    test_id: string;
    probes: string;
    passed: string;
    blocked: string;
    bypassed: string;
    errors: string;
    first_blocked: number | null;
    first_bypassed: number | null;
    first_error: number | null;
    first_status: number | null;
    last_status: number | null;
    status_codes: number[] | null;
  }>(
    `SELECT
       test_id,
       count(*)::text AS probes,
       count(*) FILTER (WHERE verdict = 'passed')::text   AS passed,
       count(*) FILTER (WHERE verdict = 'blocked')::text  AS blocked,
       count(*) FILTER (WHERE verdict = 'bypassed')::text AS bypassed,
       count(*) FILTER (WHERE verdict = 'error')::text    AS errors,
       min(iteration) FILTER (WHERE verdict = 'blocked')  AS first_blocked,
       min(iteration) FILTER (WHERE verdict = 'bypassed') AS first_bypassed,
       min(iteration) FILTER (WHERE verdict = 'error')    AS first_error,
       (array_agg(status_code ORDER BY iteration))[1]     AS first_status,
       (array_agg(status_code ORDER BY iteration DESC))[1] AS last_status,
       array_agg(DISTINCT status_code ORDER BY status_code)
         FILTER (WHERE status_code IS NOT NULL)          AS status_codes
     FROM request_traces
     WHERE run_id = $1
     GROUP BY test_id
     ORDER BY min(seq)`,
    [runId],
  );

  return rows.map((row) => ({
    testId: row.test_id,
    probes: Number(row.probes),
    passed: Number(row.passed),
    blocked: Number(row.blocked),
    bypassed: Number(row.bypassed),
    errors: Number(row.errors),
    firstBlockedIteration: row.first_blocked,
    firstBypassedIteration: row.first_bypassed,
    firstErrorIteration: row.first_error,
    firstStatusCode: row.first_status,
    lastStatusCode: row.last_status,
    statusCodes: row.status_codes ?? [],
  }));
}

/**
 * The platform path a run actually took.
 *
 * A run can traverse more than one edge (DNS rotation, a mid-run failover), so
 * this returns every distinct path seen with how many probes used it, most
 * common first. Reporting only the first would hide a failover.
 */
export async function runPlatforms(
  runId: string,
): Promise<Array<{ summary: string; probes: number }>> {
  const { rows } = await query<{ platform_summary: string; probes: string }>(
    `SELECT platform_summary, count(*)::text AS probes
       FROM request_traces
      WHERE run_id = $1 AND platform_summary IS NOT NULL
      GROUP BY platform_summary
      ORDER BY count(*) DESC`,
    [runId],
  );
  return rows.map((row) => ({ summary: row.platform_summary, probes: Number(row.probes) }));
}

export async function countTraces(runId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM request_traces WHERE run_id = $1`,
    [runId],
  );
  return Number(rows[0]?.count ?? 0);
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

export async function insertFindings(
  runId: string,
  findings: Array<FindingDraft & { id: string }>,
): Promise<void> {
  if (findings.length === 0) return;

  const columns = 9;
  const tuples: string[] = [];
  const values: unknown[] = [];

  for (const f of findings) {
    const offset = values.length;
    const p = Array.from({ length: columns }, (_, i) => `$${offset + i + 1}`);
    tuples.push(`(${p.join(', ')})`);
    values.push(
      f.id ?? randomUUID(),
      runId,
      f.testId,
      f.title,
      f.severity,
      f.verdict,
      f.description,
      f.evidence,
      f.remediation,
    );
  }

  await query(
    `INSERT INTO findings (id, run_id, test_id, title, severity, verdict, description, evidence, remediation)
     VALUES ${tuples.join(', ')}`,
    values,
  );

  // trace_ids is populated separately so a finding can cite probe sequence numbers.
  for (const f of findings) {
    if (f.traceSeqs.length === 0) continue;
    await query(
      `UPDATE findings SET trace_ids = (
         SELECT COALESCE(array_agg(id), '{}') FROM request_traces
         WHERE run_id = $1 AND seq = ANY($2::int[])
       ), refs = $3::text[] WHERE id = $4`,
      [runId, f.traceSeqs, f.references, f.id],
    );
  }
}

export async function getFindings(runId: string): Promise<Finding[]> {
  const { rows } = await query<{
    id: string;
    run_id: string;
    test_id: string;
    title: string;
    severity: Severity;
    verdict: Verdict;
    description: string;
    evidence: string;
    remediation: string;
    trace_ids: string[];
    refs: string[];
  }>(`SELECT * FROM findings WHERE run_id = $1`, [runId]);

  return rows
    .map((row) => ({
      id: row.id,
      runId: row.run_id,
      testId: row.test_id as TestId,
      title: row.title,
      severity: row.severity,
      verdict: row.verdict,
      description: row.description,
      evidence: row.evidence,
      remediation: row.remediation,
      traceIds: (row.trace_ids ?? []).map(String),
      references: row.refs ?? [],
    }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/* ------------------------------------------------------------------ *
 * RunStore implementation used by the engine
 * ------------------------------------------------------------------ */

export const runStore: RunStore = {
  insertTraces,
  insertFindings,

  async markStarted(runId: string, startedAt: Date): Promise<void> {
    await query(`UPDATE runs SET status = 'running', started_at = $2 WHERE id = $1`, [runId, startedAt]);
  },

  async markProgress(runId: string, patch: Partial<RunRecord>): Promise<void> {
    if (patch.summary) {
      await query(`UPDATE runs SET summary = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(patch.summary)]);
    }
  },

  async markFinished(runId: string, patch: Partial<RunRecord>): Promise<void> {
    await query(
      `UPDATE runs
       SET status = $2, duration_ms = $3, finished_at = $4, summary = $5::jsonb, error = $6
       WHERE id = $1`,
      [
        runId,
        patch.status ?? 'success',
        patch.durationMs ?? null,
        patch.finishedAt ?? new Date().toISOString(),
        JSON.stringify(patch.summary ?? null),
        patch.error ?? null,
      ],
    );
  },

  async chargeCredits(runId: string, userId: string, credits: number): Promise<void> {
    if (credits <= 0) return;
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO credit_ledger (user_id, delta, reason, run_id) VALUES ($1, $2, 'run', $3)`,
        [userId, -credits, runId],
      );
    });
  },
};

/* ------------------------------------------------------------------ *
 * Users & credits
 * ------------------------------------------------------------------ */

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: string;
  credits_total: number;
  language: string;
  status: string;
  token_version: number;
  requested_at: Date | null;
  approved_at: Date | null;
  note: string | null;
}

export async function getUserByEmail(
  email: string,
): Promise<(UserAccount & { passwordHash: string }) | null> {
  const { rows } = await query<UserRow>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
  const row = rows[0];
  if (!row) return null;
  const account = await withCredits(row);
  return { ...account, passwordHash: row.password_hash };
}

export async function getUserById(id: string): Promise<UserAccount | null> {
  const { rows } = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  return withCredits(row);
}

/** Attach a reconciled credit position to a user row. */
async function withCredits(row: UserRow): Promise<UserAccount> {
  const position = await creditPosition(row.id, row.credits_total);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as UserAccount['role'],
    status: (row.status ?? 'active') as UserAccount['status'],
    tokenVersion: row.token_version ?? 0,
    creditsUsed: position.used,
    creditsRemaining: position.remaining,
    language: row.language as UserAccount['language'],
    requestedAt: row.requested_at ? row.requested_at.toISOString() : undefined,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
  };
}

/**
 * Reconcile a user's credit position from the ledger.
 *
 * Remaining is the opening allowance *plus every ledger movement*, not
 * `total - charges`. Computing it the second way silently discards grants:
 * an admin approving a credit request would see the balance never move.
 */
async function creditPosition(
  userId: string,
  allowance: number,
): Promise<{ used: number; granted: number; remaining: number }> {
  const { rows } = await query<{ used: string; granted: string }>(
    `SELECT
       COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0)::text AS used,
       COALESCE( SUM(delta) FILTER (WHERE delta > 0), 0)::text AS granted
     FROM credit_ledger WHERE user_id = $1`,
    [userId],
  );
  const used = Number(rows[0]?.used ?? 0);
  const granted = Number(rows[0]?.granted ?? 0);
  return { used, granted, remaining: Math.max(0, allowance + granted - used) };
}

export async function setUserLanguage(id: string, language: 'en' | 'zh'): Promise<void> {
  await query(`UPDATE users SET language = $2 WHERE id = $1`, [id, language]);
}

export interface CreditRequest {
  id: string;
  userId: string;
  requestedAt: string;
}

/**
 * Raise a credit request. The reference UI states the admin receives an email;
 * this records the request and (when SMTP is configured) notifies, otherwise it
 * is visible to admins through the API.
 */
export async function requestCredits(user: UserAccount): Promise<CreditRequest> {
  const id = randomUUID();
  await query(
    `INSERT INTO credit_ledger (user_id, delta, reason) VALUES ($1, 0, $2)`,
    [user.id, `credit-request:${id}`],
  );
  return { id, userId: user.id, requestedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ *
 * Access control — invitation only
 * ------------------------------------------------------------------ */

export interface RegistrationRequest {
  email: string;
  displayName: string;
  password: string;
  note?: string;
}

export type RegisterOutcome =
  | { ok: true }
  | { ok: false; reason: 'exists' | 'closed' };

/**
 * Create a pending account.
 *
 * The account cannot sign in until an administrator approves it. The password
 * is hashed immediately so the plaintext never rests in the database while the
 * request is pending.
 */
export async function createRegistrationRequest(
  input: RegistrationRequest,
): Promise<RegisterOutcome> {
  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM users WHERE lower(email) = lower($1)`,
    [input.email],
  );
  if (existing.rows.length > 0) {
    // An existing pending request is not an error worth revealing in detail.
    return { ok: false, reason: 'exists' };
  }

  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(input.password, salt, 64).toString('hex');
  const passwordHash = `scrypt$${salt}$${derived}`;

  await query(
    `INSERT INTO users (id, email, display_name, password_hash, role, credits_total, status, note)
     VALUES ($1, $2, $3, $4, 'operator', 100, 'pending', $5)`,
    [randomUUID(), input.email, input.displayName, passwordHash, input.note ?? null],
  );
  return { ok: true };
}

/** Accounts awaiting approval, oldest first. */
export async function listPendingUsers(): Promise<UserAccount[]> {
  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE status = 'pending' ORDER BY requested_at ASC`,
  );
  return Promise.all(rows.map((row) => withCredits(row)));
}

export async function listAllUsers(): Promise<UserAccount[]> {
  const { rows } = await query<UserRow>(`SELECT * FROM users ORDER BY requested_at ASC`);
  return Promise.all(rows.map((row) => withCredits(row)));
}

/** Approve a pending request. */
export async function approveUser(id: string, adminId: string): Promise<boolean> {
  const result = await query(
    `UPDATE users SET status = 'active', approved_by = $2, approved_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, adminId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Reject a pending request by removing it outright. */
export async function rejectUser(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM users WHERE id = $1 AND status = 'pending'`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Suspend or reinstate an account.
 *
 * Suspension takes effect on the next request rather than waiting for a token
 * to expire, because every authenticated request re-checks `status`.
 */
export async function setUserStatus(
  id: string,
  status: 'active' | 'suspended',
): Promise<boolean> {
  const result = await query(`UPDATE users SET status = $2 WHERE id = $1`, [id, status]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke every token an operator currently holds.
 *
 * This is what makes a non-expiring token recoverable: the version claim in an
 * issued JWT stops matching, so the next request from that token is rejected.
 */
export async function revokeUserTokens(id: string): Promise<number> {
  const { rows } = await query<{ token_version: number }>(
    `UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`,
    [id],
  );
  return rows[0]?.token_version ?? 0;
}

/* ------------------------------------------------------------------ *
 * Saved configs
 * ------------------------------------------------------------------ */

export async function saveConfig(
  userId: string,
  testId: TestId,
  name: string,
  config: AttackConfig,
): Promise<{ id: string }> {
  const id = randomUUID();
  await query(
    `INSERT INTO saved_configs (id, user_id, test_id, name, config) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, userId, testId, name, JSON.stringify(config)],
  );
  return { id };
}

export async function listSavedConfigs(userId: string): Promise<Array<{ id: string; testId: string; name: string; config: AttackConfig; updatedAt: string }>> {
  const { rows } = await query<{ id: string; test_id: string; name: string; config: AttackConfig; updated_at: Date }>(
    `SELECT id, test_id, name, config, updated_at FROM saved_configs WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    testId: r.test_id,
    name: r.name,
    config: r.config,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export { pool };
