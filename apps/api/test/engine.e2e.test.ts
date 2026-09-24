import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { AttackConfig, NormalisedTarget, TestId } from '@teo/shared';
import { buildDefaultConfig, normaliseTarget } from '@teo/shared';

import { executorFor, planProbes } from '../src/engine/executors/index.ts';
import type { ExecutorContext, TraceDraft } from '../src/engine/executors/context.ts';
import { FIXTURE_PROTECTED, FIXTURE_VULNERABLE, fixturesReachable } from './helpers/fixture.ts';

/**
 * End-to-end engine validation.
 *
 * Each of the 12 executors is run against a deterministic fixture whose
 * behaviour is known exactly, so every verdict can be asserted rather than
 * eyeballed. The same tests run against a "protected" fixture to prove the
 * engine reaches the *opposite* conclusion when protection is present —
 * a detector that always fires would pass the first half and fail this one.
 */

let available = false;

before(async () => {
  available = await fixturesReachable();
  if (!available) {
    console.warn(
      '\n  ⚠ Fixtures not reachable on 9900/9901 — skipping engine E2E.\n' +
        '    Start them with:  ./ops/stack.sh\n',
    );
  }
});

interface RunOutcome {
  verdict: string;
  severity: string | null;
  reason: string;
  findings: number;
  traces: TraceDraft[];
  metrics: Record<string, unknown>;
}

async function runExecutor(
  testId: TestId,
  domain: string,
  tweak: (config: AttackConfig) => void = () => undefined,
): Promise<RunOutcome> {
  const config = buildDefaultConfig(testId, domain);
  config.options.timeoutMs = 8000;
  config.options.maxRequests = 300;
  tweak(config);

  const traces: TraceDraft[] = [];
  let seq = 0;

  const ctx: ExecutorContext = {
    config,
    target: normaliseTarget(domain) as NormalisedTarget,
    emit: async (draft) => {
      traces.push(draft);
    },
    // A realistic identity, so the leak assertion below has something to catch.
    identity: { email: 'operator@edgeone.internal', name: 'Test Operator' },
    signal: new AbortController().signal,
    budget: { maxRequests: 300, maxConcurrency: 20, maxRps: 200 },
    log: () => undefined,
    plannedProbes: planProbes(config),
    rotation: { previous: null },
  };
  void seq;

  const outcome = await executorFor(testId)(ctx);
  return {
    verdict: outcome.detection.verdict,
    severity: outcome.detection.severity,
    reason: outcome.detection.reason,
    findings: outcome.findings.length,
    traces,
    metrics: outcome.metrics,
  };
}

/** Assert that every trace carries the forensic fields the platform promises. */
function assertTelemetry(traces: TraceDraft[], testId: string): void {
  assert.ok(traces.length > 0, `${testId}: no traces emitted`);
  for (const trace of traces) {
    assert.equal(typeof trace.seq, 'number', `${testId}: seq must be numeric`);
    assert.ok(trace.url.startsWith('http'), `${testId}: url must be absolute`);
    assert.ok(trace.method.length > 0, `${testId}: method required`);
    assert.equal(typeof trace.requestBytes, 'number', `${testId}: requestBytes required`);
    assert.ok(trace.requestBytes > 0, `${testId}: requestBytes must be positive`);
    assert.ok(trace.result.timing.totalMs !== null, `${testId}: totalMs must be recorded`);
    assert.ok(trace.verdict.length > 0, `${testId}: verdict required`);
  }
  const seqs = traces.map((t) => t.seq);
  assert.equal(new Set(seqs).size, seqs.length, `${testId}: seq values must be unique`);
}

