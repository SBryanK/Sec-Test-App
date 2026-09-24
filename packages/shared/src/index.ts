export * from './types';
export * from './catalog';
export * from './validation';

import type { Severity, Verdict } from './types';

/** Severity ordering for roll-ups and sorting (highest first). */
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function maxSeverity(values: Array<Severity | null>): Severity | null {
  let best: Severity | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || SEVERITY_RANK[v] > SEVERITY_RANK[best]) best = v;
  }
  return best;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  blocked: 'Blocked',
  bypassed: 'Bypassed',
  passed: 'Passed',
  error: 'Error',
  inconclusive: 'Inconclusive',
};

/**
 * A `bypassed` verdict is the actionable one — protection failed to stop an
 * attack that should have been stopped.
 */
export function isFinding(v: Verdict): boolean {
  return v === 'bypassed';
}
