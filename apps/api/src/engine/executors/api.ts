import {
  analyseReplays,
  classifyGeneric,
  detectBlocked,
  detectIdor,
  detectLoginOutcome,
  detectLogicAbuse,
  detectSchemaGap,
  type Detection,
} from '../detectors.ts';
import { bool, list, num, str, type BuiltRequest } from '../requestBuilder.ts';
import {
  buildFor,
  probeWith,
  findingFrom,
  makeSeqFactory,
  REFERENCES,
  recordProbe,
  runPool,
  sleep,
  type Executor,
  type ExecutorOutcome,
} from './context.ts';

/* ------------------------------------------------------------------ *
 * Brute Force Test
 * ------------------------------------------------------------------ */

const BASELINE_BAD_PASSWORD = '__eo_sectest_invalid_credential__';

export const bruteForceExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const candidates = list(ctx.config.values, 'bf.passwords');
  const delayMs = num(ctx.config.values, 'bf.delay', 100);
  const lockoutThreshold = num(ctx.config.values, 'bf.lockout_threshold', 0);
  const username = str(ctx.config.values, 'bf.username', 'admin');
  const nextSeq = makeSeqFactory(ctx);

  ctx.log(`Testing ${candidates.length} password candidates for "${username}"`);

  // A known-bad attempt establishes what rejection looks like on this endpoint.
  const baselineBuilt = buildFor(ctx, BASELINE_BAD_PASSWORD);
  const baselineFailure = await probeWith(ctx, {
    url: baselineBuilt.url,
    method: baselineBuilt.method,
    headers: baselineBuilt.headers,
    body: baselineBuilt.body,
    timeoutMs: ctx.config.options.timeoutMs,
    followRedirects: false,
    verifyTls: ctx.config.options.verifyTls,
  });

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];
  let consecutiveRejections = 0;
  let stoppedEarly = false;
  let cracked: string | null = null;

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (ctx.signal.aborted) break;
    if (lockoutThreshold > 0 && consecutiveRejections >= lockoutThreshold) {
      stoppedEarly = true;
      ctx.log(`Stopped after ${consecutiveRejections} consecutive rejections (lockout guard).`);
      break;
    }

    const built = buildFor(ctx, candidate);
    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: false,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectLoginOutcome(result, candidate, baselineFailure);
    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: candidateIndex + 1,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload: candidate,
      injectionPoint: 'body',
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      cracked = candidate;
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: `Weak credential accepted for "${username}"`,
        description: detection.reason,
        evidence: [
          `Username: ${username}`,
          `Password candidate: ${candidate}`,
          `Attempt: ${seq} of ${candidates.length}`,
          `Request: ${built.method} ${built.url}`,
          `Response: HTTP ${result.statusCode}, ${result.bodyBytes} bytes`,
          `Baseline rejected attempt: HTTP ${baselineFailure.statusCode}, hash ${baselineFailure.responseHash?.slice(0, 24) ?? 'n/a'}`,
        ].join('\n'),
        remediation:
          'Enforce a strong password policy, add rate limiting and progressive lockout on the authentication endpoint, and require MFA for privileged accounts.',
        references: REFERENCES.brute_force,
      });
      if (f) findings.push(f);
      consecutiveRejections = 0;
    } else if (detection.signature === 'brute:rejected') {
      consecutiveRejections += 1;
    } else if (detection.verdict === 'blocked') {
      consecutiveRejections += 1;
    }

    await sleep(delayMs, ctx.signal);
  }

  const attempted = verdicts.length;
  const rejected = verdicts.filter((v) => v.signature === 'brute:rejected').length;
  const lockouts = verdicts.filter((v) => v.signature?.startsWith('brute:lockout')).length;

  return {
    detection: cracked
      ? {
          verdict: 'bypassed',
          severity: 'critical',
          reason: `Password "${cracked}" was accepted for user "${username}" after ${attempted} attempt(s)`,
          signature: 'brute:login-success',
        }
      : lockouts > 0
        ? {
            verdict: 'blocked',
            severity: null,
            reason: `Lockout or rate limiting engaged after ${attempted} attempt(s)`,
            signature: 'brute:lockout',
          }
        : {
            verdict: 'blocked',
            severity: null,
            reason: `${rejected} of ${attempted} attempts rejected with no successful authentication`,
            signature: 'brute:all-rejected',
          },
    findings,
    metrics: {
      candidates: candidates.length,
      attempted,
      rejected,
      lockouts,
      stoppedEarly: stoppedEarly ? 'yes' : 'no',
      baselineStatus: baselineFailure.statusCode,
      targetUsername: username,
    },
  };
};

/* ------------------------------------------------------------------ *
 * IDOR Enumeration
 * ------------------------------------------------------------------ */

