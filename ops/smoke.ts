/**
 * Quick manual driver: launches a run against a target and prints the result.
 *
 *   npx tsx ops/smoke.ts <testId> [domain]
 *
 * Reads `API_URL`, `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` from the
 * environment, so `source env.sh` first.
 */

import { buildDefaultConfig, getTest, type AttackConfig, type TestId } from '@teo/shared';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.SEED_USER_EMAIL ?? 'operator@example.com';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'edgeone';

/** A trace row as the API returns it; every numeric field is nullable. */
interface TraceRow {
  seq: number;
  method: string;
  url: string;
  status_code: number | null;
  verdict: string;
  request_bytes: number | null;
  response_bytes: number | null;
  dns_ms: number | null;
  tcp_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number | null;
  payload: string | null;
}

/**
 * Render a nullable scalar for the console. Typed to exclude objects on
 * purpose — `String({})` prints `[object Object]`, which would hide a change in
 * the API's response shape behind a plausible-looking log line.
 */
const show = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined ? '—' : String(value);

async function main(): Promise<void> {
  const testId = (process.argv[2] ?? 'sql_injection') as TestId;
  const domain = process.argv[3] ?? 'http://127.0.0.1:9900';

  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error('login failed:', loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const { token } = (await loginRes.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const defaults = buildDefaultConfig(testId, domain);
  const config: AttackConfig = {
    ...defaults,
    options: { ...defaults.options, timeoutMs: 10_000, baselineDiff: true },
  };

  // Reasonable defaults for a local run.
  if (testId === 'http_spike') {
    config.values['spike.burst'] = 40;
    config.values['spike.threads'] = 8;
    config.values['spike.interval'] = 10;
    config.values['spike.duration'] = 20;
  }
  if (testId === 'connection_flood') {
    config.values['flood.connections'] = 10;
    config.values['flood.rps'] = 20;
    config.values['flood.duration'] = 5;
  }
  if (testId === 'oversized_body') {
    config.values['ob.body_size_kb'] = 128;
    config.values['ob.json_field_count'] = 200;
  }
  if (testId === 'idor_enumeration') {
    config.values['idor.start'] = 1;
    config.values['idor.end'] = 8;
  }

  console.log(`▶ ${getTest(testId).label} → ${domain}`);

  const runRes = await fetch(`${API}/api/runs`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ configs: [config], mode: 'single', device: 'smoke-script', platform: 'node' }),
  });

  if (!runRes.ok) {
    console.error('run rejected:', runRes.status, await runRes.text());
    process.exit(1);
  }

  const { run } = (await runRes.json()) as { run: { id: string } };
  console.log(`  run ${run.id}`);

  // Poll until settled.
  for (let i = 0; i < 240; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    const res = await fetch(`${API}/api/runs/${run.id}`, { headers: auth });
    const data = (await res.json()) as {
      run: { status: string; summary: Record<string, unknown> | null; durationMs: number | null };
      findings: Array<{ severity: string; title: string; description: string; evidence: string }>;
      traceCount: number;
    };
    if (data.run.status === 'running' || data.run.status === 'queued') {
      process.stdout.write('.');
      continue;
    }

    console.log(`\n  status: ${data.run.status}  duration: ${show(data.run.durationMs)}ms  probes: ${data.traceCount}`);
    console.log(`  summary: ${JSON.stringify(data.run.summary, null, 2).replace(/\n/g, '\n  ')}`);
    console.log(`  findings: ${data.findings.length}`);
    for (const f of data.findings) {
      console.log(`\n  [${f.severity.toUpperCase()}] ${f.title}`);
      console.log(`    ${f.description}`);
      console.log(
        `    evidence: ${f.evidence
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 4)
          .join(' | ')}`,
      );
    }

    // Show the forensic detail for the first few probes.
    const tracesRes = await fetch(`${API}/api/runs/${run.id}/traces?limit=3`, { headers: auth });
    const { traces } = (await tracesRes.json()) as { traces: TraceRow[] };
    console.log('\n  --- per-request telemetry (first 3) ---');
    for (const t of traces) {
      console.log(
        `    #${t.seq} ${t.method} ${t.url.slice(0, 70)}\n` +
          `       status=${show(t.status_code)} verdict=${t.verdict} ` +
          `reqBytes=${show(t.request_bytes)} respBytes=${show(t.response_bytes)}\n` +
          `       dns=${show(t.dns_ms)} tcp=${show(t.tcp_ms)} tls=${show(t.tls_ms)} ` +
          `ttfb=${show(t.ttfb_ms)} total=${show(t.total_ms)}\n` +
          `       payload=${(t.payload ?? '—').slice(0, 50)}`,
      );
    }
    return;
  }
  console.error('\ntimed out waiting for run');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
