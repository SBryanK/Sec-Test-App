import type { AnonymityMode } from '@teo/shared';

/**
 * Request identity management.
 *
 * A pentest tool that announces itself contaminates the engagement: the target's
 * SOC gets a free detection, the blue team learns what to look for, and the
 * operator's identity ends up in someone else's logs. Everything here exists so
 * that *what the target sees* is a deliberate choice, and so that operator
 * identity can never leak onto the wire by accident.
 */

/* ------------------------------------------------------------------ *
 * Operator identity
 * ------------------------------------------------------------------ */

export interface OperatorIdentity {
  email: string;
  name: string;
}

/**
 * Header names that would carry operator identity. None of these are ever set
 * by the engine; this list exists so the sanitizer can strip them if a config
 * or a future change introduces one.
 */
const IDENTITY_HEADER_NAMES = [
  'from',
  'x-operator',
  'x-operator-email',
  'x-operator-name',
  'x-user-email',
  'x-analyst',
  'x-pentester',
  'x-engagement-owner',
  'x-forwarded-user',
  'x-authenticated-user',
];

export interface SanitizeResult {
  headers: Record<string, string>;
  /** Headers that were dropped, for the forensic record. */
  removed: string[];
}

/**
 * Strip anything from outgoing headers that could identify the operator.
 *
 * Two rules:
 *   1. Drop any header whose *name* is an identity carrier.
 *   2. Drop any header whose *value* contains the operator's email or name.
 *
 * This runs on every single request, unconditionally. Operator identity belongs
 * in the run's provenance record in our own database — never in a packet we
 * send to a third party.
 */
export function sanitizeOutgoingHeaders(
  headers: Record<string, string>,
  identity: OperatorIdentity | null,
): SanitizeResult {
  const removed: string[] = [];
  const out: Record<string, string> = {};

  const needles: string[] = [];
  if (identity) {
    if (identity.email) needles.push(identity.email.toLowerCase());
    if (identity.name) needles.push(identity.name.toLowerCase());
  }

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (IDENTITY_HEADER_NAMES.includes(lowerKey)) {
      removed.push(`${key} (identity header)`);
      continue;
    }

    const lowerValue = String(value).toLowerCase();
    const hit = needles.find((needle) => needle.length > 3 && lowerValue.includes(needle));
    if (hit) {
      removed.push(`${key} (contained operator identity)`);
      continue;
    }

    out[key] = value;
  }

  return { headers: out, removed };
}

/* ------------------------------------------------------------------ *
 * Browser profiles
 * ------------------------------------------------------------------ */

export type BrowserFamily = 'chromium' | 'gecko' | 'webkit';

export interface BrowserProfile {
  id: string;
  family: BrowserFamily;
  userAgent: string;
  /** Client hints. Present only on Chromium-family profiles — sending them with
   *  a Firefox or Safari User-Agent is itself a fingerprint mismatch. */
  clientHints?: Record<string, string>;
  platform: 'desktop' | 'mobile';
}

/**
 * Current, real-world browser profiles.
 *
 * Each entry is internally consistent: the User-Agent, the Sec-CH-UA brand list
 * and the platform hint all describe the same browser. Mixing them (a Safari UA
 * with Chromium client hints, say) is a classic scanner tell and is worse than
 * sending nothing at all.
 */
