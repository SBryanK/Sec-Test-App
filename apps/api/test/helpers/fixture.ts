/**
 * Fixture helpers shared by the test suites.
 *
 * The fixtures are deliberately vulnerable / deliberately protected HTTP
 * services (apps/fixture). Tests skip cleanly when they are not running so the
 * suite still works in a bare checkout.
 */

export const FIXTURE_VULNERABLE = process.env.FIXTURE_VULNERABLE_URL ?? 'http://127.0.0.1:9900';
export const FIXTURE_PROTECTED = process.env.FIXTURE_PROTECTED_URL ?? 'http://127.0.0.1:9901';

export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeOne-SecTest/1.0)' },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function fixturesReachable(): Promise<boolean> {
  const [vulnerable, protectedOne] = await Promise.all([
    reachable(FIXTURE_VULNERABLE),
    reachable(FIXTURE_PROTECTED),
  ]);
  return vulnerable && protectedOne;
}

export async function apiReachable(): Promise<boolean> {
  return reachable(API_URL);
}
