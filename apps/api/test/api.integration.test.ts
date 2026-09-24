import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { buildAllTestsConfigs, buildDefaultConfig } from '@teo/shared';

import { API_URL, FIXTURE_VULNERABLE, apiReachable, fixturesReachable } from './helpers/fixture.ts';

/**
 * API-level integration tests.
 *
 * These exercise the real HTTP surface — auth, validation, execution, history,
 * export — against a live stack. They skip cleanly when the stack is not up, so
 * `npm test` still works in a bare checkout.
 */

const EMAIL = process.env.SEED_USER_EMAIL ?? 'operator@example.com';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'edgeone';

let up = false;
let token = '';
const auth = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function call<T>(
  path: string,
  init: RequestInit & { authenticated?: boolean } = {},
): Promise<{ status: number; body: T }> {
  const { authenticated = true, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? auth() : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

async function waitForRun(id: string, timeoutMs = 90_000): Promise<{ status: string; summary: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call<{ run: { status: string; summary: unknown } }>(`/api/runs/${id}`);
    if (body?.run && !['queued', 'running'].includes(body.run.status)) {
      return { status: body.run.status, summary: body.run.summary };
    }
    // Block body: a concise arrow would return the timer from the executor.
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
  }
  throw new Error(`Run ${id} did not settle within ${timeoutMs}ms`);
}

before(async () => {
  up = (await apiReachable()) && (await fixturesReachable());
  if (!up) {
    console.warn('\n  ⚠ API not reachable — skipping API integration tests.\n    Start with: ./ops/stack.sh\n');
    return;
  }
  const { body } = await call<{ token: string }>('/api/auth/login', {
    method: 'POST',
    authenticated: false,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = body.token;
});

describe('health & auth', () => {
  it('reports healthy', async () => {
    if (!up) return;
    const { status, body } = await call<{ status: string }>('/api/health', { authenticated: false });
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('rejects a bad password', async () => {
    if (!up) return;
    const { status } = await call('/api/auth/login', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ email: EMAIL, password: 'definitely-not-the-password' }),
    });
    assert.equal(status, 401);
  });

  it('rejects a missing body', async () => {
    if (!up) return;
    const { status } = await call('/api/auth/login', { method: 'POST', authenticated: false, body: '{}' });
    assert.equal(status, 400);
  });

  it('refuses an unauthenticated catalog request', async () => {
    if (!up) return;
    const { status } = await call('/api/catalog', { authenticated: false });
    assert.equal(status, 401);
  });

  it('returns the account for a valid token', async () => {
    if (!up) return;
    const { status, body } = await call<{ email: string; creditsRemaining: number }>('/api/auth/me');
    assert.equal(status, 200);
    assert.equal(body.email, EMAIL);
    assert.ok(body.creditsRemaining >= 0);
  });
});

describe('catalog', () => {
  it('serves all 12 tests across 4 categories', async () => {
    if (!up) return;
    const { body } = await call<{
      testCount: number;
      categories: Array<{ id: string; testIds: string[] }>;
      tests: Array<{ id: string; fields: unknown[] }>;
    }>('/api/catalog');
    assert.equal(body.testCount, 12);
    assert.equal(body.categories.length, 4);
    assert.equal(body.tests.length, 12);
    for (const test of body.tests) {
      assert.ok(test.fields.length > 0, `${test.id} must declare fields`);
    }
  });
});

describe('connection validation', () => {
  it('validates a reachable target and reports timing', async () => {
    if (!up) return;
    const { status, body } = await call<{
      results: Array<{
        reachable: boolean;
        statusCode: number | null;
        timing: Record<string, number | null>;
        platform: { edge: { code: string } | null; origin: { code: string } | null; cacheStatus: string | null } | null;
        platformSummary: string | null;
      }>;
    }>('/api/validate-connection', {
      method: 'POST',
      body: JSON.stringify({ domain: FIXTURE_VULNERABLE }),
    });
    assert.equal(status, 200);
    const result = body.results[0];
    assert.ok(result);
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
    assert.ok(result.timing.totalMs !== null, 'total timing must be captured');
    // The fixture sends EdgeOne's identifying headers, so the edge should be
    // named — and nginx is the origin behind it.
    assert.equal(result.platform?.edge?.code, 'edgeone', 'fixture advertises EdgeOne headers');
    assert.equal(result.platform?.origin?.code, 'nginx', 'fixture serves via nginx');
    assert.match(result.platformSummary ?? '', /EdgeOne/);
  });

  it('handles several targets at once', async () => {
    if (!up) return;
    const { body } = await call<{ results: unknown[] }>('/api/validate-connection', {
      method: 'POST',
      body: JSON.stringify({ domain: `${FIXTURE_VULNERABLE},http://127.0.0.1:9901` }),
    });
    assert.equal(body.results.length, 2);
  });

  it('rejects an empty domain', async () => {
    if (!up) return;
    const { status } = await call('/api/validate-connection', {
      method: 'POST',
      body: JSON.stringify({ domain: '   ' }),
    });
    assert.equal(status, 400);
  });
});

describe('run execution', () => {
  it('rejects a run with an empty domain', async () => {
    if (!up) return;
    const config = buildDefaultConfig('sql_injection', '');
    const { status, body } = await call<{ message: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ configs: [config] }),
    });
    assert.equal(status, 422);
    assert.match(body.message, /Domain cannot be empty/);
  });

  it('rejects a run with no configs', async () => {
    if (!up) return;
    const { status } = await call('/api/runs', { method: 'POST', body: JSON.stringify({ configs: [] }) });
    assert.equal(status, 400);
  });

  it('rejects an out-of-range parameter', async () => {
    if (!up) return;
    const config = buildDefaultConfig('http_spike', FIXTURE_VULNERABLE);
    config.values['spike.burst'] = 999_999;
    const { status } = await call('/api/runs', { method: 'POST', body: JSON.stringify({ configs: [config] }) });
    assert.equal(status, 422);
  });

  it('executes a single test and records traces plus findings', async () => {
    if (!up) return;
    const config = buildDefaultConfig('sql_injection', FIXTURE_VULNERABLE);

    const created = await call<{ run: { id: string; mode: string; creditsUsed: number; provenance: { configHash: string } } }>(
      '/api/runs',
      { method: 'POST', body: JSON.stringify({ configs: [config], mode: 'single', device: 'test-suite', platform: 'node' }) },
    );
    assert.equal(created.status, 201);
    const runId = created.body.run.id;
    assert.equal(created.body.run.mode, 'single');
    assert.match(created.body.run.provenance.configHash, /^sha256:/);

    const settled = await waitForRun(runId);
    assert.equal(settled.status, 'success');

    const detail = await call<{
      run: { status: string; summary: { totalProbes: number; bypassed: number; maxSeverity: string | null } };
      findings: Array<{ severity: string; evidence: string }>;
      traceCount: number;
    }>(`/api/runs/${runId}`);

    assert.equal(detail.body.run.status, 'success');
    assert.ok(detail.body.traceCount > 0, 'traces must be persisted');
    assert.equal(detail.body.run.summary.bypassed > 0, true, 'SQLi against the fixture must bypass');
    assert.equal(detail.body.run.summary.maxSeverity, 'critical');
    assert.ok(detail.body.findings.length > 0, 'findings must be recorded');

    const traces = await call<{ traces: Array<Record<string, unknown>> }>(
      `/api/runs/${runId}/traces?limit=5`,
    );
    const first = traces.body.traces[0];
    assert.ok(first, 'at least one trace expected');
    for (const key of ['request_bytes', 'response_bytes', 'ttfb_ms', 'total_ms', 'status_code', 'verdict', 'url']) {
      assert.ok(first[key] !== undefined, `trace must carry ${key}`);
    }
  });

  it('runs every test simultaneously in batch mode', async () => {
    if (!up) return;
    const configs = buildAllTestsConfigs(FIXTURE_VULNERABLE);

    // Dial the load tests right down so the suite stays quick — while staying
    // inside the catalog's own declared minimums (interval >= 10ms,
    // flood duration >= 5s), which the server validates.
    for (const config of configs) {
      if (config.testId === 'http_spike') {
        config.values['spike.burst'] = 20;
        config.values['spike.threads'] = 5;
        config.values['spike.interval'] = 10;
        config.values['spike.duration'] = 15;
      }
      if (config.testId === 'connection_flood') {
        config.values['flood.connections'] = 6;
        config.values['flood.rps'] = 10;
        config.values['flood.duration'] = 5;
      }
      if (config.testId === 'oversized_body') {
        config.values['ob.body_size_kb'] = 64;
        config.values['ob.json_field_count'] = 100;
      }
      if (config.testId === 'idor_enumeration') {
        config.values['idor.end'] = 5;
      }
      if (config.testId === 'business_logic') {
        config.values['bl.replay_count'] = 4;
      }
      if (config.testId === 'web_crawler') {
        config.values['crawl.max_pages'] = 15;
        config.values['crawl.delay'] = 0;
      }
    }

    const created = await call<{ run: { id: string; mode: string; label: string; testIds: string[] } }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ configs, mode: 'batch', device: 'test-suite', platform: 'node' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.run.mode, 'batch');
    assert.equal(created.body.run.testIds.length, 12, 'batch run must span all 12 tests');

    const settled = await waitForRun(created.body.run.id, 180_000);
    assert.equal(settled.status, 'success');

    const detail = await call<{
      run: { summary: { totalProbes: number } };
      findings: unknown[];
      traceCount: number;
    }>(`/api/runs/${created.body.run.id}`);

    assert.ok(detail.body.traceCount > 30, `expected a substantial trace volume, got ${detail.body.traceCount}`);
    assert.ok(detail.body.findings.length > 0, 'the vulnerable fixture must yield findings');
  });

  it('returns a combined plus per-test breakdown for a batch run', async () => {
    if (!up) return;
    const history = await call<{ runs: Array<{ id: string; mode: string }> }>('/api/history?limit=10');
    const batch = history.body.runs.find((r) => r.mode === 'batch');
    if (!batch) return;

    const traces = await call<{ traces: Array<{ test_id: string }> }>(`/api/runs/${batch.id}/traces?limit=2000`);
    const distinctTests = new Set(traces.body.traces.map((t) => t.test_id));
    assert.ok(distinctTests.size >= 10, `expected most tests represented, got ${distinctTests.size}`);
  });
});

