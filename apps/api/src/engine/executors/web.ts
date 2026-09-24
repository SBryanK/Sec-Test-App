import type { InjectionPoint } from '@teo/shared';
import { probe } from '../httpClient.ts';
import {
  classifyGeneric,
  detectAuthBypass,
  detectBlocked,
  detectBooleanDivergence,
  detectFileDisclosure,
  detectOversizedBody,
  detectSqlError,
  detectTimeDelay,
  detectXssReflection,
  formatBytes,
  type Detection,
} from '../detectors.ts';
import { bool, buildRequest, generateOversizedBody, list, num, type BuiltRequest } from '../requestBuilder.ts';
import {
  buildFor,
  probeWith,
  findingFrom,
  makeSeqFactory,
  REFERENCES,
  recordProbe,
  type Executor,
  type ExecutorOutcome,
} from './context.ts';

const TIME_BASED_PATTERN = /(sleep\s*\(|waitfor\s+delay|pg_sleep|benchmark\s*\(|randomblob\s*\()/i;

/* ------------------------------------------------------------------ *
 * SQL Injection Test
 * ------------------------------------------------------------------ */

export const sqlInjectionExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const payloads = list(ctx.config.values, 'sql.payloads');
  const delaySeconds = num(ctx.config.values, 'sql.time_delay', 5);
  const nextSeq = makeSeqFactory(ctx);

  ctx.log(`Testing ${payloads.length} SQL payloads`);

  const send = async (built: BuiltRequest) =>
    probe({
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: Math.max(ctx.config.options.timeoutMs, delaySeconds * 1000 + 5000),
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

  // Baseline + control give the boolean/time comparisons a reference point.
  // The baseline uses a benign value; the control uses a *different* benign
  // value so that "the response changed" can be attributed to the payload
  // rather than to the parameter simply varying.
  const baselineBuilt = buildFor(ctx, '1');
  const baseline = await send(baselineBuilt);

  const controlBuilt = buildFor(ctx, '2');
  const control = await send(controlBuilt);

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];
  let worst: Detection = {
    verdict: 'passed',
    severity: null,
    reason: `Baseline completed with HTTP ${baseline.statusCode}`,
    signature: null,
  };

  for (const [payloadIndex, payload] of payloads.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, payload);
    const result = await send(built);

    let detection: Detection | null = detectBlocked(result);
    if (!detection) detection = detectSqlError(result);
    if (!detection && TIME_BASED_PATTERN.test(payload)) {
      detection = detectTimeDelay(baseline, result, delaySeconds);
    }
    // An accepted-where-it-should-be-rejected flip is the strongest signal, so
    // it is checked before the weaker statistical divergence test.
    if (!detection) detection = detectAuthBypass(baseline, result);
    if (!detection) detection = detectBooleanDivergence(baseline, result, control);
    // No evidence is an honest "passed" — never relabelled as blocked, which
    // would misreport an unprotected endpoint as defended.
    if (!detection) detection = classifyGeneric(result);

    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: payloadIndex + 1,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload,
      injectionPoint: built.injectionPoint,
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: 'SQL injection reached the database layer',
        description: detection.reason,
        evidence: buildEvidence(payload, built, result.statusCode, result.bodyPreview, result.timing.ttfbMs),
        remediation:
          'Use parameterised queries or prepared statements for every database call. Validate and allow-list input types server-side, and suppress database error detail from responses.',
        references: REFERENCES.sql_injection,
      });
      if (f) findings.push(f);
      worst = detection;
    } else if (detection.verdict === 'error' && worst.verdict === 'passed') {
      worst = detection;
    }
  }

  const bypassed = verdicts.filter((v) => v.verdict === 'bypassed').length;
  const blocked = verdicts.filter((v) => v.verdict === 'blocked').length;

  const summary: Detection =
    worst.verdict === 'bypassed'
      ? worst
      : bypassed === 0 && blocked === payloads.length && payloads.length > 0
        ? {
            verdict: 'blocked',
            severity: null,
            reason: `All ${payloads.length} SQL payloads were rejected or produced no database evidence`,
            signature: 'sql:all-blocked',
          }
        : {
            verdict: 'passed',
            severity: null,
            reason: `${payloads.length} payloads tested — no SQL injection evidence found`,
            signature: null,
          };

  return {
    detection: summary,
    findings,
    metrics: {
      payloadsTested: payloads.length,
      bypassed,
      blocked,
      baselineStatus: baseline.statusCode,
      baselineTtfbMs: baseline.timing.ttfbMs,
      controlStatus: control.statusCode,
    },
  };
};

/* ------------------------------------------------------------------ *
 * XSS Test
 * ------------------------------------------------------------------ */

