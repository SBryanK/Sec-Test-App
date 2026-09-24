import { probe } from '../httpClient.ts';
import {
  classifyGeneric,
  detectBlocked,
  detectBotHandling,
  type Detection,
} from '../detectors.ts';
import { bool, buildRequest, list, num, str } from '../requestBuilder.ts';
import {
  probeWith,
  buildFor,
  findingFrom,
  makeSeqFactory,
  REFERENCES,
  recordProbe,
  sleep,
  type Executor,
  type ExecutorContext,
  type ExecutorOutcome,
} from './context.ts';

/* ------------------------------------------------------------------ *
 * User-Agent Anomaly Test
 * ------------------------------------------------------------------ */

const DEFAULT_BOT_UAS = [
  'Googlebot/2.1 (+http://www.google.com/bot.html)',
  'curl/7.68.0',
  'python-requests/2.28.1',
  'PostmanRuntime/7.29.2',
];

export const userAgentAnomalyExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const profiles = list(ctx.config.values, 'ua.profiles');
  const uas = profiles.length > 0 ? profiles : DEFAULT_BOT_UAS;
  const stealth = bool(ctx.config.values, 'ua.stealth', false);
  const acceptLanguage = str(ctx.config.values, 'ua.accept_language', 'en-US,en;q=0.9');
  const nextSeq = makeSeqFactory(ctx);

  ctx.log(`Replaying ${uas.length} bot User-Agent profiles`);

  // A normal browser request is the control: if a spoofed bot gets a byte-identical
  // response, the bot rules are not differentiating at all.
  const benignHeaders: Record<string, string> = stealth
    ? {}
    : {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate',
      };
  const benignBuilt = buildFor(ctx, null);
  const benign = await probeWith(ctx, {
    url: benignBuilt.url,
    method: benignBuilt.method,
    headers: {
      ...benignBuilt.headers,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ...benignHeaders,
    },
    timeoutMs: ctx.config.options.timeoutMs,
    followRedirects: ctx.config.options.followRedirects,
    verifyTls: ctx.config.options.verifyTls,
  });

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];

  for (const [uaIndex, ua] of uas.entries()) {
    if (ctx.signal.aborted) break;
    const built = buildFor(ctx, null);
    const headers: Record<string, string> = {
      ...built.headers,
      'User-Agent': ua,
      ...benignHeaders,
    };
    if (stealth) {
      // Minimal-header mode: only Host + User-Agent, the way a naive script behaves.
      for (const key of Object.keys(headers)) {
        if (!['user-agent', 'host', 'accept'].includes(key.toLowerCase())) delete headers[key];
      }
    }

    const result = await probeWith(ctx, {
      url: built.url,
      method: built.method,
      headers,
      body: built.body,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
    });

    const detection = detectBotHandling(result, ua, benign);
    const seq = await recordProbe({
      ctx,
      nextSeq,
      iteration: uaIndex + 1,
      method: built.method,
      url: built.url,
      headers,
      body: built.body,
      payload: ua,
      injectionPoint: 'header',
      result,
      detection,
    });
    verdicts.push(detection);

    if (detection.verdict === 'bypassed') {
      const f = findingFrom(ctx.config.testId, detection, [seq], {
        title: `Bot User-Agent "${shortUa(ua)}" was not challenged`,
        description: detection.reason,
        evidence: [
          `Spoofed User-Agent: ${ua}`,
          `Header mode: ${stealth ? 'minimal (stealth)' : 'full browser header set'}`,
          `Response: HTTP ${result.statusCode}, ${result.bodyBytes} bytes, first byte ${result.timing.ttfbMs}ms`,
          `Benign browser control: HTTP ${benign.statusCode}, hash ${benign.responseHash?.slice(0, 24) ?? 'n/a'}`,
          `Spoofed bot response hash: ${result.responseHash?.slice(0, 24) ?? 'n/a'}`,
        ].join('\n'),
        remediation:
          'Add the tooling and crawler User-Agent classes to a bot-management rule, and pair User-Agent scoring with behavioural signals so a trivially spoofed header alone cannot impersonate a browser.',
        references: REFERENCES.user_agent_anomaly,
      });
      if (f) findings.push(f);
    }
  }

  const bypassed = verdicts.filter((v) => v.verdict === 'bypassed').length;
  const blocked = verdicts.filter((v) => v.verdict === 'blocked').length;

  return {
    detection:
      bypassed > 0
        ? {
            verdict: 'bypassed',
            severity: bypassed === uas.length ? 'medium' : 'low',
            reason: `${bypassed} of ${uas.length} spoofed bot User-Agents were served without a challenge`,
            signature: 'bot:bypassed',
          }
        : blocked > 0
          ? {
              verdict: 'blocked',
              severity: null,
              reason: `${blocked} of ${uas.length} spoofed bot User-Agents were challenged or blocked`,
              signature: 'bot:blocked',
            }
          : {
              verdict: 'passed',
              severity: null,
              reason: `${uas.length} User-Agent profiles replayed with no differentiating response`,
              signature: null,
            },
    findings,
    metrics: {
      profilesTested: uas.length,
      bypassed,
      challenged: blocked,
      stealthMode: stealth ? 'on' : 'off',
      benignStatus: benign.statusCode,
    },
  };
};

