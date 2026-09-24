/**
 * Quick manual driver: launches a run against the fixture and prints the result.
 *
 *   npx tsx ops/smoke.ts <testId> [domain]
 */

import { buildDefaultConfig, getTest, type AttackConfig, type TestId } from '@teo/shared';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.SEED_USER_EMAIL ?? 'operator@example.com';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'edgeone';

async function main(): Promise<void> {
  const testId = (process.argv[2] ?? 'sql_injection') as TestId;
  const domain = process.argv[3] ?? 'http://127.0.0.1:9900';

  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const { token } = (await loginRes.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const config: AttackConfig = {
    ...buildDefaultConfig(testId, domain),
    options: {
      ...buildDefaultConfig(testId, domain).options,
      timeoutMs: 10_000,
      baselineDiff: true,
    },
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
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${API}/api/runs/${run.id}`, { headers: auth });
    const data = (await res.json()) as {
      run: { status: string; summary: Record<string, unknown> | null; durationMs: number | null };
      findings: Array<{ severity: string; title: string; description: string; evidence: string }>;
      traceCount: number;
    };
    if (data.run.status !== 'running' && data.run.status !== 'queued') {
      console.log(`\n  status: ${data.run.status}  duration: ${data.run.durationMs}ms  probes: ${data.traceCount}`);
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
      const { traces } = (await tracesRes.json()) as { traces: Array<Record<string, unknown>> };
      console.log('\n  --- per-request telemetry (first 3) ---');
      for (const t of traces) {
        console.log(
          `    #${t.seq} ${t.method} ${String(t.url).slice(0, 70)}\n` +
            `       status=${t.status_code} verdict=${t.verdict} reqBytes=${t.request_bytes} respBytes=${t.response_bytes}\n` +
            `       dns=${t.dns_ms} tcp=${t.tcp_ms} tls=${t.tls_ms} ttfb=${t.ttfb_ms} total=${t.total_ms}\n` +
            `       payload=${String(t.payload ?? '—').slice(0, 50)}`,
        );
      }
      return;
    }
    process.stdout.write('.');
  }
  console.error('\ntimed out waiting for run');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