export const xssExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const payloads = list(ctx.config.values, 'xss.payloads');
  const nextSeq = makeSeqFactory(ctx);

  ctx.log(`Testing ${payloads.length} XSS payloads`);

  const baselineBuilt = buildFor(ctx, 'benign_probe_value');
  const baseline = await probeWith(ctx, {
    url: baselineBuilt.url,
    method: baselineBuilt.method,
    headers: baselineBuilt.headers,
    body: baselineBuilt.body,
    timeoutMs: ctx.config.options.timeoutMs,
    followRedirects: ctx.config.options.followRedirects,
    verifyTls: ctx.config.options.verifyTls,
  });

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];
  let found = false;

  for (const [payloadIndex, payload] of payloads.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, payload);
    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectBlocked(result) ?? detectXssReflection(payload, result) ?? classifyGeneric(result);

    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: payloadIndex + 1,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload,
      injectionPoint: built.injectionPoint,
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      found = true;
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: 'Cross-site scripting payload reflected unescaped',
        description: detection.reason,
        evidence: buildEvidence(payload, built, result.statusCode, result.bodyPreview, result.timing.ttfbMs),
        remediation:
          'Context-aware output encoding for all user-controlled data, a strict Content-Security-Policy, and HTML sanitisation where rich text is genuinely required.',
        references: REFERENCES.xss,
      });
      if (f) findings.push(f);
    }
  }

  const bypassed = verdicts.filter((v) => v.verdict === 'bypassed').length;
  const reflectedEncoded = verdicts.filter(
    (v) => v.verdict === 'passed' && v.signature === 'xss:reflected-encoded',
  ).length;

  return {
    detection: found
      ? (verdicts.find((v) => v.verdict === 'bypassed') as Detection)
      : verdicts.some((v) => v.verdict === 'blocked')
        ? {
            verdict: 'blocked',
            severity: null,
            reason: 'XSS payloads were blocked or filtered before reaching the response',
            signature: 'xss:blocked',
          }
        : {
            verdict: 'passed',
            severity: null,
            reason:
              reflectedEncoded > 0
                ? `${reflectedEncoded} payload(s) reflected but output-encoded — no executable sink observed`
                : `${payloads.length} payloads tested — no reflection observed`,
            signature: null,
          },
    findings,
    metrics: {
      payloadsTested: payloads.length,
      bypassed,
      reflectedEncoded,
      baselineStatus: baseline.statusCode,
    },
  };
};

/* ------------------------------------------------------------------ *
 * Path Traversal Test
 * ------------------------------------------------------------------ */

export const pathTraversalExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const payloads = list(ctx.config.values, 'pt.payloads');
  const encoding = String(ctx.config.values['pt.encoding'] ?? 'auto');
  const nextSeq = makeSeqFactory(ctx);

  const variants = expandEncodings(payloads, encoding);
  ctx.log(`Testing ${variants.length} traversal variants`);

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];
  let found = false;

  for (const [variantIndex, { value, variant }] of variants.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, value);
    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectBlocked(result) ?? detectFileDisclosure(result) ?? classifyGeneric(result);
    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: variantIndex + 1,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload: value,
      injectionPoint: built.injectionPoint,
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      found = true;
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: 'Path traversal exposed files outside the web root',
        description: `${detection.reason} (encoding variant: ${variant})`,
        evidence: buildEvidence(value, built, result.statusCode, result.bodyPreview, result.timing.ttfbMs),
        remediation:
          'Resolve and canonicalise every filesystem path, then verify it stays inside an allow-listed base directory. Never pass user input directly to file APIs.',
        references: REFERENCES.path_traversal,
      });
      if (f) findings.push(f);
    }
  }

  const bypassed = verdicts.filter((v) => v.verdict === 'bypassed').length;

  return {
    detection: found
      ? (verdicts.find((v) => v.verdict === 'bypassed') as Detection)
      : verdicts.some((v) => v.verdict === 'blocked')
        ? {
            verdict: 'blocked',
            severity: null,
            reason: 'Traversal payloads were blocked before reaching the filesystem',
            signature: 'traversal:blocked',
          }
        : {
            verdict: 'passed',
            severity: null,
            reason: `${variants.length} traversal variants tested — no file disclosure observed`,
            signature: null,
          },
    findings,
    metrics: {
      variantsTested: variants.length,
      bypassed,
      encoding,
    },
  };
};