function shortUa(ua: string): string {
  const token = ua.split(/[\s(/]/)[0] ?? ua;
  return token.length > 40 ? `${token.slice(0, 39)}…` : token;
}

/* ------------------------------------------------------------------ *
 * Web Crawler Test
 * ------------------------------------------------------------------ */

const LINK_RE = /href\s*=\s*["']([^"'#]+)["']/gi;

export const webCrawlerExecutor: Executor = async (ctx): Promise<ExecutorOutcome> => {
  const depth = Math.max(1, Math.min(num(ctx.config.values, 'crawl.depth', 2), 5));
  const respectRobots = String(ctx.config.values['crawl.respect_robots'] ?? 'yes') === 'yes';
  const maxPages = Math.min(num(ctx.config.values, 'crawl.max_pages', 100), ctx.budget.maxRequests);
  const delayMs = num(ctx.config.values, 'crawl.delay', 50);
  const nextSeq = makeSeqFactory(ctx);

  const disallowed = respectRobots ? await fetchRobots(ctx) : [];

  ctx.log(
    `Crawling depth ${depth}, max ${maxPages} pages` +
      (respectRobots ? ` (robots.txt: ${disallowed.length} disallow rules)` : ' (robots.txt ignored)'),
  );

  const findings: NonNullable<ReturnType<typeof findingFrom>>[] = [];
  const verdicts: Detection[] = [];
  const seen = new Set<string>();
  const queue: Array<{ url: string; level: number }> = [
    { url: buildFor(ctx, String(depth)).url, level: 0 },
  ];

  let fetched = 0;
  let throttled = 0;
  let skippedByRobots = 0;
  const statusCounts: Record<string, number> = {};
  let firstThrottleSeq: number | null = null;

  while (queue.length > 0 && fetched < maxPages && !ctx.signal.aborted) {
    const node = queue.shift();
    if (!node) break;
    if (seen.has(node.url)) continue;
    seen.add(node.url);

    if (disallowed.some((rule) => matchesRobots(node.url, rule))) {
      skippedByRobots += 1;
      continue;
    }

    const built = {
      ...buildFor(ctx, null),
      url: node.url,
      payload: String(depth),
    };

    const result = await probeWith(ctx, {
      url: node.url,
      method: 'GET',
      headers: buildFor(ctx, null).headers,
      timeoutMs: ctx.config.options.timeoutMs,
      followRedirects: ctx.config.options.followRedirects,
      verifyTls: ctx.config.options.verifyTls,
      maxBodyBytes: 2 * 1024 * 1024,
    });

    fetched += 1;
    const key = String(result.statusCode ?? 'err');
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;

    const blocked = detectBlocked(result);
    const isThrottled = blocked !== null || [429, 503].includes(result.statusCode ?? 0);
    if (isThrottled) throttled += 1;

    const detection: Detection = blocked ?? {
      verdict: 'passed',
      severity: null,
      reason: `Fetched depth ${node.level} page with HTTP ${result.statusCode}`,
      signature: null,
    };

    const seq = await recordProbe({
      ctx,
      nextSeq,
      method: 'GET',
      url: node.url,
      headers: built.headers,
      body: null,
      payload: null,
      injectionPoint: null,
      result,
      detection,
    });
    if (isThrottled && firstThrottleSeq === null) firstThrottleSeq = seq;
    verdicts.push(detection);

    // Only descend if there is budget and depth remaining.
    if (node.level + 1 < depth && fetched + queue.length < maxPages && !isThrottled) {
      const base = new URL(node.url);
      for (const match of result.bodyPreview.matchAll(LINK_RE)) {
        const href = match[1];
        if (!href) continue;
        try {
          const resolved = new URL(href, base);
          if (resolved.host !== base.host) continue;
          if (!/^https?:$/.test(resolved.protocol)) continue;
          resolved.hash = '';
          const normalised = resolved.toString();
          if (!seen.has(normalised)) queue.push({ url: normalised, level: node.level + 1 });
        } catch {
          /* ignore malformed links */
        }
      }
    }

    await sleep(delayMs, ctx.signal);
  }

  // A crawler is only a finding when the target failed to throttle it at all.
  const crawlWasThrottled = throttled > 0;
  if (!crawlWasThrottled && fetched >= 10) {
    const detection: Detection = {
      verdict: 'bypassed',
      severity: 'low',
      reason: `${fetched} pages were crawled across ${depth} level(s) with no rate limiting or bot challenge observed`,
      signature: 'crawler:unthrottled',
    };
    const f = findingFrom(ctx.config.testId, detection, [], {
      title: 'Aggressive crawling was not throttled',
      description: detection.reason,
      evidence: [
        `Pages fetched: ${fetched} (depth ${depth}, delay ${delayMs}ms)`,
        `Status distribution: ${JSON.stringify(statusCounts)}`,
        `robots.txt: ${respectRobots ? `respected (${disallowed.length} disallow rules, ${skippedByRobots} URLs skipped)` : 'ignored by configuration'}`,
        `Throttled responses: ${throttled}`,
      ].join('\n'),
      remediation:
        'Apply bot-management rate limiting to crawler-class traffic and alert on rapid sequential traversal from a single client.',
      references: REFERENCES.web_crawler,
    });
    if (f) findings.push(f);
    verdicts.push(detection);
  }

  return {
    detection: crawlWasThrottled
      ? {
          verdict: 'blocked',
          severity: null,
          reason: `Crawl was throttled after ${fetched} pages (${throttled} rate-limited responses)`,
          signature: 'crawler:throttled',
        }
      : fetched >= 10
        ? {
            verdict: 'bypassed',
            severity: 'low',
            reason: `${fetched} pages crawled without throttling`,
            signature: 'crawler:unthrottled',
          }
        : {
            verdict: 'passed',
            severity: null,
            reason: `Crawled ${fetched} pages — volume too low to assess crawler throttling`,
            signature: null,
          },
    findings,
    metrics: {
      pagesFetched: fetched,
      depth,
      maxPages,
      throttledResponses: throttled,
      firstThrottleSeq,
      skippedByRobots,
      statusDistribution: JSON.stringify(statusCounts),
      respectRobots: respectRobots ? 'yes' : 'no',
    },
  };
};

/** Fetch and parse robots.txt Disallow rules for the target origin. */
async function fetchRobots(ctx: ExecutorContext): Promise<string[]> {
  // robots.txt is fetched with the same identity as the rest of the run, so a
  // distinct tool User-Agent does not appear in the target's logs.
  const robotsHeaders = buildFor(ctx, null).headers;
  const result = await probeWith(ctx, {
    url: `${ctx.target.origin}/robots.txt`,
    method: 'GET',
    headers: { ...robotsHeaders, Accept: 'text/plain' },
    timeoutMs: Math.min(ctx.config.options.timeoutMs, 8000),
    followRedirects: true,
    verifyTls: ctx.config.options.verifyTls,
    maxBodyBytes: 256 * 1024,
  });
  if (result.error || (result.statusCode ?? 0) >= 400) return [];
  return result.bodyPreview
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^disallow:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim())
    .filter((path) => path.length > 0);
}

function matchesRobots(url: string, rule: string): boolean {
  try {
    const path = new URL(url).pathname;
    if (rule === '/') return true;
    return path.startsWith(rule.replace(/\*$/, ''));
  } catch {
    return false;
  }
}

export { classifyGeneric };
