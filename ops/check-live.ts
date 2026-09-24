/**
 * Live behavioural checks against a running stack.
 *
 *   source env.sh && npx tsx ops/check-live.ts
 *
 * These are the checks that cannot be unit tested, because they assert what the
 * *target* observed and what the *ledger* recorded — not what a function
 * returned. Everything here needs the API on :8787 and the fixtures on
 * :9900/:9901 (see `ops/stack.sh start`).
 *
 * The distinctions being guarded:
 *
 *   * charges follow traffic, not intent — a run costs credits for the tests
 *     that actually emitted a request, and nothing for a rejected submission;
 *   * the rate ceiling in the server config is real, so a config that asks for
 *     2000 rps gets the cap and is told so;
 *   * recorded evidence is the bytes that left the machine — the User-Agent in
 *     the trace is the one the fixture received.
 */

import { buildDefaultConfig, type AttackConfig, type TestId } from '@teo/shared';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const FIXTURE = process.env.FIXTURE_URL ?? 'http://127.0.0.1:9900';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  \u001b[32m✔\u001b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \u001b[31m✖\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\u001b[1m▶ ${title}\u001b[0m`);
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

interface Json<T> {
  status: number;
  body: T | null;
}

let auth: Record<string, string> = {};

async function json<T>(res: Response): Promise<Json<T>> {
  return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
}

async function get<T>(path: string): Promise<Json<T>> {
  return json<T>(await fetch(`${API}${path}`, { headers: auth }));
}

async function post<T>(path: string, body?: unknown): Promise<Json<T>> {
  return json<T>(
    await fetch(`${API}${path}`, {
      method: 'POST',
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

interface RunView {
  run: {
    id: string;
    status: string;
    creditsUsed: number;
    error: string | null;
    summary: Record<string, unknown> | null;
  };
}

/** Submit one config and wait for the run to settle. */
async function runOnce(config: AttackConfig, label: string): Promise<RunView['run'] | null> {
  const submitted = await post<{ run: { id: string } }>('/api/runs', {
    configs: [{ ...config, id: `cfg-${label}` }],
    mode: 'single',
    device: 'check-live',
    platform: 'node',
  });
  if (submitted.status !== 201 || !submitted.body) {
    console.log(`    (submit failed HTTP ${submitted.status}: ${JSON.stringify(submitted.body).slice(0, 200)})`);
    return null;
  }
  const id = submitted.body.run.id;
  for (let i = 0; i < 240; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    const current = await get<RunView>(`/api/runs/${id}`);
    const settled = current.body?.run;
    if (settled && settled.status !== 'running' && settled.status !== 'queued') return settled;
  }
  return null;
}

/** A config built exactly the way the app builds one. */
function configFor(
  testId: TestId,
  values: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
  domain = FIXTURE,
): AttackConfig {
  const base = buildDefaultConfig(testId, domain);
  return {
    ...base,
    values: { ...base.values, ...values },
    options: { ...base.options, ...options },
  } as AttackConfig;
}

function metricsOf(run: RunView['run']): Record<string, unknown> {
  const tests = (run.summary?.tests as Array<{ metrics: Record<string, unknown> }> | undefined) ?? [];
  return tests[0]?.metrics ?? {};
}

interface Trace {
  method: string;
  url: string;
  request_headers: Record<string, string>;
  status_code: number | null;
}

interface FixtureEntry {
  path: string;
  userAgent: string;
  rawHeaders: string[];
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const uaOf = (headers: Record<string, string>): string | undefined =>
  Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SEED_USER_EMAIL ?? 'operator@example.com',
      password: process.env.SEED_USER_PASSWORD ?? 'edgeone',
    }),
  });
  if (!login.ok) {
    console.error(`login failed (HTTP ${login.status}): ${await login.text()}`);
    process.exit(1);
  }
  const { token } = (await login.json()) as { token: string };
  auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const me = async (): Promise<{ id: string; creditsUsed: number; creditsRemaining: number }> => {
    const res = await get<{ id: string; creditsUsed: number; creditsRemaining: number }>('/api/credits');
    if (!res.body) throw new Error('could not read credit position');
    return res.body;
  };

  const meResponse = await get<{ id: string; email: string; displayName: string }>('/api/auth/me');
  const operator = meResponse.body;
  if (!operator) throw new Error('could not read the signed-in account');
  console.log(`  operator: ${operator.displayName} <${operator.email}>`);

  const creditsBefore = await me();
  console.log(`  starting balance: used ${creditsBefore.creditsUsed}, remaining ${creditsBefore.creditsRemaining}`);

  /* ---------------- rate ceiling ---------------- */
  section('load tests honour the server rate ceiling');

  // 20 threads x one request every 10ms asks for 2000 rps; the run is capped at 30.
  const spike = await runOnce(
    configFor(
      'http_spike',
      { 'spike.burst': 120, 'spike.threads': 20, 'spike.interval': 10, 'spike.duration': 30 },
      { timeoutMs: 5000, maxRequests: 200, maxConcurrency: 20, maxRps: 30 },
    ),
    'spike-capped',
  );
  if (!spike) {
    check('spike run settled', false, 'no result before timeout');
  } else {
    const m = metricsOf(spike);
    const achieved = Number(spike.summary?.achievedRps ?? 0);
    console.log(
      `    status=${spike.status} probes=${String(spike.summary?.totalProbes)} achievedRps=${achieved} ` +
        `requested=${String(m.requestedRps)} target=${String(m.targetRps)}`,
    );
    check('spike completed', spike.status === 'success', String(spike.error));
    check('the requested rate is reported as configured', m.requestedRps === 2000, String(m.requestedRps));
    check('the clamp is reported', m.targetRps === 30 && m.rateCappedByServerLimit === true, JSON.stringify(m.targetRps));
    check('achieved rate respects the ceiling', achieved > 0 && achieved <= 45, `${achieved} rps against a 30 rps cap`);
  }

  // 10 connections at 40 rps is 40 rps in total, not 400.
  const flood = await runOnce(
    configFor(
      'connection_flood',
      { 'flood.connections': 10, 'flood.duration': 6, 'flood.rps': 40 },
      { timeoutMs: 5000, maxRequests: 400, maxConcurrency: 20, maxRps: 400 },
    ),
    'flood-paced',
  );
  if (!flood) {
    check('flood run settled', false, 'no result before timeout');
  } else {
    const m = metricsOf(flood);
    const achieved = Number(flood.summary?.achievedRps ?? 0);
    console.log(`    status=${flood.status} probes=${String(flood.summary?.totalProbes)} achievedRps=${achieved} established=${String(m.connectionsEstablished)}`);
    check('flood completed', flood.status === 'success', String(flood.error));
    check('connections were established', Number(m.connectionsEstablished ?? 0) >= 5, String(m.connectionsEstablished));
    check('the rate is for the whole test, not per connection', achieved > 0 && achieved <= 70, `${achieved} rps against a 40 rps target`);
  }

  /* ---------------- evidence fidelity ---------------- */
  section('recorded evidence is what the target received');

  await fetch(`${FIXTURE}/_reset`);
  const crawl = configFor(
    'web_crawler',
    { 'crawl.depth': 2, 'crawl.max_pages': 12, 'crawl.delay': 20, 'crawl.respect_robots': 'no' },
    { timeoutMs: 6000, maxRequests: 12, maxConcurrency: 2, maxRps: 20 },
  );
  const crawlRun = await runOnce(crawl, 'crawler-evidence');
  check('crawl completed', crawlRun?.status === 'success', String(crawlRun?.error));

  if (crawlRun) {
    const { traces } = (await get<{ traces: Trace[] }>(`/api/runs/${crawlRun.id}/traces?limit=200`)).body ?? { traces: [] };
    const { requests } = (await (await fetch(`${FIXTURE}/_log`)).json()) as { requests: FixtureEntry[] };

    let compared = 0;
    const mismatched: string[] = [];
    for (const trace of traces) {
      const seen = requests.find((r) => r.path === pathOf(trace.url));
      if (!seen) continue;
      compared += 1;
      const recorded = uaOf(trace.request_headers ?? {});
      if (recorded !== seen.userAgent) {
        mismatched.push(`${pathOf(trace.url)}: recorded "${String(recorded)}" vs observed "${seen.userAgent}"`);
      }
    }
    console.log(`    ${traces.length} traces, ${requests.length} requests observed, ${compared} compared header-for-header`);
    check('the crawl produced traces', traces.length > 0, String(traces.length));
    check('traces could be matched to observed requests', compared > 0, String(compared));
    check('the recorded User-Agent is the one the target received', mismatched.length === 0, mismatched.slice(0, 3).join(' | '));

    // Built from the signed-in account rather than a hardcoded name, so the
    // check is about *this* operator's identity and the file carries no
    // personal data.
    const needles = [operator.displayName, operator.email, operator.email.split('@')[0] ?? '']
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length >= 3);
    const leaked = requests.filter((r) => {
      const haystack = `${r.userAgent} ${r.rawHeaders.join(' ')}`.toLowerCase();
      return needles.some((needle) => haystack.includes(needle));
    });
    check('no operator identity reached the target', leaked.length === 0, leaked.slice(0, 2).map((l) => l.userAgent).join(' | '));
  }

  section('browser anonymity either rotates or says it cannot');

  /**
   * The catalog's crawler default pins its own User-Agent, and a config header
   * deliberately wins over the profile. So the honest outcome with that default
   * is "no rotation" — and the trace must not claim otherwise. Removing the
   * pinned header must produce real rotation.
   */
  const crawlWith = async (pinned: boolean): Promise<{ traces: Trace[]; uas: Set<string | undefined>; mismatches: number } | null> => {
    await fetch(`${FIXTURE}/_reset`);
    const base = buildDefaultConfig('web_crawler', FIXTURE);
    const headers = (base.http.headers ?? []).filter((h) => pinned || h.key?.toLowerCase() !== 'user-agent');
    const config = {
      ...configFor(
        'web_crawler',
        { 'crawl.depth': 2, 'crawl.max_pages': 20, 'crawl.delay': 20, 'crawl.respect_robots': 'no' },
        { timeoutMs: 6000, maxRequests: 20, maxConcurrency: 1, maxRps: 20, anonymity: 'browser' },
      ),
      http: { ...base.http, headers },
    };

    const run = await runOnce(config, pinned ? 'crawler-pinned' : 'crawler-free');
    if (!run) return null;
    const { traces } = (await get<{ traces: Trace[] }>(`/api/runs/${run.id}/traces?limit=200`)).body ?? { traces: [] };
    const { requests } = (await (await fetch(`${FIXTURE}/_log`)).json()) as { requests: FixtureEntry[] };
    const uas = new Set(traces.map((t) => uaOf(t.request_headers ?? {})));
    const mismatches = traces.filter((t) => {
      const seen = requests.find((r) => r.path === pathOf(t.url));
      return seen ? uaOf(t.request_headers ?? {}) !== seen.userAgent : false;
    }).length;
    return { traces, uas, mismatches };
  };

  const pinnedResult = await crawlWith(true);
  check('crawl with a pinned User-Agent ran', (pinnedResult?.traces.length ?? 0) > 0);
  if (pinnedResult) {
    console.log(`    pinned User-Agent: ${pinnedResult.traces.length} traces, ${pinnedResult.uas.size} distinct User-Agent(s)`);
    check('a pinned User-Agent is recorded truthfully', pinnedResult.mismatches === 0, `${pinnedResult.mismatches} mismatch(es)`);
  }

  const freeResult = await crawlWith(false);
  check('crawl without a pinned User-Agent ran', (freeResult?.traces.length ?? 0) > 0);
  if (freeResult) {
    console.log(`    no pinned User-Agent: ${freeResult.traces.length} traces, ${freeResult.uas.size} distinct User-Agent(s)`);
    check(
      'browser mode rotates once the config stops pinning a User-Agent',
      freeResult.uas.size > 1,
      `${freeResult.uas.size} profile(s) across ${freeResult.traces.length} requests`,
    );
    check('rotated requests are recorded truthfully', freeResult.mismatches === 0, `${freeResult.mismatches} mismatch(es)`);
  }

  /* ---------------- credits ---------------- */
  section('charges follow traffic');

  const afterRuns = await me();
  console.log(`    after ${4} runs: used ${afterRuns.creditsUsed}, remaining ${afterRuns.creditsRemaining}`);
  check('the runs were charged', afterRuns.creditsUsed > creditsBefore.creditsUsed, `${creditsBefore.creditsUsed} → ${afterRuns.creditsUsed}`);

  const invalid = await post('/api/runs', {
    configs: [{ id: 'cfg-broken', testId: 'idor_enumeration', target: { domain: FIXTURE }, values: {}, options: {} }],
    mode: 'single',
  });
  check('a structurally invalid config is rejected at submit', invalid.status === 422, `HTTP ${invalid.status}`);

  const afterInvalid = await me();
  check(
    'a rejected submission costs nothing',
    afterInvalid.creditsRemaining === afterRuns.creditsRemaining,
    `${afterRuns.creditsRemaining} → ${afterInvalid.creditsRemaining}`,
  );

  section('top-up requests reach an administrator');

  const requested = await post<{ id: string }>('/api/credits/request', { note: 'check-live' });
  check('a top-up request is accepted', requested.status === 200 && typeof requested.body?.id === 'string');
  const requestId = requested.body?.id;

  const queue = await get<{ requests: Array<{ id: string; email: string; displayName: string; note: string | null }> }>(
    '/api/admin/credit-requests',
  );
  const mine = (queue.body?.requests ?? []).find((r) => r.id === requestId);
  check('an administrator can see the request', queue.status === 200 && mine !== undefined);
  check('the queue row identifies the requester', Boolean(mine?.email && mine?.displayName), JSON.stringify(mine ?? {}));

  const beforeGrant = await me();
  const granted = await post<{ granted: number; requestsResolved: number; user: { creditsRemaining: number } }>(
    `/api/admin/users/${beforeGrant.id}/credits`,
    { credits: 25, note: 'check-live' },
  );
  check('an administrator can grant credits', granted.status === 200, `HTTP ${granted.status}`);
  check('the grant reports what it did', granted.body?.granted === 25 && (granted.body?.requestsResolved ?? 0) >= 1);
  check(
    'the balance rises by exactly the granted amount',
    granted.body?.user.creditsRemaining === beforeGrant.creditsRemaining + 25,
    `${beforeGrant.creditsRemaining} → ${granted.body?.user.creditsRemaining}`,
  );

  const afterQueue = await get<{ requests: Array<{ id: string }> }>('/api/admin/credit-requests');
  check('the request leaves the pending queue', !(afterQueue.body?.requests ?? []).some((r) => r.id === requestId));
  const allQueue = await get<{ requests: Array<{ id: string; resolvedAt: string | null }> }>(
    '/api/admin/credit-requests?includeResolved=true',
  );
  check('the resolved request stays auditable', (allQueue.body?.requests ?? []).some((r) => r.id === requestId && r.resolvedAt));

  section('malformed input is refused, not guessed at');

  check('a zero grant is refused', (await post(`/api/admin/users/${beforeGrant.id}/credits`, { credits: 0 })).status === 400);
  check(
    'an oversized grant is refused',
    (await post(`/api/admin/users/${beforeGrant.id}/credits`, { credits: 9_999_999 })).status === 400,
  );
  check(
    'an unknown user is a 404',
    (await post('/api/admin/users/00000000-0000-4000-8000-0000000000ff/credits', { credits: 5 })).status === 404,
  );
  check('an unknown category filter is refused', (await get('/api/history?categories=not_a_category')).status === 400);
  check('a valid category filter is accepted', (await get('/api/history?categories=dos_protection')).status === 200);

  console.log(
    `\n${fail === 0 ? '\u001b[32mALL LIVE CHECKS PASSED\u001b[0m' : `\u001b[31m${fail} LIVE CHECK(S) FAILED\u001b[0m`} — ${pass} passed, ${fail} failed\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