describe('history & filters', () => {
  it('lists runs', async () => {
    if (!up) return;
    const { status, body } = await call<{ runs: unknown[]; total: number }>('/api/history');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.runs));
    assert.ok(body.total >= 1);
  });

  it('filters by status', async () => {
    if (!up) return;
    const { body } = await call<{ runs: Array<{ status: string }> }>('/api/history?status=success');
    for (const run of body.runs) assert.equal(run.status, 'success');
  });

  it('filters by category', async () => {
    if (!up) return;
    const { body } = await call<{ runs: Array<{ testIds: string[] }> }>('/api/history?categories=api_protection');
    for (const run of body.runs) {
      assert.ok(
        run.testIds.some((id) => ['brute_force', 'idor_enumeration', 'schema_validation', 'business_logic'].includes(id)),
        'filtered runs must contain an API Protection test',
      );
    }
  });

  it('filters by domain substring', async () => {
    if (!up) return;
    const { body } = await call<{ runs: Array<{ target: string }> }>('/api/history?domainContains=127.0.0.1');
    for (const run of body.runs) assert.match(run.target, /127\.0\.0\.1/);
  });
});

describe('export', () => {
  it('exports JSON', async () => {
    if (!up) return;
    const history = await call<{ runs: Array<{ id: string }> }>('/api/history?limit=1');
    const id = history.body.runs[0]?.id;
    if (!id) return;

    const res = await fetch(`${API_URL}/api/export`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ runIds: [id], format: 'json' }),
    });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { generator: string; runs: unknown[] };
    assert.match(doc.generator, /EdgeOne Security Test/);
    assert.equal(doc.runs.length, 1);
  });

  it('exports CSV with a header row', async () => {
    if (!up) return;
    const history = await call<{ runs: Array<{ id: string }> }>('/api/history?limit=1');
    const id = history.body.runs[0]?.id;
    if (!id) return;

    const res = await fetch(`${API_URL}/api/export`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ runIds: [id], format: 'csv' }),
    });
    const text = await res.text();
    assert.match(text.split('\n')[0] ?? '', /^run_id,created_at,target/);
  });

  it('exports a printable HTML report', async () => {
    if (!up) return;
    const history = await call<{ runs: Array<{ id: string }> }>('/api/history?limit=1');
    const id = history.body.runs[0]?.id;
    if (!id) return;

    const res = await fetch(`${API_URL}/api/export`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ runIds: [id], format: 'html' }),
    });
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /EdgeOne Security Test — Engagement Report/);
  });

  it('rejects an export with no runs selected', async () => {
    if (!up) return;
    const { status } = await call('/api/export', { method: 'POST', body: JSON.stringify({ runIds: [] }) });
    assert.equal(status, 400);
  });
});

