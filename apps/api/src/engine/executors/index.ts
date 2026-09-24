import type { AttackConfig, TestId } from '@teo/shared';
import { list, str, num } from '../requestBuilder.ts';
import type { Executor } from './context.ts';
import { connectionFloodExecutor, httpSpikeExecutor } from './dos.ts';
import { oversizedBodyExecutor, pathTraversalExecutor, sqlInjectionExecutor, xssExecutor } from './web.ts';
import { userAgentAnomalyExecutor, webCrawlerExecutor } from './bot.ts';
import {
  bruteForceExecutor,
  businessLogicExecutor,
  idorExecutor,
  schemaValidationExecutor,
} from './api.ts';

export const EXECUTORS: Record<TestId, Executor> = {
  http_spike: httpSpikeExecutor,
  connection_flood: connectionFloodExecutor,
  sql_injection: sqlInjectionExecutor,
  xss: xssExecutor,
  path_traversal: pathTraversalExecutor,
  oversized_body: oversizedBodyExecutor,
  user_agent_anomaly: userAgentAnomalyExecutor,
  web_crawler: webCrawlerExecutor,
  brute_force: bruteForceExecutor,
  idor_enumeration: idorExecutor,
  schema_validation: schemaValidationExecutor,
  business_logic: businessLogicExecutor,
};

export function executorFor(testId: TestId): Executor {
  const executor = EXECUTORS[testId];
  if (!executor) throw new Error(`No executor registered for test "${testId}"`);
  return executor;
}

/**
 * How many probes a config will issue. Used for the live progress bar; it is an
 * estimate for the load tests (which are time-bounded) and a count for the rest.
 */
export function planProbes(config: AttackConfig): number {
  const v = config.values;
  switch (config.testId) {
    case 'http_spike':
      return Math.max(1, num(v, 'spike.burst', 500));

    case 'connection_flood': {
      const rps = num(v, 'flood.rps', 50);
      const duration = num(v, 'flood.duration', num(v, 'traffic.duration', 60));
      return Math.max(1, Math.round(rps * duration));
    }

    case 'sql_injection':
      return list(v, 'sql.payloads').length + 2; // baseline + control

    case 'xss':
      return list(v, 'xss.payloads').length + 1;

    case 'path_traversal': {
      const payloads = list(v, 'pt.payloads').length;
      const encoding = str(v, 'pt.encoding', 'auto');
      const multiplier = encoding === 'auto' ? 4 : 1;
      return Math.max(1, payloads * multiplier);
    }

    case 'oversized_body':
      return 1;

    case 'user_agent_anomaly':
      return Math.max(1, list(v, 'ua.profiles').length) + 1;

    case 'web_crawler':
      return Math.max(1, Math.min(num(v, 'crawl.max_pages', 100), 500));

    case 'brute_force':
      return list(v, 'bf.passwords').length + 1;

    case 'idor_enumeration': {
      const start = num(v, 'idor.start', 1);
      const end = num(v, 'idor.end', 10);
      const step = Math.max(1, num(v, 'idor.step', 1));
      return Math.max(1, Math.floor(Math.abs(end - start) / step) + 1) + 1;
    }

    case 'schema_validation':
      return Math.max(1, list(v, 'sv.fuzz_cases').length * list(v, 'sv.content_types').length);

    case 'business_logic':
      return Math.max(1, num(v, 'bl.replay_count', 10));

    default:
      return 1;
  }
}

export * from './context.ts';