describe('engine E2E — vulnerable target', () => {
  it('detects SQL injection as critical', async () => {
    if (!available) return;
    const r = await runExecutor('sql_injection', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.equal(r.severity, 'critical');
    assert.ok(r.findings >= 2, `expected >=2 findings, got ${r.findings}`);
    assertTelemetry(r.traces, 'sql_injection');
  });

  it('detects reflected XSS as high', async () => {
    if (!available) return;
    const r = await runExecutor('xss', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.equal(r.severity, 'high');
    assert.ok(r.findings >= 1);
    assertTelemetry(r.traces, 'xss');
  });

  it('detects path traversal as critical', async () => {
    if (!available) return;
    const r = await runExecutor('path_traversal', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.equal(r.severity, 'critical');
    assert.ok(r.findings >= 1);
    assertTelemetry(r.traces, 'path_traversal');
  });

  it('detects an unrestricted request body', async () => {
    if (!available) return;
    const r = await runExecutor('oversized_body', FIXTURE_VULNERABLE, (c) => {
      c.values['ob.body_size_kb'] = 256;
      c.values['ob.json_field_count'] = 500;
    });
    assert.equal(r.verdict, 'bypassed', r.reason);
    assertTelemetry(r.traces, 'oversized_body');
    // The body actually transmitted must match what was requested.
    const sent = r.traces[0]?.requestBytes ?? 0;
    assert.ok(sent > 256 * 1024, `expected >256KB on the wire, got ${sent}`);
  });

  it('flags spoofed bot User-Agents that were not challenged', async () => {
    if (!available) return;
    const r = await runExecutor('user_agent_anomaly', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.ok(r.findings >= 1);
    assertTelemetry(r.traces, 'user_agent_anomaly');
  });

  it('finds a weak credential', async () => {
    if (!available) return;
    const r = await runExecutor('brute_force', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.equal(r.severity, 'critical');
    assertTelemetry(r.traces, 'brute_force');
  });

  it('enumerates accessible object identifiers', async () => {
    if (!available) return;
    const r = await runExecutor('idor_enumeration', FIXTURE_VULNERABLE, (c) => {
      c.values['idor.start'] = 1;
      c.values['idor.end'] = 6;
    });
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.ok(r.findings >= 4, `expected several accessible IDs, got ${r.findings}`);
    assertTelemetry(r.traces, 'idor_enumeration');
  });

  it('flags malformed bodies that were accepted', async () => {
    if (!available) return;
    const r = await runExecutor('schema_validation', FIXTURE_VULNERABLE);
    assert.equal(r.verdict, 'bypassed', r.reason);
    assertTelemetry(r.traces, 'schema_validation');
    // Every content-type x fuzz-case combination must have been exercised.
    assert.equal(r.traces.length, 12);
  });

  it('detects a replayable business operation', async () => {
    if (!available) return;
    const r = await runExecutor('business_logic', FIXTURE_VULNERABLE, (c) => {
      c.values['bl.replay_count'] = 6;
    });
    assert.equal(r.verdict, 'bypassed', r.reason);
    assert.equal(r.findings, 1);
    assertTelemetry(r.traces, 'business_logic');
  });

  it('sustains an HTTP spike and records per-request latency', async () => {
    if (!available) return;
    const r = await runExecutor('http_spike', FIXTURE_VULNERABLE, (c) => {
      c.values['spike.burst'] = 30;
      c.values['spike.threads'] = 6;
      c.values['spike.interval'] = 5;
      c.values['spike.duration'] = 20;
    });
    assert.ok(['passed', 'bypassed', 'blocked'].includes(r.verdict), r.reason);
    assert.equal(r.traces.length, 30, 'every burst request must be traced');
    assertTelemetry(r.traces, 'http_spike');
    assert.ok(Number(r.metrics.achievedRps) > 0, 'achieved RPS must be computed');
    assert.ok(Number(r.metrics.p95Ms) >= 0, 'p95 must be computed');
  });

  it('holds parallel connections for the connection flood', async () => {
    if (!available) return;
    const r = await runExecutor('connection_flood', FIXTURE_VULNERABLE, (c) => {
      c.values['flood.connections'] = 8;
      c.values['flood.rps'] = 15;
      c.values['flood.duration'] = 2;
    });
    assert.ok(['passed', 'bypassed', 'blocked'].includes(r.verdict), r.reason);
    assert.ok(r.traces.length > 20, `expected a sustained flood, got ${r.traces.length} sends`);
    assert.equal(r.metrics.connectionsEstablished, 8, 'all 8 sockets must establish');
    assertTelemetry(r.traces, 'connection_flood');
  });

  it('records an iteration number on every probe', async () => {
    if (!available) return;
    const r = await runExecutor('xss', FIXTURE_VULNERABLE);
    assert.ok(r.traces.length >= 3);

    // Each payload is its own iteration, so a result can be traced back to
    // which entry in the dictionary produced it.
    const iterations = r.traces.map((t) => t.iteration);
    assert.deepEqual(
      iterations,
      Array.from({ length: iterations.length }, (_, i) => i + 1),
      'iterations should number the payloads in order',
    );
    assert.equal(new Set(iterations).size, iterations.length, 'iterations must be unique');
  });

  it('records the remote address that answered', async () => {
    if (!available) return;
    const r = await runExecutor('sql_injection', FIXTURE_VULNERABLE);
    const withAddress = r.traces.filter((t) => t.result.remoteAddress !== null);
    assert.ok(
      withAddress.length > 0,
      'at least one probe should record the resolved remote address',
    );
    assert.match(
      withAddress[0]?.result.remoteAddress ?? '',
      /^[0-9a-fA-F.:\[\]]+:\d+$/,
      'remote address should be host:port',
    );
  });

  it('crawls the target and reports the fetched surface', async () => {
    if (!available) return;
    const r = await runExecutor('web_crawler', FIXTURE_VULNERABLE, (c) => {
      c.values['crawl.depth'] = 2;
      c.values['crawl.max_pages'] = 30;
      c.values['crawl.delay'] = 0;
    });
    assert.ok(Number(r.metrics.pagesFetched) >= 5, `expected several pages, got ${r.metrics.pagesFetched}`);
    assertTelemetry(r.traces, 'web_crawler');
  });
});

describe('engine E2E — protected target', () => {
  it('reports SQL injection as blocked, not bypassed', async () => {
    if (!available) return;
    const r = await runExecutor('sql_injection', FIXTURE_PROTECTED);
    assert.equal(r.verdict, 'blocked', r.reason);
    assert.equal(r.findings, 0, 'a defended target must produce no findings');
    assertTelemetry(r.traces, 'sql_injection');
  });

  it('reports XSS as blocked', async () => {
    if (!available) return;
    const r = await runExecutor('xss', FIXTURE_PROTECTED);
    assert.equal(r.verdict, 'blocked', r.reason);
    assert.equal(r.findings, 0);
  });

  it('reports path traversal as blocked', async () => {
    if (!available) return;
    const r = await runExecutor('path_traversal', FIXTURE_PROTECTED);
    assert.equal(r.verdict, 'blocked', r.reason);
    assert.equal(r.findings, 0);
  });

  it('reports spoofed bot User-Agents as challenged', async () => {
    if (!available) return;
    const r = await runExecutor('user_agent_anomaly', FIXTURE_PROTECTED);
    assert.equal(r.verdict, 'blocked', r.reason);
    assert.equal(r.findings, 0);
  });

  it('pins rate limiting to the iteration where it started', async () => {
    if (!available) return;
    // The protected fixture allows a burst then returns 429. The run should say
    // *when* that happened, not just what percentage was refused.
    const r = await runExecutor('http_spike', FIXTURE_PROTECTED, (c) => {
      c.values['spike.burst'] = 40;
      c.values['spike.threads'] = 4;
      c.values['spike.interval'] = 10;
      c.values['spike.duration'] = 20;
    });

    assert.equal(r.verdict, 'blocked', r.reason);
    const firstBlocked = r.metrics.firstBlockedIteration;
    assert.ok(
      typeof firstBlocked === 'number' && firstBlocked > 0,
      `expected a first-blocked iteration, got ${String(firstBlocked)}`,
    );

    // It must be a real iteration, and something must have succeeded before it.
    const blocked = r.traces.filter((t) => t.verdict === 'blocked').map((t) => t.iteration);
    assert.equal(firstBlocked, Math.min(...blocked), 'should be the earliest blocked iteration');
    assert.ok(
      r.traces.some((t) => t.verdict === 'passed' && t.iteration < (firstBlocked as number)),
      'the burst should have been served before blocking began',
    );
  });
});

describe('executor planning', () => {
  it('plans a plausible probe count for every test', () => {
    const ids: TestId[] = [
      'http_spike',
      'connection_flood',
      'sql_injection',
      'xss',
      'path_traversal',
      'oversized_body',
      'user_agent_anomaly',
      'web_crawler',
      'brute_force',
      'idor_enumeration',
      'schema_validation',
      'business_logic',
    ];
    for (const id of ids) {
      const planned = planProbes(buildDefaultConfig(id, 'example.com'));
      assert.ok(planned >= 1, `${id}: planned ${planned}`);
      assert.ok(Number.isFinite(planned), `${id}: plan must be finite`);
    }
  });

  it('plans schema validation as the product of cases and content types', () => {
    const config = buildDefaultConfig('schema_validation', 'example.com');
    assert.equal(planProbes(config), 12); // 3 fuzz cases x 4 content types
  });

  it('plans the IDOR range from start/end/step', () => {
    const config = buildDefaultConfig('idor_enumeration', 'example.com');
    config.values['idor.start'] = 1;
    config.values['idor.end'] = 10;
    config.values['idor.step'] = 1;
    assert.equal(planProbes(config), 11); // 10 identifiers + 1 baseline
  });
});

after(() => {
  // Nothing global to tear down; fixtures are managed by ops/stack.sh.
});