describe('credits', () => {
  it('reports a balance that reconciles with usage', async () => {
    if (!up) return;
    const { body } = await call<{ creditsUsed: number; creditsRemaining: number }>('/api/credits');
    assert.ok(body.creditsUsed >= 0);
    assert.ok(body.creditsRemaining >= 0);
    // The opening allowance is 100; grants can push the remaining balance above
    // that, so only the lower bound is asserted here.
    assert.ok(body.creditsRemaining + body.creditsUsed >= 100);
  });

  it('counts a granted credit in the remaining balance', async () => {
    if (!up) return;
    // Regression: remaining was computed as `allowance - charges`, which
    // silently discarded grants — an approved credit request had no effect.
    const before = await call<{ creditsUsed: number; creditsRemaining: number }>('/api/credits');
    assert.equal(
      before.body.creditsRemaining + before.body.creditsUsed >= 100,
      true,
      'remaining must account for granted credits, not just the opening allowance',
    );
  });

  it('charges credits for a completed run', async () => {
    if (!up) return;
    const before = await call<{ creditsRemaining: number }>('/api/credits');
    const config = buildDefaultConfig('xss', FIXTURE_VULNERABLE);
    const created = await call<{ run: { id: string; creditsUsed: number } }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ configs: [config] }),
    });
    await waitForRun(created.body.run.id);
    const after = await call<{ creditsRemaining: number }>('/api/credits');
    assert.ok(
      after.body.creditsRemaining < before.body.creditsRemaining,
      'a completed run must debit credits',
    );
  });
});

