import type { Severity, Verdict } from '@teo/shared';
import type { ProbeResult } from './httpClient.ts';
import { fingerprint } from './fingerprint.ts';

/** Outcome of analysing one probe. */
export interface Detection {
  verdict: Verdict;
  severity: Severity | null;
  reason: string;
  signature: string | null;
}

const det = (
  verdict: Verdict,
  severity: Severity | null,
  reason: string,
  signature: string | null = null,
): Detection => ({ verdict, severity, reason, signature });

/* ------------------------------------------------------------------ *
 * Intermediary / WAF detection
 * ------------------------------------------------------------------ */

/**
 * Header names that betray a reverse proxy, CDN or WAF sitting in front of the
 * origin. Presence alone is informational; presence *plus* a blocking status on
 * an attack payload is what earns a `blocked` verdict.
 */
export const EDGE_HEADER_HINTS: Record<string, string> = {
  'cf-ray': 'Cloudflare',
  'cf-cache-status': 'Cloudflare',
  'x-amz-cf-id': 'AWS CloudFront',
  'x-cache': 'CDN cache',
  'x-sucuri-id': 'Sucuri',
  'x-akamai-transformed': 'Akamai',
  'akamai-grn': 'Akamai',
  'x-azure-ref': 'Azure Front Door',
  'x-msedge-ref': 'Azure Front Door',
  'x-iinfo': 'Imperva Incapsula',
  'x-cdn': 'Generic CDN',
  'x-served-by': 'Fastly',
  'x-fastly-request-id': 'Fastly',
  'x-edgeone-request-id': 'Tencent EdgeOne',
  'x-nws-log-uuid': 'Tencent EdgeOne',
  'eo-log-uuid': 'Tencent EdgeOne',
  'eo-cache-status': 'Tencent EdgeOne',
  'server-timing': 'Edge timing',
  'x-waf': 'Generic WAF',
};

/** Body/header phrases that indicate an active block page. */
export const WAF_BLOCK_SIGNATURES: string[] = [
  'access denied',
  'request blocked',
  'request has been blocked',
  'web application firewall',
  'attention required',
  'the requested url was rejected',
  'your request was blocked',
  'security policy',
  'malicious request',
  'blocked by',
  'not acceptable',
  'just a moment',
  'checking your browser',
  'ddos protection by',
  'please verify you are a human',
  'captcha',
  'forbidden',
  'incapsula incident id',
  'sucuri website firewall',
  'mod_security',
  'modsecurity',
  'naughty request',
  'illegal request',
];

const BLOCKING_STATUSES = new Set([401, 403, 406, 409, 418, 419, 429, 451, 501, 503]);

function matchBlockSignature(result: ProbeResult): string | null {
  const body = result.bodyPreview.toLowerCase();
  for (const sig of WAF_BLOCK_SIGNATURES) {
    if (body.includes(sig)) return sig;
  }
  const serverHeader = result.responseHeaders['Server'] ?? result.responseHeaders['server'] ?? '';
  if (/cloudflare|edgeone|akamai|sucuri|incapsula/i.test(serverHeader)) return serverHeader;
  return null;
}

/**
 * Did an intermediary actively stop this request?
 *
 * Returns a Detection only when the evidence is strong: a blocking status code
 * combined with either a WAF signature or a challenge header.
 */
