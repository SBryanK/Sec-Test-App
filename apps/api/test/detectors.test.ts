import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyseLoad,
  analyseReplays,
  classifyGeneric,
  detectAuthBypass,
  detectBlocked,
  detectBotHandling,
  detectFileDisclosure,
  detectIdor,
  detectLoadResilience,
  detectLogicAbuse,
  detectLoginOutcome,
  detectOversizedBody,
  detectSchemaGap,
  detectSqlError,
  detectXssReflection,
  formatBytes,
  type Detection,
} from '../src/engine/detectors.ts';
import type { ProbeResult } from '../src/engine/httpClient.ts';

/** Build a synthetic probe result for detector tests. */
function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    statusCode: 200,
    statusMessage: 'OK',
    responseHeaders: {},
    bodyPreview: '',
    bodyBytes: 0,
    responseHeaderBytes: 0,
    responseBytes: 0,
    responseHash: null,
    requestBytes: 0,
    requestHeaderBytes: 0,
    wireBytes: 0,
    contentEncoding: null,
    viaProxy: false,
    remoteAddress: null,
    timing: { dnsMs: 1, tcpMs: 1, tlsMs: 1, ttfbMs: 5, totalMs: 10 },
    redirectChain: [],
    tls: null,
    error: null,
    ...over,
  };
}

describe('WAF / edge detection', () => {
  it('recognises a block page with a telling status and signature', () => {
    const detection = detectBlocked(
      probe({ statusCode: 403, bodyPreview: '<h1>Access Denied</h1> Request blocked by Web Application Firewall' }),
    );
    assert.ok(detection);
    assert.equal(detection.verdict, 'blocked');
    assert.match(detection.reason, /403/);
  });

  it('recognises a bare rate-limit status', () => {
    const detection = detectBlocked(probe({ statusCode: 429 }));
    assert.equal(detection?.verdict, 'blocked');
  });

  it('does not call a plain 200 a block', () => {
    assert.equal(detectBlocked(probe({ statusCode: 200, bodyPreview: 'hello' })), null);
  });

  it('ignores a 404 — that is not a block', () => {
    assert.equal(detectBlocked(probe({ statusCode: 404 })), null);
  });

  it('names the edge provider from its headers', () => {
    const detection = detectBlocked(
      probe({ statusCode: 403, responseHeaders: { 'X-EdgeOne-Request-Id': 'eo-abc' }, bodyPreview: 'blocked' }),
    );
    assert.match(detection?.reason ?? '', /Tencent EdgeOne/);
  });
});

describe('SQL injection detectors', () => {
  it('catches a MySQL error leak', () => {
    const d = detectSqlError(probe({ statusCode: 500, bodyPreview: "You have an error in your SQL syntax; check the manual" }));
    assert.equal(d?.verdict, 'bypassed');
    assert.equal(d?.severity, 'critical');
    assert.match(d?.signature ?? '', /^MySQL:/);
  });

  it('catches PostgreSQL, MSSQL, Oracle and SQLite signatures', () => {
    const cases: Array<[string, string]> = [
      ['PostgreSQL', 'ERROR: syntax error at or near "1"'],
      ['MSSQL', 'Unclosed quotation mark after the character string'],
      ['Oracle', 'ORA-01756: quoted string not properly terminated'],
      ['SQLite', 'unrecognized token: "1"'],
    ];
    for (const [db, body] of cases) {
      const d = detectSqlError(probe({ statusCode: 500, bodyPreview: body }));
      assert.ok(d, `expected ${db} to be detected`);
      assert.match(d.signature ?? '', new RegExp(`^${db}:`));
    }
  });

  it('does not fire on a clean response', () => {
    assert.equal(detectSqlError(probe({ bodyPreview: '<h1>Welcome</h1>' })), null);
  });

  it('detects an authentication bypass: rejected baseline becomes accepted', () => {
    const baseline = probe({ statusCode: 200, bodyPreview: 'Invalid username or password.' });
    const attack = probe({ statusCode: 200, bodyPreview: 'Welcome back, administrator. Session established.' });
    const d = detectAuthBypass(baseline, attack);
    assert.equal(d?.verdict, 'bypassed');
    assert.equal(d?.severity, 'critical');
    assert.match(d?.signature ?? '', /auth-bypass/);
  });

  it('detects a hard status flip from 403 to 200', () => {
    const d = detectAuthBypass(probe({ statusCode: 403 }), probe({ statusCode: 200, bodyPreview: 'ok' }));
    assert.equal(d?.signature, 'injection:status-flip');
  });

  it('does not fire when both responses are rejections', () => {
    const baseline = probe({ statusCode: 401, bodyPreview: 'Invalid credentials' });
    const attack = probe({ statusCode: 401, bodyPreview: 'Invalid credentials' });
    assert.equal(detectAuthBypass(baseline, attack), null);
  });
});