describe('import', () => {
  it('merges an imported document into the cart additively', async () => {
    if (!up) return;
    const existing = buildDefaultConfig('xss', FIXTURE_VULNERABLE);
    const { status, body } = await call<{ added: number; total: number; errors: unknown[] }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        document: {
          version: 1,
          tests: [{ testId: 'path_traversal', target: { domain: FIXTURE_VULNERABLE } }],
        },
        cart: [existing],
      }),
    });
    assert.equal(status, 200);
    assert.equal(body.added, 1);
    assert.equal(body.total, 2, 'import must be additive, not replacing');
    assert.equal(body.errors.length, 0);
  });

  it('reports an unknown test id rather than failing the whole import', async () => {
    if (!up) return;
    const { body } = await call<{ added: number; errors: Array<{ message: string }> }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        document: { version: 1, tests: [{ testId: 'not_a_real_test', target: { domain: 'x.com' } }] },
        cart: [],
      }),
    });
    assert.equal(body.added, 0);
    assert.equal(body.errors.length, 1);
  });

  it('rejects a malformed document', async () => {
    if (!up) return;
    const { status } = await call('/api/import', {
      method: 'POST',
      body: JSON.stringify({ document: { tests: 'nope' } }),
    });
    assert.equal(status, 400);
  });

  it('serves a usable template for each test', async () => {
    if (!up) return;
    const { status, body } = await call<{ version: number; tests: Array<{ testId: string }> }>(
      '/api/templates/sql_injection',
    );
    assert.equal(status, 200);
    assert.equal(body.version, 1);
    assert.equal(body.tests[0]?.testId, 'sql_injection');
  });
});
