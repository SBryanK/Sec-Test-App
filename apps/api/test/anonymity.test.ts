import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { AttackConfig, TestId } from '@teo/shared';
import { DEFAULT_EXECUTION_OPTIONS, buildDefaultConfig, normaliseTarget } from '@teo/shared';

import {
  BROWSER_PROFILES,
  buildIdentityHeaders,
  orderHeaders,
  sanitizeOutgoingHeaders,
  selectProfile,
} from '../src/engine/anonymity.ts';
import { executorFor, planProbes } from '../src/engine/executors/index.ts';
import type { ExecutorContext, TraceDraft } from '../src/engine/executors/context.ts';
import { buildRequest } from '../src/engine/requestBuilder.ts';
import { parseProxy } from '../src/engine/httpClient.ts';
import { FIXTURE_VULNERABLE, fixturesReachable } from './helpers/fixture.ts';

/**
 * Operator anonymity.
 *
 * The threat being tested is not "does the code intend to hide the operator" but
 * "does anything identifying actually arrive at the target". The integration
 * tests below ask the fixture what it *received*, which is the only version of
 * that question worth answering.
 */

const OPERATOR_EMAIL = 'operator@edgeone.internal';
const OPERATOR_NAME = 'Test Operator';

/* ------------------------------------------------------------------ *
 * Unit level
 * ------------------------------------------------------------------ */

describe('header sanitizer', () => {
  it('drops headers whose name carries operator identity', () => {
    const { headers, removed } = sanitizeOutgoingHeaders(
      { 'X-Operator-Email': OPERATOR_EMAIL, Accept: '*/*' },
      { email: OPERATOR_EMAIL, name: OPERATOR_NAME },
    );
    assert.equal(headers['X-Operator-Email'], undefined);
    assert.equal(headers['Accept'], '*/*');
    assert.equal(removed.length, 1);
    assert.match(removed[0] ?? '', /X-Operator-Email/);
  });

  it('drops any header whose value contains the operator email', () => {
    const { headers, removed } = sanitizeOutgoingHeaders(
      { Referer: `https://portal.internal/u/${OPERATOR_EMAIL}`, Accept: '*/*' },
      { email: OPERATOR_EMAIL, name: OPERATOR_NAME },
    );
    assert.equal(headers['Referer'], undefined);
    assert.match(removed[0] ?? '', /operator identity/);
  });

  it('drops any header whose value contains the operator name', () => {
    const { headers } = sanitizeOutgoingHeaders(
      { 'X-Client': `session-for-${OPERATOR_NAME}` },
      { email: OPERATOR_EMAIL, name: OPERATOR_NAME },
    );
    assert.equal(headers['X-Client'], undefined);
  });

  it('leaves ordinary headers untouched', () => {
    const input = { Accept: '*/*', 'User-Agent': 'Mozilla/5.0', Cookie: 'session=abc' };
    const { headers, removed } = sanitizeOutgoingHeaders(input, {
      email: OPERATOR_EMAIL,
      name: OPERATOR_NAME,
    });
    assert.deepEqual(headers, input);
    assert.equal(removed.length, 0);
  });

  it('works with no identity configured', () => {
    const input = { Accept: '*/*' };
    assert.deepEqual(sanitizeOutgoingHeaders(input, null).headers, input);
  });

  it('ignores very short identity strings that would cause false positives', () => {
    // A two-character name must not cause every header to be stripped.
    const { headers } = sanitizeOutgoingHeaders({ Accept: '*/*' }, { email: 'a@b.c', name: 'Jo' });
    assert.equal(headers['Accept'], '*/*');
  });
});