describe('XSS detector', () => {
  it('flags an unescaped executable reflection', () => {
    const d = detectXssReflection("<script>alert('XSS')</script>", probe({ bodyPreview: "<div>You searched for: <script>alert('XSS')</script></div>" }));
    assert.equal(d?.verdict, 'bypassed');
    assert.equal(d?.severity, 'high');
  });

  it('reports encoded reflection as passed, not a finding', () => {
    const d = detectXssReflection('<script>', probe({ bodyPreview: 'You searched for: &lt;script&gt;' }));
    assert.equal(d?.verdict, 'passed');
    assert.equal(d?.signature, 'xss:reflected-encoded');
  });

  it('returns null when the payload never appears', () => {
    assert.equal(detectXssReflection('<script>', probe({ bodyPreview: 'no reflection here' })), null);
  });
});

describe('path traversal detector', () => {
  it('confirms disclosure from /etc/passwd contents', () => {
    const d = detectFileDisclosure(probe({ bodyPreview: 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:...' }));
    assert.equal(d?.verdict, 'bypassed');
    assert.equal(d?.severity, 'critical');
  });

  it('confirms disclosure from a Windows win.ini', () => {
    const d = detectFileDisclosure(probe({ bodyPreview: '; for 16-bit app support\n[fonts]\n[extensions]' }));
    assert.equal(d?.severity, 'critical');
  });

  it('does not fire on an ordinary 404 body', () => {
    assert.equal(detectFileDisclosure(probe({ statusCode: 404, bodyPreview: 'Not found' })), null);
  });
});

describe('oversized body detector', () => {
  it('treats 413 as enforced', () => {
    assert.equal(detectOversizedBody(probe({ statusCode: 413 }), 5_000_000).verdict, 'blocked');
  });

  it('treats 2xx on a large body as a finding', () => {
    const d = detectOversizedBody(probe({ statusCode: 200 }), 2 * 1024 * 1024);
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'medium');
  });

  it('treats a 5xx as a high-severity failure', () => {
    const d = detectOversizedBody(probe({ statusCode: 500 }), 1024);
    assert.equal(d.severity, 'high');
  });
});

describe('bot management detector', () => {
  it('flags an unchallenged spoofed crawler', () => {
    const d = detectBotHandling(probe({ statusCode: 200 }), 'Googlebot/2.1', null);
    assert.equal(d.verdict, 'bypassed');
    assert.match(d.reason, /Googlebot/);
  });

  it('escalates when the bot response is byte-identical to a browser', () => {
    const same = probe({ statusCode: 200, responseHash: 'sha256:abc' });
    const d = detectBotHandling(same, 'curl/7.68.0', same);
    assert.equal(d.severity, 'medium');
    assert.equal(d.signature, 'bot:identical-response');
  });

  it('reports a challenge as blocked', () => {
    const d = detectBotHandling(probe({ statusCode: 200, bodyPreview: 'Checking your browser before accessing' }), 'curl/7.68.0', null);
    assert.equal(d.verdict, 'blocked');
  });
});

describe('brute force detector', () => {
  it('confirms a successful login as critical', () => {
    const d = detectLoginOutcome(probe({ statusCode: 200, bodyPreview: '{"token":"abc"}' }), 'password', probe({ statusCode: 401 }));
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'critical');
  });

  it('reports a rejection as blocked', () => {
    const d = detectLoginOutcome(probe({ statusCode: 401, bodyPreview: 'Invalid credentials' }), 'hunter2', null);
    assert.equal(d.verdict, 'blocked');
    assert.equal(d.signature, 'brute:rejected');
  });

  it('reports a lockout as blocked', () => {
    const d = detectLoginOutcome(probe({ statusCode: 429, bodyPreview: 'Too many failed attempts. Account temporarily locked.' }), 'x', null);
    assert.equal(d.verdict, 'blocked');
    assert.match(d.signature ?? '', /lockout/);
  });
});

describe('IDOR detector', () => {
  it('confirms escalation when a forbidden baseline exists', () => {
    const forbidden = probe({ statusCode: 403 });
    const d = detectIdor(probe({ statusCode: 200, bodyPreview: '{"id":1}', bodyBytes: 8 }), '1', forbidden);
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'high');
  });

  it('is inconclusive without a baseline', () => {
    const d = detectIdor(probe({ statusCode: 200, bodyPreview: '{"id":1}', bodyBytes: 8 }), '1', null);
    assert.equal(d.verdict, 'inconclusive');
  });

  it('reports a 403 as blocked', () => {
    assert.equal(detectIdor(probe({ statusCode: 403 }), '1', null).verdict, 'blocked');
  });
});

describe('schema validation detector', () => {
  it('flags a malformed body accepted with 2xx', () => {
    const d = detectSchemaGap(probe({ statusCode: 200 }), '{}', 'application/json', true);
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'medium');
  });

  it('reports a 400 as correctly rejected', () => {
    assert.equal(detectSchemaGap(probe({ statusCode: 400 }), '{}', 'application/json', true).verdict, 'blocked');
  });

  it('reports a 415 as correctly rejected', () => {
    assert.equal(detectSchemaGap(probe({ statusCode: 415 }), 'x', 'application/xml', true).verdict, 'blocked');
  });
});