export const BROWSER_PROFILES: BrowserProfile[] = [
  {
    id: 'chrome-win',
    family: 'chromium',
    platform: 'desktop',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    clientHints: {
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  },
  {
    id: 'chrome-mac',
    family: 'chromium',
    platform: 'desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    clientHints: {
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  },
  {
    id: 'edge-win',
    family: 'chromium',
    platform: 'desktop',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    clientHints: {
      'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  },
  {
    id: 'firefox-win',
    family: 'gecko',
    platform: 'desktop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  },
  {
    id: 'firefox-linux',
    family: 'gecko',
    platform: 'desktop',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  },
  {
    id: 'safari-mac',
    family: 'webkit',
    platform: 'desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  },
];

/* ------------------------------------------------------------------ *
 * Header ordering
 * ------------------------------------------------------------------ */

/**
 * The order each engine writes its request headers.
 *
 * Header order is observable and is used as a fingerprint. Node emits headers in
 * insertion order, so matching the real browser's order costs nothing and
 * removes a trivial "this is not a browser" signal.
 */
const CHROMIUM_ORDER = [
  'Host',
  'Connection',
  'Content-Length',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'Upgrade-Insecure-Requests',
  'User-Agent',
  'Accept',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-User',
  'Sec-Fetch-Dest',
  'Referer',
  'Accept-Encoding',
  'Accept-Language',
  'Cookie',
];

const GECKO_ORDER = [
  'Host',
  'User-Agent',
  'Accept',
  'Accept-Language',
  'Accept-Encoding',
  'Connection',
  'Upgrade-Insecure-Requests',
  'Sec-Fetch-Dest',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Site',
  'Sec-Fetch-User',
  'Referer',
  'Cookie',
  'Content-Length',
];

const WEBKIT_ORDER = [
  'Host',
  'Accept',
  'Sec-Fetch-Site',
  'Sec-Fetch-Dest',
  'Accept-Language',
  'Sec-Fetch-Mode',
  'User-Agent',
  'Referer',
  'Accept-Encoding',
  'Connection',
  'Cookie',
  'Content-Length',
];

function orderFor(family: BrowserFamily): string[] {
  return family === 'gecko' ? GECKO_ORDER : family === 'webkit' ? WEBKIT_ORDER : CHROMIUM_ORDER;
}

/**
 * Reorder a header map to match the given browser family.
 *
 * Headers not in the canonical list keep their relative order and are appended
 * at the end — those are the operator-supplied ones (custom auth headers, test
 * headers) and they belong after the standard set anyway.
 */
export function orderHeaders(
  headers: Record<string, string>,
  family: BrowserFamily,
): Record<string, string> {
  const canonical = orderFor(family);
  const lowerToKey = new Map<string, string>();
  for (const key of Object.keys(headers)) lowerToKey.set(key.toLowerCase(), key);

  const out: Record<string, string> = {};
  const used = new Set<string>();

  for (const name of canonical) {
    const key = lowerToKey.get(name.toLowerCase());
    if (key && !used.has(key)) {
      out[key] = headers[key] as string;
      used.add(key);
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!used.has(key)) out[key] = value;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Header set construction
 * ------------------------------------------------------------------ */

export interface IdentityHeaders {
  headers: Record<string, string>;
  /** The User-Agent actually used, for the task record. */
  userAgent: string;
  /** Which profile produced this, or null for non-browser modes. */
  profileId: string | null;
  family: BrowserFamily | null;
}

export interface BuildIdentityArgs {
  mode: AnonymityMode;
  /** Force a specific browser profile (rotation is disabled when set). */
  profile?: BrowserProfile | null;
  userAgentOverride?: string | null;
  /** Whether the request carries a body. */
  hasBody: boolean;
  /** True for a top-level navigation (affects Sec-Fetch-Site/User). */
  navigation?: boolean;
  acceptLanguage?: string;
}

/**
 * Build the identity header set for one request.
 *
 * `browser` mode produces a full, self-consistent header family. `neutral` sends
 * the absolute minimum a generic HTTP client would. `identify` announces the
 * tool, which is only appropriate when the customer expects it.
 */
export function buildIdentityHeaders(args: BuildIdentityArgs): IdentityHeaders {
  const { mode, profile, userAgentOverride, hasBody, navigation = false } = args;
  const acceptLanguage = args.acceptLanguage ?? 'en-US,en;q=0.9';

  if (mode === 'identify') {
    return {
      headers: {
        'User-Agent': userAgentOverride ?? 'EdgeOne-SecTest/1.0 (+authorised-pentest; contact security@edgeone.internal)',
        Accept: '*/*',
      },
      userAgent: userAgentOverride ?? 'EdgeOne-SecTest/1.0',
      profileId: null,
      family: null,
    };
  }

  if (mode === 'neutral' || !profile) {
    // Deliberately unremarkable: no tool name, no browser pretence, no client
    // hints. Nothing here distinguishes this from any generic HTTP client.
    const ua = userAgentOverride ?? 'Mozilla/5.0 (compatible; GenericClient/1.0)';
    return {
      headers: { 'User-Agent': ua, Accept: '*/*' },
      userAgent: ua,
      profileId: null,
      family: null,
    };
  }

  const headers: Record<string, string> = {
    'User-Agent': userAgentOverride ?? profile.userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };

  if (profile.family === 'chromium') {
    headers['Upgrade-Insecure-Requests'] = '1';
    Object.assign(headers, profile.clientHints ?? {});
    headers['Sec-Fetch-Site'] = navigation ? 'none' : 'same-origin';
    headers['Sec-Fetch-Mode'] = navigation ? 'navigate' : 'cors';
    headers['Sec-Fetch-User'] = navigation ? '?1' : '?0';
    headers['Sec-Fetch-Dest'] = navigation ? 'document' : 'empty';
  } else if (profile.family === 'gecko') {
    headers['Upgrade-Insecure-Requests'] = '1';
    headers['Sec-Fetch-Dest'] = navigation ? 'document' : 'empty';
    headers['Sec-Fetch-Mode'] = navigation ? 'navigate' : 'cors';
    headers['Sec-Fetch-Site'] = navigation ? 'none' : 'same-origin';
    headers['Sec-Fetch-User'] = navigation ? '?1' : '?0';
  } else {
    headers['Sec-Fetch-Site'] = navigation ? 'none' : 'same-origin';
    headers['Sec-Fetch-Dest'] = navigation ? 'document' : 'empty';
    headers['Sec-Fetch-Mode'] = navigation ? 'navigate' : 'cors';
  }

  if (!hasBody) delete headers['Content-Length'];
  if (hasBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  return {
    headers: orderHeaders(headers, profile.family),
    userAgent: headers['User-Agent'] as string,
    profileId: profile.id,
    family: profile.family,
  };
}

/** Pick a profile for a request. Rotates when requested. */
export function selectProfile(
  previous: BrowserProfile | null,
  rotate: boolean,
  platform: 'desktop' | 'mobile' | 'any' = 'desktop',
): BrowserProfile {
  const pool = BROWSER_PROFILES.filter((p) => platform === 'any' || p.platform === platform);
  const candidates = pool.length > 0 ? pool : BROWSER_PROFILES;

  if (!rotate) return candidates[0] as BrowserProfile;

  // Avoid repeating the previous profile so a rotation is visible on the wire.
  const alternatives = candidates.filter((p) => p.id !== previous?.id);
  const usable = alternatives.length > 0 ? alternatives : candidates;
  return usable[Math.floor(Math.random() * usable.length)] as BrowserProfile;
}

/* ------------------------------------------------------------------ *
 * Response encoding
 * ------------------------------------------------------------------ */

/**
 * Advertised content codings, filtered by what this Node build can actually
 * decode. Advertising a coding we cannot decode would hand us a binary body.
 */
export function supportedEncodings(zlib: typeof import('node:zlib')): string[] {
  const codings = ['gzip', 'deflate', 'br'];
  const z = zlib as unknown as Record<string, unknown>;
  if (typeof z['zstdDecompressSync'] === 'function') codings.push('zstd');
  return codings;
}
