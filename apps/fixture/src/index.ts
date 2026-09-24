/**
 * Deliberately vulnerable fixture target.
 *
 * This exists so the pentest engine can be validated end-to-end against a
 * service whose behaviour is known exactly — every executor must reach the
 * verdict the fixture was built to provoke. It is NOT a real application and
 * binds to loopback only.
 *
 *   MODE=vulnerable  (default) — behaves like an unprotected origin
 *   MODE=protected             — simulates an edge/WAF that blocks attack traffic
 *
 * Run:  MODE=vulnerable PORT=9900 npx tsx apps/fixture/src/index.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = Number(process.env.FIXTURE_PORT ?? 9900);
const MODE = (process.env.MODE ?? 'vulnerable') as 'vulnerable' | 'protected';
const HOST = '127.0.0.1';

/** Counter used by the business-logic fixture to expose replay abuse. */
let workflowRedemptions = 0;
let requestCount = 0;

/**
 * Every request this process has seen, with its raw header order.
 *
 * Exists so the anonymity test can prove what actually arrived on the wire,
 * rather than asserting on what the client *intended* to send. Only meaningful
 * for a local fixture and bounded so it cannot grow without limit.
 */
interface CapturedRequest {
  method: string;
  path: string;
  /** Headers in received order, exactly as they appeared on the wire. */
  rawHeaders: string[];
  headerOrder: string[];
  userAgent: string;
  receivedAt: string;
}

const captured: CapturedRequest[] = [];
const CAPTURE_LIMIT = 2000;

/**
 * Requests seen per client, used by protected mode to rate-limit.
 *
 * A real edge starts pushing back partway through a burst, which is exactly
 * what the "blocking began at iteration N" reporting is for. Without this the
 * protected fixture could only block or allow, never throttle mid-run.
 */
const perClientCounts = new Map<string, number>();
const RATE_LIMIT_AFTER = Number(process.env.FIXTURE_RATE_LIMIT_AFTER ?? 25);

function capture(req: IncomingMessage): void {
  const raw = req.rawHeaders ?? [];
  const order: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    if (name) order.push(name.toLowerCase());
  }
  captured.push({
    method: req.method ?? '',
    path: req.url ?? '',
    rawHeaders: raw,
    headerOrder: order,
    userAgent: String(req.headers['user-agent'] ?? ''),
    receivedAt: new Date().toISOString(),
  });
  if (captured.length > CAPTURE_LIMIT) captured.splice(0, captured.length - CAPTURE_LIMIT);
}

/* ------------------------------------------------------------------ *
 * Signature tables
 * ------------------------------------------------------------------ */