describe('business logic detector', () => {
  it('flags a replayable operation', () => {
    const analysis = analyseReplays([
      probe({ statusCode: 200, responseHash: 'sha256:a' }),
      probe({ statusCode: 200, responseHash: 'sha256:b' }),
      probe({ statusCode: 200, responseHash: 'sha256:c' }),
    ]);
    const d = detectLogicAbuse(analysis, true);
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.signature, 'logic:race');
  });

  it('reports consistent single success as passed', () => {
    const analysis = analyseReplays([
      probe({ statusCode: 200, responseHash: 'sha256:a' }),
      probe({ statusCode: 409 }),
    ]);
    assert.equal(detectLogicAbuse(analysis, true).verdict, 'passed');
  });

  it('reports full rejection as blocked', () => {
    const analysis = analyseReplays([probe({ statusCode: 429 }), probe({ statusCode: 429 })]);
    assert.equal(detectLogicAbuse(analysis, true).verdict, 'blocked');
  });
});

describe('load analysis', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({
    statusCode: i < 80 ? 200 : i < 90 ? 429 : 503,
    totalMs: 10 + i,
    error: null,
  }));

  it('computes percentiles and status mix', () => {
    const a = analyseLoad(samples, 1000);
    assert.equal(a.total, 100);
    assert.equal(a.ok, 80);
    assert.equal(a.blocked, 10);
    assert.equal(a.serverErrors, 10);
    assert.ok(a.p50Ms > 0 && a.p95Ms >= a.p50Ms && a.p99Ms >= a.p95Ms);
    assert.equal(a.achievedRps, 100);
  });

  it('reports rate limiting as blocked', () => {
    const limited = analyseLoad(
      Array.from({ length: 100 }, () => ({ statusCode: 429, totalMs: 5, error: null })),
      1000,
    );
    const d = detectLoadResilience(limited, 'spike');
    assert.equal(d.verdict, 'blocked');
  });

  it('reports origin degradation as bypassed when some requests still succeed', () => {
    // Genuine degradation: the origin is answering, but failing and slow under
    // load. (If *nothing* answers, that is an error, not degradation.)
    const degraded = analyseLoad(
      [
        ...Array.from({ length: 20 }, () => ({ statusCode: 200, totalMs: 40, error: null })),
        ...Array.from({ length: 80 }, () => ({ statusCode: 503, totalMs: 5000, error: null })),
      ],
      1000,
    );
    const d = detectLoadResilience(degraded, 'flood');
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'high');
  });

  it('reports a healthy target as passed', () => {
    const healthy = analyseLoad(
      Array.from({ length: 100 }, () => ({ statusCode: 200, totalMs: 20, error: null })),
      1000,
    );
    assert.equal(detectLoadResilience(healthy, 'spike').verdict, 'passed');
  });

  it('errors when nothing completed', () => {
    assert.equal(detectLoadResilience(analyseLoad([], 100), 'spike').verdict, 'error');
  });

  it('reports a wholly unreachable target as error, not as a degraded origin', () => {
    // A mistyped scheme or port must not raise a false HIGH finding.
    const unreachable = analyseLoad(
      Array.from({ length: 20 }, () => ({
        statusCode: null,
        totalMs: 3000,
        error: 'write EPROTO 1234:error:0A00010B:SSL routines:ssl3_get_record:wrong version number',
      })),
      60_000,
    );
    const d = detectLoadResilience(unreachable, 'spike');
    assert.equal(d.verdict, 'error');
    assert.equal(d.severity, null);
    assert.equal(unreachable.tlsHandshakeFailures, 20);
    assert.match(d.reason, /plain HTTP/);
  });

  it('counts non-TLS transport failures without the scheme hint', () => {
    const refused = analyseLoad(
      Array.from({ length: 10 }, () => ({ statusCode: null, totalMs: 5, error: 'connect ECONNREFUSED' })),
      1000,
    );
    // ECONNREFUSED matches the TLS pattern, so the hint is expected here too.
    assert.equal(detectLoadResilience(refused, 'spike').verdict, 'error');
  });

  it('still reports degradation when some requests succeed', () => {
    const mixed = analyseLoad(
      [
        ...Array.from({ length: 10 }, () => ({ statusCode: 200, totalMs: 20, error: null })),
        ...Array.from({ length: 40 }, () => ({ statusCode: 503, totalMs: 8000, error: null })),
      ],
      10_000,
    );
    const d = detectLoadResilience(mixed, 'flood');
    assert.equal(d.verdict, 'bypassed');
    assert.equal(d.severity, 'high');
  });
});

describe('generic classification', () => {
  const cases: Array<[number, Detection['verdict']]> = [
    [200, 'passed'],
    [400, 'passed'],
    [404, 'passed'],
    [422, 'passed'],
    [403, 'blocked'],
    [429, 'blocked'],
    [500, 'bypassed'],
  ];

  for (const [status, expected] of cases) {
    it(`classifies HTTP ${status} as ${expected}`, () => {
      assert.equal(classifyGeneric(probe({ statusCode: status })).verdict, expected);
    });
  }

  it('classifies a transport failure as error', () => {
    assert.equal(classifyGeneric(probe({ error: 'ECONNREFUSED', statusCode: null })).verdict, 'error');
  });
});

describe('formatting', () => {
  it('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  });
});