export const idorExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const start = num(ctx.config.values, 'idor.start', 1);
  const end = num(ctx.config.values, 'idor.end', 10);
  const step = Math.max(1, num(ctx.config.values, 'idor.step', 1));
  const baselineId = num(ctx.config.values, 'idor.baseline_id', 0);
  const nextSeq = makeSeqFactory(ctx);

  const ids: number[] = [];
  // `step` is Math.max(1, …) above, so a `step > 0` guard here was dead code.
  for (let id = start; id <= end && ids.length < ctx.budget.maxRequests; id += step) {
    ids.push(id);
  }

  ctx.log(`Enumerating ${ids.length} identifiers (${start} → ${end}, step ${step})`);

  // A known-forbidden identifier tells us what "denied" looks like on this API.
  const baselineBuilt = buildFor(ctx, String(baselineId));
  const forbiddenBaseline = await probeWith(ctx, {
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
  const accessible: number[] = [];
  const inaccessible: number[] = [];
  const hashes = new Set<string>();

  for (const [idIndex, id] of ids.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, String(id));
    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectBlocked(result) ?? detectIdor(result, String(id), forbiddenBaseline);
    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: idIndex + 1,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload: String(id),
      injectionPoint: built.injectionPoint,
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      accessible.push(id);
      if (result.responseHash) hashes.add(result.responseHash);
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: `Object identifier ${id} accessible without authorisation`,
        description: detection.reason,
        evidence: [
          `Identifier: ${id}`,
          `Request: ${built.method} ${built.url}`,
          `Response: HTTP ${result.statusCode}, ${result.bodyBytes} bytes`,
          `Baseline forbidden identifier ${baselineId}: HTTP ${forbiddenBaseline.statusCode}`,
          `Response preview: ${result.bodyPreview.slice(0, 300).replace(/\s+/g, ' ').trim()}`,
        ].join('\n'),
        remediation:
          'Enforce object-level authorisation on every record fetch — verify the authenticated principal owns or may access the requested identifier, rather than relying on unguessable identifiers.',
        references: REFERENCES.idor_enumeration,
      });
      if (f) findings.push(f);
    } else if (detection.signature?.startsWith('idor:')) {
      inaccessible.push(id);
    }
  }

  const bypassed = accessible.length;

  return {
    detection:
      bypassed > 0
        ? {
            verdict: 'bypassed',
            severity: bypassed > ids.length / 2 ? 'high' : 'medium',
            reason: `${bypassed} of ${ids.length} enumerated identifiers were accessible (${accessible.slice(0, 10).join(', ')}${accessible.length > 10 ? '…' : ''})`,
            signature: 'idor:enumerable',
          }
        : {
            verdict: 'blocked',
            severity: null,
            reason: `All ${ids.length} enumerated identifiers were refused`,
            signature: 'idor:all-refused',
          },
    findings,
    metrics: {
      identifiersTested: ids.length,
      accessible: bypassed,
      inaccessible: inaccessible.length,
      distinctBodies: hashes.size,
      baselineId,
      baselineStatus: forbiddenBaseline.statusCode,
      accessibleIds: accessible.slice(0, 50).join(','),
    },
  };
};

/* ------------------------------------------------------------------ *
 * Schema Validation Test
 * ------------------------------------------------------------------ */

export const schemaValidationExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const fuzzCases = list(ctx.config.values, 'sv.fuzz_cases');
  const contentTypes = list(ctx.config.values, 'sv.content_types');
  const expectReject = bool(ctx.config.values, 'sv.expect_reject', true);
  const nextSeq = makeSeqFactory(ctx);

  const combinations: Array<{ body: string; contentType: string }> = [];
  for (const contentType of contentTypes) {
    for (const body of fuzzCases) {
      combinations.push({ body, contentType });
    }
  }

  ctx.log(`Fuzzing ${combinations.length} body/content-type combinations`);

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];

  for (const [comboIndex, combo] of combinations.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, null);
    const headers = { ...built.headers, 'Content-Type': combo.contentType };

    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers,
      body: combo.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectBlocked(result) ?? detectSchemaGap(result, combo.body, combo.contentType, expectReject);
    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: comboIndex + 1,
      method: built.method,
      url: built.url,
      headers,
      body: combo.body,
      payload: combo.body,
      injectionPoint: 'body',
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: `Malformed body accepted as ${combo.contentType}`,
        description: detection.reason,
        evidence: [
          `Content-Type: ${combo.contentType}`,
          `Body: ${combo.body}`,
          `Request: ${built.method} ${built.url}`,
          `Response: HTTP ${result.statusCode}, ${result.bodyBytes} bytes`,
          `Response preview: ${result.bodyPreview.slice(0, 240).replace(/\s+/g, ' ').trim()}`,
        ].join('\n'),
        remediation:
          'Validate every request body against an explicit schema before processing, and reject unknown or malformed payloads with HTTP 400. Do not rely on content sniffing.',
        references: REFERENCES.schema_validation,
      });
      if (f) findings.push(f);
    }
  }

  const accepted = verdicts.filter((v) => v.signature?.startsWith('schema:accepted')).length;
  const rejected = verdicts.filter((v) => v.signature?.startsWith('schema:rejected')).length;
  const crashes = verdicts.filter((v) => v.signature?.startsWith('schema:crash')).length;

  return {
    detection:
      accepted + crashes > 0
        ? {
            verdict: 'bypassed',
            severity: crashes > 0 ? 'high' : 'medium',
            reason:
              crashes > 0
                ? `${crashes} malformed payload(s) caused server errors and ${accepted} were accepted`
                : `${accepted} of ${combinations.length} malformed payloads were accepted with a success status`,
            signature: 'schema:gap',
          }
        : {
            verdict: 'blocked',
            severity: null,
            reason: `${rejected} of ${combinations.length} malformed payloads correctly rejected`,
            signature: 'schema:strict',
          },
    findings,
    metrics: {
      combinationsTested: combinations.length,
      accepted,
      rejected,
      serverErrors: crashes,
      contentTypes: contentTypes.length,
      fuzzCases: fuzzCases.length,
    },
  };
};