const SQLI_MARKERS = [/'\s*or\s+/i, /union\s+select/i, /'\s*--/, /drop\s+table/i, /sleep\s*\(/i, /waitfor\s+delay/i, /pg_sleep/i];
const XSS_MARKERS = [/<script/i, /onerror\s*=/i, /javascript:/i, /<img\s/i, /<svg/i];
const TRAVERSAL_MARKERS = [
  /\.\.\//,
  /\.\.\\/,
  /%2e%2e/i,
  /\/etc\/passwd/i,
  /etc[\\/]passwd/i,
  /system32/i,
  /win\.ini/i,
  /boot\.ini/i,
];

const WAF_BLOCK_BODY = `<!doctype html><html><head><title>Access Denied</title></head>
<body><h1>Access Denied</h1>
<p>Your request has been blocked by the Web Application Firewall.</p>
<p>Incident ID: EO-${Date.now().toString(36)}</p></body></html>`;

function matchesAny(patterns: RegExp[], ...values: string[]): boolean {
  const haystack = values.join(' ').toLowerCase();
  return patterns.some((p) => p.test(haystack));
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > limit) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    Server: 'nginx/1.24.0',
    'X-EdgeOne-Request-Id': `eo-${Math.random().toString(36).slice(2, 12)}`,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error('[fixture] handler error:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestCount += 1;
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // --- capture endpoints (never captured themselves, to stay cheap) ---
  if (path === '/_log') {
    return json(res, 200, { count: captured.length, requests: captured.slice(-500) });
  }
  if (path === '/_reset') {
    captured.length = 0;
    perClientCounts.clear();
    return json(res, 200, { reset: true });
  }

  capture(req);

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : '';

  const queryString = url.search;
  const headerBlob = JSON.stringify(req.headers);

  // --- protected mode: a WAF that normalises before matching ---
  if (MODE === 'protected') {
    // A competent WAF repeatedly normalises before matching. Decoding only once
    // leaves a double-encoding bypass open (`..%252F..%252F`), which the engine
    // is specifically built to find.
    const candidates = [queryString, body];
    for (const seed of [queryString, body]) {
      let layer = seed;
      for (let i = 0; i < 3; i += 1) {
        try {
          const next = decodeURIComponent(layer);
          if (next === layer) break;
          layer = next;
          candidates.push(layer);
        } catch {
          break;
        }
      }
    }

    const haystack = candidates.join(' ');

    const isAttack =
      TRAVERSAL_MARKERS.some((p) => p.test(haystack)) ||
      matchesAny(SQLI_MARKERS, haystack) ||
      matchesAny(XSS_MARKERS, haystack);

    if (isAttack && path !== '/api/upload') {
      res.writeHead(403, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'EdgeOne',
        'X-WAF-Status': 'blocked',
        'X-EdgeOne-Request-Id': `eo-${Math.random().toString(36).slice(2, 12)}`,
      });
      res.end(WAF_BLOCK_BODY);
      return;
    }

    // Rate limiting: allow a burst to start, then push back. This models a
    // real edge and lets the engine report the iteration where it began.
    const client = req.socket.remoteAddress ?? 'unknown';
    const seen = (perClientCounts.get(client) ?? 0) + 1;
    perClientCounts.set(client, seen);
    if (seen > RATE_LIMIT_AFTER) {
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'EdgeOne',
        'Retry-After': '60',
        'X-RateLimit-Limit': String(RATE_LIMIT_AFTER),
      });
      res.end('<!doctype html><title>429</title><h1>Too Many Requests</h1>');
      return;
    }

    // Bot User-Agents are challenged in protected mode.
    const ua = String(req.headers['user-agent'] ?? '');
    if (/curl|python-requests|postmanruntime|googlebot/i.test(ua)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', Server: 'EdgeOne' });
      res.end('<!doctype html><title>Just a moment...</title><h1>Checking your browser before accessing</h1>');
      return;
    }
  }

  /* ---------------- SQL injection ---------------- */

  if (path === '/login') {
    const sqlish = matchesAny(SQLI_MARKERS, queryString, body);

    // Time-based: honour an explicit sleep so the engine can detect the delay.
    const sleepMatch = /sleep\s*\(\s*(\d+)\s*\)/i.exec(`${queryString} ${body}`);
    if (sleepMatch) {
      await delay(Number(sleepMatch[1]) * 1000);
    }

    if (sqlish && /'\s*or\s+1\s*=\s*1/i.test(`${queryString} ${body}`)) {
      // Authenticated-looking response: different length from the baseline.
      return send(
        res,
        200,
        `<html><body><h1>Welcome back, administrator</h1>
         <p>Session established. You have full access to the dashboard.</p>
         <ul><li>Users</li><li>Billing</li><li>Audit log</li><li>Settings</li></ul>
         </body></html>`,
      );
    }

    if (sqlish) {
      // Classic error-based disclosure.
      return send(
        res,
        500,
        `<html><body><h1>Database Error</h1>
         <p>You have an error in your SQL syntax; check the manual that corresponds to your
         MySQL server version for the right syntax to use near '${queryString.slice(0, 80)}' at line 1</p>
         </body></html>`,
      );
    }

    return send(res, 200, '<html><body><h1>Login</h1><p>Invalid username or password.</p></body></html>');
  }

  /* ---------------- Reflected XSS ---------------- */

  if (path === '/comment') {
    const params = new URLSearchParams(queryString.replace(/^\?/, ''));
    const reflected = params.get('q') ?? '';
    const bodyParam = new URLSearchParams(body).get('comment') ?? '';

    // Reflect both unescaped — the vulnerable behaviour.
    return send(
      res,
      200,
      `<html><body><h1>Comments</h1>
       <div class="search-results">You searched for: ${reflected}</div>
       <div class="comment">${bodyParam}</div>
       <form method="post"><textarea name="comment"></textarea><input type="submit" name="submit" value="true"></form>
       </body></html>`,
    );
  }

  /* ---------------- Path traversal ---------------- */

  if (path === '/download') {
    const file = url.searchParams.get('file') ?? '';
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      /* keep raw */
    }

    if (TRAVERSAL_MARKERS.some((p) => p.test(decoded))) {
      if (/passwd/i.test(decoded)) {
        return send(
          res,
          200,
          `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin`,
          'text/plain; charset=utf-8',
        );
      }
      if (/win\.ini/i.test(decoded)) {
        return send(res, 200, '; for 16-bit app support\n[fonts]\n[extensions]\n[mci extensions]\n', 'text/plain');
      }
      return send(res, 200, '; for 16-bit app support\n[boot loader]\ntimeout=30\n', 'text/plain');
    }

    return send(res, 404, 'File not found', 'text/plain');
  }

  /* ---------------- Oversized body ---------------- */

  if (path === '/api/upload') {
    // No size limit at all — accepts whatever it is given.
    return json(res, 200, { uploaded: true, receivedBytes: Buffer.byteLength(body) });
  }

  /* ---------------- Brute force ---------------- */

  if (path === '/api/auth/login') {
    let username = '';
    let password = '';
    try {
      const parsed = JSON.parse(body) as { username?: string; password?: string };
      username = parsed.username ?? '';
      password = parsed.password ?? '';
    } catch {
      const form = new URLSearchParams(body);
      username = form.get('username') ?? '';
      password = form.get('password') ?? '';
    }

    if (username === 'admin' && password === 'password') {
      return json(res, 200, { token: 'fixture-session-token', user: { username, role: 'admin' } });
    }
    return json(res, 401, { error: 'Invalid credentials', message: 'Invalid username or password' });
  }

  /* ---------------- IDOR ---------------- */

  if (path === '/api/users') {
    const id = url.searchParams.get('id') ?? '';

    // 0 is the designated forbidden object; everything else is returned
    // regardless of the caller's authorisation.
    if (id === '0') {
      return json(res, 403, { error: 'Forbidden', message: 'You may not access this record' });
    }
    if (!/^\d+$/.test(id)) {
      return json(res, 400, { error: 'Bad Request', message: 'id must be numeric' });
    }
    return json(res, 200, {
      id: Number(id),
      username: `user_${id}`,
      email: `user_${id}@fixture.internal`,
      ssn: `000-00-${String(id).padStart(4, '0')}`,
      billing: { card: `4111-1111-1111-${String(id).padStart(4, '0')}` },
    });
  }

  /* ---------------- Schema validation ---------------- */

  if (path === '/api/validate') {
    // Accepts anything, including malformed bodies — the schema gap.
    return json(res, 200, { valid: true, accepted: true, echo: body.slice(0, 120) });
  }

  /* ---------------- Business logic ---------------- */

  if (path === '/api/workflow') {
    workflowRedemptions += 1;
    return json(res, 200, {
      redeemed: true,
      redemptionCount: workflowRedemptions,
      balance: 1000 - workflowRedemptions * 100,
    });
  }

  /* ---------------- Crawlable surface ---------------- */

  if (path === '/robots.txt') {
    return send(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /private\n', 'text/plain');
  }

  if (path === '/admin') {
    return send(res, 200, '<html><body><h1>Admin</h1></body></html>');
  }

  if (path === '/' || /^\/page\/\d+$/.test(path)) {
    const n = Number(/^\/page\/(\d+)$/.exec(path)?.[1] ?? '1');
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/page/${n * 6 + i + 1}">Page ${n * 6 + i + 1}</a>`).join('\n');
    return send(
      res,
      200,
      `<html><head><title>Fixture Target</title></head><body>
       <h1>Fixture Target</h1>
       <p>Deterministic target used to validate the EdgeOne Security Test engine.</p>
       <nav>${links}</nav>
       <a href="/admin">Admin</a>
       <a href="/download?file=readme.txt">Download</a>
       </body></html>`,
    );
  }

  if (path === '/api/health') {
    return json(res, 200, { status: 'ok', mode: MODE, requests: requestCount, redemptions: workflowRedemptions });
  }

  send(res, 404, '<html><body><h1>404 Not Found</h1></body></html>');
}

server.listen(PORT, HOST, () => {
  console.log(`[fixture] ${MODE} target listening on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