/** Expand traversal payloads across the requested encoding variants. */
function expandEncodings(
  payloads: string[],
  encoding: string,
): Array<{ value: string; variant: string }> {
  const out: Array<{ value: string; variant: string }> = [];
  const modes =
    encoding === 'auto' ? ['plain', 'url', 'double', 'unicode'] : [encoding];

  for (const payload of payloads) {
    for (const mode of modes) {
      switch (mode) {
        case 'url':
          out.push({ value: encodeURIComponent(payload), variant: 'url' });
          break;
        case 'double':
          out.push({ value: encodeURIComponent(encodeURIComponent(payload)), variant: 'double-url' });
          break;
        case 'unicode':
          out.push({
            value: payload.replace(/\.\./g, '%c0%ae%c0%ae').replace(/[\\/]/g, '%c0%af'),
            variant: 'unicode-overlong',
          });
          break;
        default:
          out.push({ value: payload, variant: 'plain' });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Oversized Body Test
 * ------------------------------------------------------------------ */

export const oversizedBodyExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const sizeKb = num(ctx.config.values, 'ob.body_size_kb', 1024);
  const fieldCount = num(ctx.config.values, 'ob.json_field_count', 1000);
  const duplicateKeys = bool(ctx.config.values, 'ob.duplicate_keys', false);
  const depth = num(ctx.config.values, 'ob.deep_nesting', 1);
  const nextSeq = makeSeqFactory(ctx);

  const body = generateOversizedBody(sizeKb, fieldCount, duplicateKeys, depth);
  const actualBytes = Buffer.byteLength(body, 'utf8');
  ctx.log(`Sending ${formatBytes(actualBytes)} JSON body`);

  const built = buildFor(ctx, null);
  const result = await probeWith(ctx, {
    url: built.url,
    method: built.method,
    headers: { ...built.headers, 'Content-Type': 'application/json' },
    body,
    timeoutMs: Math.max(ctx.config.options.timeoutMs, 60_000),
    followRedirects: false,
    verifyTls: ctx.config.options.verifyTls,
  });

  const detection = detectOversizedBody(result, actualBytes);
  const seq = await recordProbe({
    ctx,
    nextSeq,
    method: built.method,
    url: built.url,
    headers: { ...built.headers, 'Content-Type': 'application/json' },
    body,
    payload: null,
    injectionPoint: null,
    result,
    detection,
  });

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  if (detection.verdict === 'bypassed') {
    const f = findingFrom(ctx.config.testId, detection, [seq], {
      title: 'Oversized request body was accepted',
      description: detection.reason,
      evidence:
        `Body size: ${formatBytes(actualBytes)} (${sizeKb} KB requested, ${fieldCount} JSON fields)\n` +
        `Status: HTTP ${result.statusCode}\n` +
        `Upload time: ${result.timing.totalMs}ms, first byte ${result.timing.ttfbMs}ms\n` +
        `Request bytes: ${formatBytes(result.requestBytes)}`,
      remediation:
        'Enforce a request body size limit at the edge (client_max_body_size / equivalent) and reject oversized payloads before they reach the application parser.',
      references: REFERENCES.oversized_body,
    });
    if (f) findings.push(f);
  }

  return {
    detection,
    findings,
    metrics: {
      requestedKb: sizeKb,
      actualBytes,
      actualKb: Math.round((actualBytes / 1024) * 100) / 100,
      jsonFieldCount: fieldCount,
      nestingDepth: depth,
      duplicateKeys: duplicateKeys ? 'yes' : 'no',
      statusCode: result.statusCode,
      uploadMs: result.timing.totalMs,
    },
  };
};

/* ------------------------------------------------------------------ *
 * Shared evidence formatting
 * ------------------------------------------------------------------ */

function buildEvidence(
  payload: string,
  built: BuiltRequest,
  statusCode: number | null,
  bodyPreview: string,
  ttfbMs: number | null,
): string {
  const matched = extractEvidence(bodyPreview);
  return [
    `Payload: ${truncate(payload, 200)}`,
    `Request: ${built.method} ${built.url}`,
    `Injection point: ${built.injectionPoint ?? 'n/a'}`,
    `Response: HTTP ${statusCode}, first byte ${ttfbMs ?? '?'}ms`,
    matched ? `Matched evidence: ${truncate(matched, 300)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pull the most telling line out of a response body for the finding record. */
function extractEvidence(body: string): string {
  if (!body) return '';
  const patterns = [
    /root:.*?:0:0:[^\n]*/,
    /(SQL syntax[^\n]{0,120})/i,
    /(ORA-\d{5}[^\n]{0,80})/i,
    /(Unclosed quotation mark[^\n]{0,80})/i,
    /(<script[^>]*>[^\n]{0,120})/i,
    /(onerror\s*=\s*[^\s>]{0,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match) return match[0];
  }
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export type { InjectionPoint };