export function detectBlocked(result: ProbeResult): Detection | null {
  if (result.error) return null;
  const status = result.statusCode;
  if (status === null) return null;

  const signature = matchBlockSignature(result);
  const hasChallenge =
    result.responseHeaders['cf-mitigated'] !== undefined ||
    result.responseHeaders['X-WAF-Status'] !== undefined ||
    result.responseHeaders['x-sucuri-block'] !== undefined;

  if (BLOCKING_STATUSES.has(status) && (signature || hasChallenge)) {
    const provider = fingerprint(result.responseHeaders).edge?.name ?? null;
    return det(
      'blocked',
      null,
      `Request rejected with HTTP ${status} by ${provider ?? 'an edge/WAF layer'}` +
        (signature ? ` (signature: "${signature}")` : ''),
      signature ?? `status:${status}`,
    );
  }

  if (BLOCKING_STATUSES.has(status) && status !== 401) {
    const provider = fingerprint(result.responseHeaders).edge?.name ?? null;
    return det(
      'blocked',
      null,
      `Request rejected with HTTP ${status}${provider ? ` by ${provider}` : ''} — likely rate limiting or access control`,
      `status:${status}`,
    );
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * SQL injection
 * ------------------------------------------------------------------ */

export const SQL_ERROR_SIGNATURES: Array<{ db: string; pattern: RegExp }> = [
  { db: 'MySQL', pattern: /you have an error in your sql syntax/i },
  { db: 'MySQL', pattern: /warning\s*:\s*mysql_/i },
  { db: 'MySQL', pattern: /valid mysql result/i },
  { db: 'MySQL', pattern: /MySqlException/i },
  { db: 'PostgreSQL', pattern: /PostgreSQL\s+query\s+failed/i },
  { db: 'PostgreSQL', pattern: /pg_query\(\)/i },
  { db: 'PostgreSQL', pattern: /ERROR:\s+syntax error at or near/i },
  { db: 'PostgreSQL', pattern: /unterminated quoted string/i },
  { db: 'MSSQL', pattern: /Microsoft OLE DB Provider for SQL Server/i },
  { db: 'MSSQL', pattern: /Unclosed quotation mark after the character string/i },
  { db: 'MSSQL', pattern: /Incorrect syntax near/i },
  { db: 'MSSQL', pattern: /System\.Data\.SqlClient\.SqlException/i },
  { db: 'Oracle', pattern: /ORA-\d{5}/i },
  { db: 'Oracle', pattern: /quoted string not properly terminated/i },
  { db: 'SQLite', pattern: /SQLite\/JDBCDriver/i },
  { db: 'SQLite', pattern: /SQLite\.Exception/i },
  { db: 'SQLite', pattern: /System\.Data\.SQLite\.SQLiteException/i },
  { db: 'SQLite', pattern: /unrecognized token:/i },
  { db: 'Generic', pattern: /SQL syntax.*?error/i },
  { db: 'Generic', pattern: /SQLSTATE\[\w+\]/i },
  { db: 'Generic', pattern: /syntax error at or near/i },
];

export function detectSqlError(result: ProbeResult): Detection | null {
  const body = result.bodyPreview;
  for (const { db, pattern } of SQL_ERROR_SIGNATURES) {
    const match = pattern.exec(body);
    if (match) {
      return det(
        'bypassed',
        'critical',
        `Database error leaked in the response — ${db} backend disclosed via "${match[0]}"`,
        `${db}:${match[0]}`,
      );
    }
  }
  return null;
}

/**
 * Authentication-bypass detection.
 *
 * The strongest injection signal is not an error — it is the response flipping
 * from "rejected" to "accepted". This compares the baseline body against the
 * attack body and reports success when a failure state turns into a success
 * state. Unauthenticated access granted by an injected payload is critical.
 */
export const AUTH_FAILURE_MARKERS = [
  'invalid username or password',
  'invalid credentials',
  'incorrect password',
  'authentication failed',
  'login failed',
  'access denied',
  'not authorised',
  'not authorized',
  'permission denied',
  'unauthorized',
];

export const AUTH_SUCCESS_MARKERS = [
  'welcome back',
  'welcome,',
  'dashboard',
  'logout',
  'sign out',
  'session established',
  'you have full access',
  'administrator',
  'admin panel',
  'my account',
];

export function detectAuthBypass(baseline: ProbeResult, attack: ProbeResult): Detection | null {
  if (baseline.error || attack.error) return null;
  if (attack.statusCode === null || baseline.statusCode === null) return null;

  const baseBody = baseline.bodyPreview.toLowerCase();
  const attackBody = attack.bodyPreview.toLowerCase();

  const baselineFailed = AUTH_FAILURE_MARKERS.some((m) => baseBody.includes(m));
  const attackSucceeded = AUTH_SUCCESS_MARKERS.some((m) => attackBody.includes(m));
  const attackFailed = AUTH_FAILURE_MARKERS.some((m) => attackBody.includes(m));

  if (baselineFailed && attackSucceeded && !attackFailed) {
    const marker = AUTH_SUCCESS_MARKERS.find((m) => attackBody.includes(m)) ?? 'success state';
    return det(
      'bypassed',
      'critical',
      `Injection bypassed the authentication/authorisation check — the baseline was rejected ("${AUTH_FAILURE_MARKERS.find((m) => baseBody.includes(m))}") while the injected request returned a success state ("${marker}") with HTTP ${attack.statusCode}`,
      'injection:auth-bypass',
    );
  }

  // A hard status flip from rejected to accepted is equally conclusive.
  const baselineRejected = baseline.statusCode === 401 || baseline.statusCode === 403;
  const attackAccepted = attack.statusCode >= 200 && attack.statusCode < 300;
  if (baselineRejected && attackAccepted) {
    return det(
      'bypassed',
      'critical',
      `Injection changed the outcome from HTTP ${baseline.statusCode} (rejected) to HTTP ${attack.statusCode} (accepted)`,
      'injection:status-flip',
    );
  }

  return null;
}

/** Compare an attack response against a benign baseline for boolean divergence. */
export function detectBooleanDivergence(
  baseline: ProbeResult,
  attack: ProbeResult,
  control: ProbeResult | null,
): Detection | null {
  if (attack.error || baseline.error) return null;
  if (attack.statusCode !== baseline.statusCode) {
    // A different status on the injected request is meaningful only if the
    // control (a syntactically valid but logically false payload) keeps the
    // baseline status — otherwise the endpoint is simply inconsistent.
    if (control && control.statusCode === baseline.statusCode) {
      return det(
        'bypassed',
        'high',
        `Boolean-based divergence: injected request returned HTTP ${attack.statusCode} while the baseline and control returned HTTP ${baseline.statusCode}`,
        'boolean:status',
      );
    }
    return null;
  }

  const lenDelta = Math.abs(attack.bodyBytes - baseline.bodyBytes);
  const threshold = Math.max(64, baseline.bodyBytes * 0.1);
  if (lenDelta > threshold && attack.responseHash !== baseline.responseHash) {
    if (control && Math.abs(control.bodyBytes - baseline.bodyBytes) < threshold) {
      return det(
        'bypassed',
        'medium',
        `Response body diverged by ${lenDelta} bytes when the payload was injected, while the control stayed stable`,
        'boolean:length',
      );
    }
  }
  return null;
}

export function detectTimeDelay(
  baseline: ProbeResult,
  attack: ProbeResult,
  expectedDelaySeconds: number,
): Detection | null {
  const baseMs = baseline.timing.totalMs ?? 0;
  const attackMs = attack.timing.totalMs ?? 0;
  const expectedMs = expectedDelaySeconds * 1000;
  if (attackMs - baseMs >= expectedMs * 0.7) {
    return det(
      'bypassed',
      'high',
      `Time-based injection confirmed: response took ${Math.round(attackMs)}ms versus a ${Math.round(baseMs)}ms baseline (expected +${expectedMs}ms)`,
      'time:delay',
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * XSS
 * ------------------------------------------------------------------ */

/** HTML-escape a payload the way a correct encoder would. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * A payload is reflected when the response contains it in an executable form.
 *
 * Note the two distinct cases: the raw payload appearing (potentially
 * executable) versus only its HTML-escaped form appearing (safely encoded).
 * Checking only for the raw string would miss the encoded case entirely and
 * mislabel a well-defended endpoint as untested.
 */
export function detectXssReflection(payload: string, result: ProbeResult): Detection | null {
  if (result.error || !payload) return null;
  const body = result.bodyPreview;
  if (!body) return null;

  const lowered = body.toLowerCase();
  const payloadLower = payload.toLowerCase();

  const executable =
    /<script/i.test(payload) ||
    /on\w+\s*=/i.test(payload) ||
    /javascript:/i.test(payload) ||
    /<svg|<img|<iframe|<body/i.test(payload);

  if (lowered.includes(payloadLower)) {
    const escaped = /&lt;script|&lt;img|&amp;lt;|&#x27;|&quot;|&#60;/i.test(body);
    const reflectedWithinEscaped = body.includes(escapeHtml(payload));

    if (executable && !escaped && !reflectedWithinEscaped) {
      return det(
        'bypassed',
        'high',
        'Payload reflected unescaped in the response body — reflected XSS is reachable',
        'xss:reflected-executable',
      );
    }

    return det(
      'passed',
      null,
      'Payload reflected but output-encoded — no executable sink observed in the returned HTML',
      'xss:reflected-encoded',
    );
  }

  // The raw payload never appears, but its escaped form does: the output is
  // being encoded correctly.
  if (body.includes(escapeHtml(payload))) {
    return det(
      'passed',
      null,
      'Payload appears only in its HTML-escaped form — output encoding is applied',
      'xss:reflected-encoded',
    );
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Path traversal
 * ------------------------------------------------------------------ */

export const FILE_SIGNATURES: Array<{ file: string; pattern: RegExp }> = [
  { file: '/etc/passwd', pattern: /root:.*?:0:0:/ },
  { file: '/etc/passwd', pattern: /daemon:.*?:1:1:/ },
  { file: '/etc/shadow', pattern: /root:\$[0-9][a-z]?\$/ },
  { file: 'win.ini', pattern: /for 16-bit app support/i },
  { file: 'win.ini', pattern: /\[fonts\]/i },
  { file: 'win.ini', pattern: /\[extensions\]/i },
  { file: 'boot.ini', pattern: /\[boot loader\]/i },
  { file: '/etc/hosts', pattern: /localhost\s+localhost/i },
  { file: 'web.config', pattern: /<configuration>/i },
  { file: '.env', pattern: /(APP_KEY|DB_PASSWORD|SECRET_KEY)\s*=/ },
];

export function detectFileDisclosure(result: ProbeResult): Detection | null {
  const body = result.bodyPreview;
  if (!body || result.error) return null;
  for (const { file, pattern } of FILE_SIGNATURES) {
    const match = pattern.exec(body);
    if (match) {
      return det(
        'bypassed',
        'critical',
        `File disclosure confirmed — contents of ${file} returned by the server ("${match[0].slice(0, 60)}")`,
        `traversal:${file}`,
      );
    }
  }
  if (/\.\.\//.test(body) && /No such file or directory/i.test(body)) {
    return det(
      'bypassed',
      'medium',
      'Server disclosed a filesystem path in an error message while processing traversal input',
      'traversal:path-disclosure',
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Oversized body
 * ------------------------------------------------------------------ */

export function detectOversizedBody(result: ProbeResult, requestedBytes: number): Detection {
  if (result.error) {
    return det('error', null, `Request failed: ${result.error}`);
  }
  const status = result.statusCode ?? 0;

  if (status === 413 || status === 431) {
    return det(
      'blocked',
      null,
      `Request size limit enforced — server returned HTTP ${status} for a ${formatBytes(requestedBytes)} body`,
      `size:${status}`,
    );
  }
  if (status === 400 || status === 422) {
    return det(
      'passed',
      null,
      `Malformed/oversized body correctly rejected with HTTP ${status}`,
      `size:${status}`,
    );
  }
  if (status >= 200 && status < 300) {
    return det(
      'bypassed',
      requestedBytes > 1024 * 1024 ? 'medium' : 'low',
      `Server accepted a ${formatBytes(requestedBytes)} request body with HTTP ${status} — no request-size limit was enforced`,
      `size:accepted-${status}`,
    );
  }
  if (status >= 500) {
    return det(
      'bypassed',
      'high',
      `Server returned HTTP ${status} while processing a ${formatBytes(requestedBytes)} body — the parser or upstream failed under load`,
      `size:error-${status}`,
    );
  }
  return det('inconclusive', null, `Unhandled response HTTP ${status} for oversized body`, null);
}

/* ------------------------------------------------------------------ *
 * Bot management
 * ------------------------------------------------------------------ */

/**
 * For a bot-management test the *desired* outcome is that a spoofed bot
 * User-Agent is challenged or blocked. Getting a clean 200 means the spoofed
 * identity sailed through — a gap in the bot rules.
 */
export function detectBotHandling(
  result: ProbeResult,
  userAgent: string,
  benignBaseline: ProbeResult | null,
): Detection {
  if (result.error) return det('error', null, `Request failed: ${result.error}`);

  const blocked = detectBlocked(result);
  if (blocked) {
    return { ...blocked, reason: `Bot User-Agent "${userAgent}" was ${blocked.reason}` };
  }

  const status = result.statusCode ?? 0;
  const challenged =
    /captcha|challenge|verify you are human|are you a robot|checking your browser|just a moment|enable javascript and cookies/i.test(
      result.bodyPreview,
    ) || result.responseHeaders['cf-mitigated'] !== undefined;

  if (challenged) {
    return det(
      'blocked',
      null,
      `Bot User-Agent "${userAgent}" triggered a challenge page`,
      'bot:challenge',
    );
  }

  if (status >= 200 && status < 300) {
    const sameAsBenign =
      benignBaseline?.responseHash != null && benignBaseline.responseHash === result.responseHash;
    return det(
      'bypassed',
      sameAsBenign ? 'medium' : 'low',
      `Spoofed bot User-Agent "${userAgent}" received HTTP ${status}${sameAsBenign ? ' with a byte-identical body to a normal browser request — no bot differentiation occurred' : ' with no challenge or block'}`,
      sameAsBenign ? 'bot:identical-response' : 'bot:allowed',
    );
  }

  return det('inconclusive', null, `Unhandled response HTTP ${status} for bot probe`, null);
}

/* ------------------------------------------------------------------ *
 * Brute force
 * ------------------------------------------------------------------ */

export const LOGIN_FAILURE_MARKERS = [
  'invalid credentials',
  'invalid username or password',
  'incorrect password',
  'wrong password',
  'authentication failed',
  'login failed',
  'invalid login',
  'bad credentials',
  'access denied',
  'unauthorized',
  'user not found',
];

export const LOCKOUT_MARKERS = [
  'account locked',
  'too many attempts',
  'too many failed',
  'temporarily locked',
  'try again later',
  'rate limit',
  'account has been locked',
];

export function detectLoginOutcome(
  result: ProbeResult,
  candidate: string,
  baselineFailure: ProbeResult | null,
): Detection {
  if (result.error) return det('error', null, `Attempt failed: ${result.error}`);

  const body = result.bodyPreview.toLowerCase();

  for (const marker of LOCKOUT_MARKERS) {
    if (body.includes(marker)) {
      return det(
        'blocked',
        null,
        `Lockout/rate limiting engaged after a rejected attempt ("${marker}") — credential stuffing protection is working`,
        `brute:lockout:${marker}`,
      );
    }
  }

  const looksLikeFailure = LOGIN_FAILURE_MARKERS.some((m) => body.includes(m));
  const status = result.statusCode ?? 0;

  if (!looksLikeFailure && status >= 200 && status < 300) {
    const differsFromBaseline =
      baselineFailure !== null &&
      (baselineFailure.statusCode !== result.statusCode ||
        baselineFailure.responseHash !== result.responseHash);

    return det(
      'bypassed',
      'critical',
      `Authentication accepted for password candidate "${candidate}" (HTTP ${status})${differsFromBaseline ? ' — response differs from a known-bad attempt' : ''}`,
      'brute:login-success',
    );
  }

  const redirects = status >= 300 && status < 400;
  if (redirects) {
    return det(
      'bypassed',
      'high',
      `Password candidate "${candidate}" produced a redirect (HTTP ${status}) rather than a rejection — possible successful authentication`,
      'brute:redirect',
    );
  }

  return det(
    'blocked',
    null,
    `Password candidate "${candidate}" was rejected (HTTP ${status})`,
    'brute:rejected',
  );
}

/* ------------------------------------------------------------------ *
 * IDOR
 * ------------------------------------------------------------------ */

/**
 * An IDOR is confirmed when an object the operator should not be able to read
 * returns success *and* a body that differs from the forbidden baseline.
 */
export function detectIdor(
  result: ProbeResult,
  identifier: string,
  forbiddenBaseline: ProbeResult | null,
): Detection {
  if (result.error) return det('error', null, `Request failed: ${result.error}`);
  const status = result.statusCode ?? 0;

  if (status === 401 || status === 403) {
    return det(
      'blocked',
      null,
      `Identifier ${identifier} correctly refused with HTTP ${status}`,
      `idor:${status}`,
    );
  }
  if (status === 404) {
    return det('passed', null, `Identifier ${identifier} does not exist (HTTP 404)`, 'idor:404');
  }

  if (status >= 200 && status < 300) {
    const baselineForbidden = forbiddenBaseline?.statusCode === 403 || forbiddenBaseline?.statusCode === 401;
    const hasContent = result.bodyBytes > 0 && result.bodyPreview.trim().length > 0;

    if (hasContent && baselineForbidden) {
      return det(
        'bypassed',
        'high',
        `Identifier ${identifier} returned HTTP ${status} with content while a known-forbidden identifier returned HTTP ${forbiddenBaseline?.statusCode} — broken object-level authorisation`,
        'idor:accessible',
      );
    }
    if (hasContent) {
      return det(
        'inconclusive',
        'low',
        `Identifier ${identifier} returned HTTP ${status} with content; no forbidden baseline was available to confirm escalation`,
        'idor:no-baseline',
      );
    }
  }

  return det('inconclusive', null, `Unhandled response HTTP ${status} for identifier ${identifier}`, null);
}

/* ------------------------------------------------------------------ *
 * Schema validation
 * ------------------------------------------------------------------ */

export function detectSchemaGap(
  result: ProbeResult,
  fuzzCase: string,
  contentType: string,
  expectReject: boolean,
): Detection {
  if (result.error) return det('error', null, `Request failed: ${result.error}`);
  const status = result.statusCode ?? 0;

  if (status >= 200 && status < 300) {
    if (expectReject) {
      return det(
        'bypassed',
        'medium',
        `Malformed body ${truncate(fuzzCase, 40)} was accepted with HTTP ${status} as ${contentType} — input schema is not enforced`,
        `schema:accepted-${contentType}`,
      );
    }
    return det('passed', null, `Body accepted with HTTP ${status} (acceptance not treated as a finding)`, null);
  }

  if (status === 400 || status === 415 || status === 422) {
    return det(
      'blocked',
      null,
      `Malformed body correctly rejected with HTTP ${status} for ${contentType}`,
      `schema:rejected-${status}`,
    );
  }

  if (status >= 500) {
    return det(
      'bypassed',
      'high',
      `Malformed body caused HTTP ${status} — unhandled parser exception for ${contentType}`,
      `schema:crash-${status}`,
    );
  }

  return det('inconclusive', null, `Unhandled response HTTP ${status} for schema fuzz case`, null);
}

/* ------------------------------------------------------------------ *
 * Business logic / race conditions
 * ------------------------------------------------------------------ */

export interface ReplayAnalysis {
  total: number;
  succeeded: number;
  rejected: number;
  errors: number;
  distinctResponseHashes: number;
  statuses: number[];
}

export function analyseReplays(results: ProbeResult[]): ReplayAnalysis {
  const statuses = results.map((r) => r.statusCode ?? 0);
  const hashes = new Set(results.map((r) => r.responseHash).filter((h): h is string => h !== null));
  return {
    total: results.length,
    succeeded: statuses.filter((s) => s >= 200 && s < 300).length,
    rejected: statuses.filter((s) => s === 400 || s === 403 || s === 409 || s === 429).length,
    errors: results.filter((r) => r.error !== null).length,
    distinctResponseHashes: hashes.size,
    statuses,
  };
}

export function detectLogicAbuse(
  analysis: ReplayAnalysis,
  expectSingleSuccess: boolean,
): Detection {
  if (analysis.errors === analysis.total) {
    return det('error', null, `All ${analysis.total} replays failed at the transport level`, null);
  }

  if (analysis.succeeded === 0) {
    return det(
      'blocked',
      null,
      `All ${analysis.total} replays were rejected (statuses: ${unique(analysis.statuses).join(', ')}) — replay protection is working`,
      'logic:all-rejected',
    );
  }

  if (expectSingleSuccess && analysis.succeeded > 1) {
    const raced = analysis.distinctResponseHashes > 1;
    return det(
      'bypassed',
      raced ? 'high' : 'medium',
      `${analysis.succeeded} of ${analysis.total} identical replays succeeded (statuses: ${unique(analysis.statuses).join(', ')})${raced ? ' and returned differing bodies, indicating a race condition' : ' — the operation is replayable'}`,
      raced ? 'logic:race' : 'logic:replay',
    );
  }

  if (analysis.succeeded >= 1) {
    return det(
      'passed',
      null,
      `${analysis.succeeded} of ${analysis.total} replays succeeded with a consistent response — no replay amplification observed`,
      'logic:consistent',
    );
  }

  return det('inconclusive', null, 'Replay results were inconclusive', null);
}

/* ------------------------------------------------------------------ *
 * Load tests
 * ------------------------------------------------------------------ */

export interface LoadAnalysis {
  total: number;
  ok: number;
  blocked: number;
  /**
   * The first request number the target pushed back on, or null if it never
   * did. This is the number an operator actually wants: "blocking started at
   * request 248", not "39% were rate limited".
   */
  firstBlockedIteration: number | null;
  /** First request that produced a server error, if any. */
  firstErrorIteration: number | null;
  serverErrors: number;
  transportErrors: number;
  /** Subset of transportErrors that failed during the TLS handshake. */
  tlsHandshakeFailures: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  achievedRps: number;
  durationMs: number;
  timeouts: number;
}

/** Transport errors that indicate a TLS handshake was attempted and failed. */
const TLS_ERROR_PATTERN =
  /EPROTO|wrong version number|ECONNRESET|handshake|self.signed certificate|unable to verify|CERT_|SSL|TLS|socket hang up/i;

/**
 * Status codes that mean an intermediary *deliberately* refused the request.
 *
 * Note that 503 is deliberately excluded: it is a server error, not protection
 * working. Counting it as "blocked" would report a collapsing origin as a
 * successfully defended one — the opposite conclusion.
 */
const RATE_LIMIT_STATUSES = [403, 406, 429, 451];

export function analyseLoad(
  results: Array<{
    statusCode: number | null;
    totalMs: number | null;
    error: string | null;
    /** Request number; falls back to array position when absent. */
    iteration?: number;
  }>,
  durationMs: number,
): LoadAnalysis {
  const total = results.length;
  const latencies = results
    .map((r) => r.totalMs)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);

  const pick = (q: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * q));
    return Math.round((latencies[idx] ?? 0) * 100) / 100;
  };

  const meanMs =
    latencies.length === 0
      ? 0
      : Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100;

  const iterationOf = (r: { iteration?: number }, index: number): number => r.iteration ?? index + 1;

  let firstBlockedIteration: number | null = null;
  let firstErrorIteration: number | null = null;
  results.forEach((r, index) => {
    const status = r.statusCode ?? 0;
    if (firstBlockedIteration === null && RATE_LIMIT_STATUSES.includes(status)) {
      firstBlockedIteration = iterationOf(r, index);
    }
    if (firstErrorIteration === null && (status >= 500 || r.error !== null)) {
      firstErrorIteration = iterationOf(r, index);
    }
  });

  return {
    total,
    firstBlockedIteration,
    firstErrorIteration,
    ok: results.filter((r) => (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 400).length,
    blocked: results.filter((r) => RATE_LIMIT_STATUSES.includes(r.statusCode ?? 0)).length,
    serverErrors: results.filter((r) => (r.statusCode ?? 0) >= 500).length,
    transportErrors: results.filter((r) => r.error !== null).length,
    tlsHandshakeFailures: results.filter(
      (r) => r.error !== null && TLS_ERROR_PATTERN.test(r.error),
    ).length,
    meanMs,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: latencies.length ? Math.round((latencies[latencies.length - 1] ?? 0) * 100) / 100 : 0,
    achievedRps: durationMs > 0 ? Math.round((total / (durationMs / 1000)) * 100) / 100 : 0,
    durationMs,
    timeouts: results.filter((r) => r.error !== null && /timed out/i.test(r.error)).length,
  };
}

export function detectLoadResilience(analysis: LoadAnalysis, testLabel: string): Detection {
  if (analysis.total === 0) {
    return det('error', null, 'No requests completed during the load window', null);
  }

  const reachedTarget = analysis.ok + analysis.blocked;

  // Nothing came back at all. That is a broken run — wrong scheme, wrong port,
  // DNS failure — not a degraded origin. Reporting it as a finding would raise a
  // false HIGH severity alert every time an operator mistypes a target.
  if (reachedTarget === 0) {
    const tlsish = analysis.tlsHandshakeFailures > 0;
    return det(
      'error',
      null,
      `No response was received from the target: ${analysis.transportErrors} of ${analysis.total} requests failed at the transport layer` +
        (tlsish
          ? `. ${analysis.tlsHandshakeFailures} failed during the TLS handshake — if the target serves plain HTTP, prefix the target with http://`
          : ''),
      'load:unreachable',
    );
  }

  const failureRate = (analysis.transportErrors + analysis.serverErrors) / analysis.total;

  if (analysis.blocked / analysis.total > 0.5) {
    const startedAt =
      analysis.firstBlockedIteration !== null
        ? ` Blocking began at request ${analysis.firstBlockedIteration}.`
        : '';
    return det(
      'blocked',
      null,
      `${analysis.blocked} of ${analysis.total} requests were rate-limited or blocked (${Math.round((analysis.blocked / analysis.total) * 100)}%) — protection absorbed the ${testLabel}.${startedAt}`,
      'load:rate-limited',
    );
  }

  if (failureRate > 0.25) {
    return det(
      'bypassed',
      'high',
      `${Math.round(failureRate * 100)}% of ${analysis.total} requests failed (${analysis.serverErrors} server errors, ${analysis.transportErrors} transport errors) — origin degraded under load`,
      'load:degraded',
    );
  }

  if (analysis.p95Ms > 5000) {
    return det(
      'bypassed',
      'medium',
      `p95 latency reached ${analysis.p95Ms}ms across ${analysis.total} requests — noticeable slowdown under load`,
      'load:latency',
    );
  }

  return det(
    'passed',
    null,
    `${analysis.total} requests sustained at ${analysis.achievedRps} rps with p95 ${analysis.p95Ms}ms and no significant error rate`,
    'load:stable',
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Fallback verdict when nothing more specific matched.
 *
 * Reading of status codes for an *attack* probe:
 *   2xx        the payload was accepted and nothing flagged it -> passed
 *   401 / 403  access control held -> blocked
 *   429 / 503  rate limiting held -> blocked
 *   4xx other  the input or resource was rejected -> passed
 *   5xx        the payload broke something -> bypassed
 */
export function classifyGeneric(result: ProbeResult): Detection {
  const blocked = detectBlocked(result);
  if (blocked) return blocked;
  if (result.error) return det('error', null, `Request failed: ${result.error}`);
  const status = result.statusCode ?? 0;

  if (status >= 200 && status < 300) {
    return det('passed', null, `Request completed with HTTP ${status}`, null);
  }
  if (status >= 500) {
    return det('bypassed', 'medium', `Server returned HTTP ${status} for the probe`, `status:${status}`);
  }
  if ([400, 404, 405, 406, 409, 410, 415, 422].includes(status)) {
    return det('passed', null, `Request rejected with HTTP ${status} — no vulnerable behaviour observed`, `status:${status}`);
  }
  return det('inconclusive', null, `Response HTTP ${status} was not conclusive`, null);
}