/* ------------------------------------------------------------------ *
 * Business Logic Test
 * ------------------------------------------------------------------ */

export const businessLogicExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const replayCount = Math.min(num(ctx.config.values, 'bl.replay_count', 10), ctx.budget.maxRequests);
  const delayMs = num(ctx.config.values, 'bl.delay', 100);
  const concurrent = bool(ctx.config.values, 'bl.concurrent', true);
  const nextSeq = makeSeqFactory(ctx);

  ctx.log(`Replaying request ${replayCount}× ${concurrent ? 'concurrently' : `with ${delayMs}ms spacing`}`);

  const built = buildFor(ctx, null);
  // Through probeWith, so the run's egress proxy applies here too.
  const send = () =>
    probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

  const results: Awaited<ReturnType<typeof send>>[] = [];

  if (concurrent) {
    // Fire everything at once to widen the race window.
    const all = await Promise.all(Array.from({ length: replayCount }, () => send()));
    results.push(...all);
  } else {
    for (let i = 0; i < replayCount; i += 1) {
      if (ctx.signal.aborted) break;
      results.push(await send());
      await sleep(delayMs, ctx.signal);
    }
  }

  const analysis = analyseReplays(results);
  const detection = detectLogicAbuse(analysis, true);

  // Trace sequence numbers for this test, so any finding can cite its evidence
  // rather than pointing at nothing.
  const traceSeqs: number[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const seq = await recordProbe({
      ctx,
      nextSeq,
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      payload: null,
      injectionPoint: null,
      result,
      detection: {
        verdict: result.error
          ? 'error'
          : (result.statusCode ?? 0) >= 200 && (result.statusCode ?? 0) < 300
            ? detection.verdict === 'bypassed'
              ? 'bypassed'
              : 'passed'
            : 'blocked',
        severity: detection.verdict === 'bypassed' && detection.severity ? detection.severity : null,
        reason: `Replay ${i + 1}/${results.length}: HTTP ${result.statusCode ?? 'err'} in ${Math.round(result.timing.totalMs ?? 0)}ms`,
        signature: detection.signature,
      },
    });
    traceSeqs.push(seq);
  }

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  if (detection.verdict === 'bypassed') {
    const f = findingFrom(ctx.config.testId, detection, traceSeqs, {
      title: 'Business-logic operation is replayable',
      description: detection.reason,
      evidence: [
        `Replays issued: ${analysis.total} (${concurrent ? 'concurrent' : `spaced ${delayMs}ms`})`,
        `Successes: ${analysis.succeeded}, rejections: ${analysis.rejected}, transport errors: ${analysis.errors}`,
        `Status codes observed: ${[...new Set(analysis.statuses)].sort((a, b) => a - b).join(', ')}`,
        `Distinct response bodies: ${analysis.distinctResponseHashes}`,
        `Request: ${built.method} ${built.url}`,
      ].join('\n'),
      remediation:
        'Make the operation idempotent with a server-side idempotency key, and enforce the business constraint in a transaction or with row-level locking so concurrent replays cannot each succeed.',
      references: REFERENCES.business_logic,
    });
    if (f) findings.push(f);
  }

  return {
    detection,
    findings,
    metrics: {
      replays: analysis.total,
      succeeded: analysis.succeeded,
      rejected: analysis.rejected,
      transportErrors: analysis.errors,
      distinctBodies: analysis.distinctResponseHashes,
      concurrent: concurrent ? 'yes' : 'no',
      statusCodes: [...new Set(analysis.statuses)].sort((a, b) => a - b).join(','),
    },
  };
};

export { runPool, classifyGeneric, detectBlocked };
export type { BuiltRequest };