describe('identity profiles', () => {
  it('never advertises the tool in neutral mode', () => {
    const id = buildIdentityHeaders({ mode: 'neutral', hasBody: false });
    assert.doesNotMatch(id.userAgent, /EdgeOne|SecTest|pentest/i);
    assert.doesNotMatch(JSON.stringify(id.headers), /EdgeOne|SecTest|pentest/i);
  });

  it('sends a minimal header set in neutral mode', () => {
    const id = buildIdentityHeaders({ mode: 'neutral', hasBody: false });
    assert.deepEqual(Object.keys(id.headers).sort(), ['Accept', 'User-Agent']);
  });

  it('advertises the tool only in identify mode', () => {
    const id = buildIdentityHeaders({ mode: 'identify', hasBody: false });
    assert.match(id.userAgent, /EdgeOne-SecTest/);
  });

  it('honours an explicit User-Agent override in every mode', () => {
    for (const mode of ['neutral', 'browser', 'identify'] as const) {
      const id = buildIdentityHeaders({
        mode,
        profile: mode === 'browser' ? (BROWSER_PROFILES[0] ?? null) : null,
        userAgentOverride: 'CustomerAllowListed/1.0',
        hasBody: false,
      });
      assert.equal(id.userAgent, 'CustomerAllowListed/1.0', `mode ${mode}`);
    }
  });

  for (const profile of BROWSER_PROFILES) {
    it(`profile ${profile.id} is internally consistent`, () => {
      const id = buildIdentityHeaders({ mode: 'browser', profile, hasBody: false });

      // A Chromium UA must carry client hints; a Gecko/WebKit UA must not.
      const hasHints = Object.keys(id.headers).some((k) => k.toLowerCase().startsWith('sec-ch-ua'));
      if (profile.family === 'chromium') {
        assert.ok(hasHints, `${profile.id}: Chromium profile must send Sec-CH-UA`);
        assert.equal(id.headers['sec-ch-ua-platform'], profile.clientHints?.['sec-ch-ua-platform']);
      } else {
        assert.equal(hasHints, false, `${profile.id}: ${profile.family} must NOT send Sec-CH-UA`);
      }

      // The UA must name the same browser family the rest of the headers imply.
      if (profile.family === 'gecko') assert.match(id.userAgent, /Firefox\//);
      if (profile.family === 'webkit') assert.match(id.userAgent, /Safari\//);
      if (profile.id === 'chrome-win') assert.match(id.userAgent, /Chrome\//);
      if (profile.id === 'edge-win') assert.match(id.userAgent, /Edg\//);
    });
  }

  it('rotates to a different profile each time when asked', () => {
    const first = selectProfile(null, true);
    let differed = false;
    for (let i = 0; i < 40; i += 1) {
      const next = selectProfile(first, true);
      if (next.id !== first.id) differed = true;
      assert.notEqual(next.id, first.id, 'rotation must not repeat the previous profile');
    }
    assert.ok(differed, 'rotation should produce alternatives');
  });

  it('is stable when rotation is disabled', () => {
    assert.equal(selectProfile(null, false).id, selectProfile(null, false).id);
  });
});

describe('header ordering', () => {
  it('puts Chromium headers in the canonical browser order', () => {
    const ordered = orderHeaders(
      { Accept: 'a', 'User-Agent': 'b', Host: 'c', 'sec-ch-ua': 'd', 'Accept-Language': 'e' },
      'chromium',
    );
    assert.deepEqual(Object.keys(ordered), [
      'Host',
      'sec-ch-ua',
      'User-Agent',
      'Accept',
      'Accept-Language',
    ]);
  });

  it('puts Gecko headers in the Firefox order', () => {
    const ordered = orderHeaders(
      { Accept: 'a', 'User-Agent': 'b', Host: 'c', 'Accept-Language': 'd' },
      'gecko',
    );
    assert.deepEqual(Object.keys(ordered), ['Host', 'User-Agent', 'Accept', 'Accept-Language']);
  });

  it('appends operator-supplied headers after the standard set', () => {
    const ordered = orderHeaders({ 'X-Custom-Auth': 'tok', Host: 'h', Accept: 'a' }, 'chromium');
    assert.deepEqual(Object.keys(ordered), ['Host', 'Accept', 'X-Custom-Auth']);
  });

  it('never loses a header', () => {
    const input = { Zebra: '1', Apple: '2', Host: 'h', 'User-Agent': 'u' };
    assert.deepEqual(Object.keys(orderHeaders(input, 'chromium')).sort(), Object.keys(input).sort());
  });
});

describe('proxy parsing', () => {
  it('parses host, port and credentials', () => {
    const p = parseProxy('http://user:pass@proxy.internal:3128');
    assert.equal(p.host, 'proxy.internal');
    assert.equal(p.port, 3128);
    assert.equal(p.authHeader, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('defaults the port when omitted', () => {
    assert.equal(parseProxy('http://proxy.internal').port, 8080);
    assert.equal(parseProxy('https://proxy.internal').port, 443);
  });

  it('reports no credentials when none are given', () => {
    assert.equal(parseProxy('http://proxy.internal:8080').authHeader, null);
  });

  it('rejects an unsupported scheme', () => {
    assert.throws(() => parseProxy('socks5://proxy.internal:1080'), /Unsupported proxy scheme/);
  });
});

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

describe('execution defaults', () => {
  it('does not advertise the tool by default', () => {
    assert.notEqual(DEFAULT_EXECUTION_OPTIONS.anonymity, 'identify');
    assert.equal(DEFAULT_EXECUTION_OPTIONS.anonymity, 'neutral');
  });

  it('sends no proxy unless one is configured', () => {
    assert.equal(DEFAULT_EXECUTION_OPTIONS.egressProxy, null);
  });
});

/* ------------------------------------------------------------------ *
 * Wire-level proof
 * ------------------------------------------------------------------ */

interface CapturedRequest {
  method: string;
  path: string;
  rawHeaders: string[];
  headerOrder: string[];
  userAgent: string;
}

async function capturedRequests(): Promise<CapturedRequest[]> {
  const res = await fetch(`${FIXTURE_VULNERABLE}/_log`);
  const data = (await res.json()) as { requests: CapturedRequest[] };
  return data.requests;
}

async function resetCapture(): Promise<void> {
  await fetch(`${FIXTURE_VULNERABLE}/_reset`);
}

async function runTest(testId: TestId, tweak: (c: AttackConfig) => void = () => undefined): Promise<TraceDraft[]> {
  const config = buildDefaultConfig(testId, FIXTURE_VULNERABLE);
  config.options.timeoutMs = 8000;
  config.options.maxRequests = 60;
  tweak(config);

  const traces: TraceDraft[] = [];
  let seqCounter = 0;
  const ctx: ExecutorContext = {
    config,
    target: normaliseTarget(FIXTURE_VULNERABLE),
    identity: { email: OPERATOR_EMAIL, name: OPERATOR_NAME },
    emit: async (draft) => {
      traces.push(draft);
    },
    signal: new AbortController().signal,
    budget: { maxRequests: 60, maxConcurrency: 8, maxRps: 100 },
    log: () => undefined,
    plannedProbes: planProbes(config),
    rotation: { previous: null },
    allocateSeq: () => {
      seqCounter += 1;
      return seqCounter;
    },
  };

  await executorFor(testId)(ctx);
  return traces;
}

/** Every byte that left the executor for this run. */
function wireText(requests: CapturedRequest[]): string {
  return requests
    .map((r) => `${r.method} ${r.path}\n${r.rawHeaders.join('\n')}\n${r.userAgent}`)
    .join('\n---\n');
}

let available = false;

before(async () => {
  available = await fixturesReachable();
  if (!available) {
    console.warn('\n  ⚠ Fixture not reachable — skipping wire-level anonymity tests.\n');
  }
});

describe('wire-level anonymity', () => {
  it('never transmits the operator email or name', async () => {
    if (!available) return;
    await resetCapture();

    await runTest('sql_injection');
    await runTest('xss');
    await runTest('path_traversal');
    await runTest('idor_enumeration', (c) => {
      c.values['idor.end'] = 3;
    });
    await runTest('schema_validation');

    const requests = await capturedRequests();
    assert.ok(requests.length > 5, `expected captured traffic, got ${requests.length}`);

    const wire = wireText(requests);
    assert.equal(
      wire.toLowerCase().includes(OPERATOR_EMAIL.toLowerCase()),
      false,
      'the operator email reached the target',
    );
    assert.equal(
      wire.toLowerCase().includes(OPERATOR_NAME.toLowerCase()),
      false,
      'the operator name reached the target',
    );
  });

  it('never transmits the tool name in the default (neutral) mode', async () => {
    if (!available) return;
    await resetCapture();
    await runTest('sql_injection');
    await runTest('brute_force');

    const requests = await capturedRequests();
    const wire = wireText(requests).toLowerCase();

    for (const tell of ['edgeone', 'sectest', 'pentest', 'edgeone-sectest']) {
      assert.equal(wire.includes(tell), false, `the wire contained the tool tell "${tell}"`);
    }
  });

  it('sends a full, browser-shaped header set in browser mode', async () => {
    if (!available) return;
    await resetCapture();

    await runTest('sql_injection', (c) => {
      c.options.anonymity = 'browser';
      c.options.rotateUserAgent = false;
    });

    const requests = await capturedRequests();
    const sample = requests.find((r) => r.path.startsWith('/login'));
    assert.ok(sample, 'expected the SQLi probe to reach /login');

    const order = sample.headerOrder;
    const ua = sample.userAgent;

    // A Chromium UA must come with the matching client-hint family.
    assert.match(ua, /Mozilla\/5\.0/);
    assert.ok(order.includes('sec-ch-ua'), 'browser mode must send Sec-CH-UA');
    assert.ok(order.includes('sec-fetch-site'), 'browser mode must send Sec-Fetch-*');
    assert.ok(order.includes('accept-language'), 'browser mode must send Accept-Language');
    assert.ok(order.includes('accept-encoding'), 'browser mode must send Accept-Encoding');

    // Header ORDER is itself a fingerprint: Host must lead, and the client hints
    // must precede the User-Agent exactly as Chrome emits them.
    assert.equal(order[0], 'host', 'Host must be the first header');
    assert.ok(
      order.indexOf('sec-ch-ua') < order.indexOf('user-agent'),
      'Sec-CH-UA must precede User-Agent, as Chrome sends it',
    );
  });

  it('keeps an explicit test User-Agent when the catalog sets one', () => {
    // The User-Agent Anomaly test exists precisely to send specific UAs; the
    // anonymity layer must not silently override the operator's intent.
    const config = buildDefaultConfig('user_agent_anomaly', FIXTURE_VULNERABLE);
    config.options.anonymity = 'browser';
    const target = normaliseTarget(FIXTURE_VULNERABLE);

    const built = buildRequest(config, target, null, {
      identity: { email: OPERATOR_EMAIL, name: OPERATOR_NAME },
    });
    // The executor sets the UA per profile after building; what matters here is
    // that a config-supplied UA wins over the identity profile.
    const withUa = buildRequest(
      { ...config, http: { ...config.http, headers: [{ key: 'User-Agent', value: 'curl/7.68.0' }] } },
      target,
      null,
      { identity: null },
    );
    assert.equal(withUa.headers['User-Agent'], 'curl/7.68.0');
    assert.ok(built.userAgent.length > 0);
  });

  it('rotates the browser profile across requests within a run', async () => {
    if (!available) return;
    await resetCapture();

    // A repeat of the previous profile is itself a fingerprinting signal, so
    // the executor carries the last-used profile across requests.
    const traces = await runTest('sql_injection', (c) => {
      c.options.anonymity = 'browser';
      c.options.rotateUserAgent = true;
    });
    assert.ok(traces.length >= 3, 'expected several probes');

    const requests = await capturedRequests();
    const agents = requests.map((r) => r.userAgent).filter(Boolean);
    assert.ok(agents.length >= 3, `expected several captured requests, got ${agents.length}`);

    let consecutiveRepeats = 0;
    for (let i = 1; i < agents.length; i += 1) {
      if (agents[i] === agents[i - 1]) consecutiveRepeats += 1;
    }
    assert.equal(consecutiveRepeats, 0, 'the same browser profile was used twice in a row');
    assert.ok(new Set(agents).size > 1, 'rotation produced only one profile');
  });

  it('strips an identity-bearing header even when a config supplies it', async () => {
    if (!available) return;
    await resetCapture();

    await runTest('xss', (c) => {
      c.http.headers = [
        ...c.http.headers,
        { key: 'X-Operator-Email', value: OPERATOR_EMAIL },
        { key: 'Referer', value: `https://portal.internal/${OPERATOR_EMAIL}` },
      ];
    });

    const requests = await capturedRequests();
    const wire = wireText(requests).toLowerCase();
    assert.equal(wire.includes(OPERATOR_EMAIL.toLowerCase()), false);
    assert.equal(
      requests.some((r) => r.headerOrder.includes('x-operator-email')),
      false,
      'the identity header must never leave the executor',
    );
  });
});
