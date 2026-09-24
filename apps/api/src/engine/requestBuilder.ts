import type { AttackConfig, ConfigValues, HttpMethod, InjectionPoint, KvPair } from '@teo/shared';
import { getTest, hasPayloadPlaceholder, substitute } from '@teo/shared';
import type { NormalisedTarget } from '@teo/shared';
import type { TemplateVars } from '@teo/shared';
import {
  buildIdentityHeaders,
  orderHeaders,
  sanitizeOutgoingHeaders,
  selectProfile,
  type BrowserProfile,
  type OperatorIdentity,
} from './anonymity.ts';

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | null;
  /** The payload that was placed into this request, if any. */
  payload: string | null;
  injectionPoint: InjectionPoint | null;
  /** User-Agent actually transmitted, for the forensic record. */
  userAgent: string;
  /** Browser profile used, when in browser mode. */
  profileId: string | null;
  /** Headers dropped because they carried operator identity. */
  redactedHeaders: string[];
}

export interface BuildRequestOptions {
  extraVars?: Partial<TemplateVars>;
  /** Operator identity, used to strip anything identifying from the request. */
  identity?: OperatorIdentity | null;
  /** Previously used browser profile, so rotation actually changes. */
  previousProfile?: BrowserProfile | null;
  /** Top-level navigation (affects Sec-Fetch-* in browser mode). */
  navigation?: boolean;
}

function pairValue(value: string, vars: TemplateVars): string {
  return substitute(value, vars);
}

function encodeQuery(pairs: KvPair[], vars: TemplateVars): string {
  const parts: string[] = [];
  for (const pair of pairs) {
    if (pair.enabled === false) continue;
    const key = pair.key?.trim();
    if (!key) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(pairValue(pair.value ?? '', vars))}`);
  }
  return parts.join('&');
}

/**
 * Resolve which config value names the parameter a payload should target.
 * Different tests spell this differently; this maps them to one concept.
 */
function targetParameter(config: AttackConfig): string | null {
  const candidates = ['sql.target_param', 'xss.target_param', 'pt.target_param', 'params.target'];
  for (const id of candidates) {
    const value = config.values[id];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function injectionPointFor(config: AttackConfig): InjectionPoint | null {
  const raw = config.values['sql.injection_point'] ?? config.values['xss.injection_point'] ?? config.values['pt.injection_point'];
  if (typeof raw === 'string') return raw as InjectionPoint;
  return null;
}

/**
 * Build one concrete HTTP request from an attack config, optionally injecting a
 * payload.
 *
 * Injection resolution order:
 *   1. Every `{{PAYLOAD}}` placeholder in query, headers and body is replaced.
 *   2. If no placeholder consumed the payload but the test names a target
 *      parameter (e.g. SQL "Target Parameter: id"), the payload is written into
 *      that parameter at the configured injection point.
 *
 * This supports both styles visible in the reference UI — the inline
 * `{{PAYLOAD}}` style and the explicit target-parameter style.
 */
export function buildRequest(
  config: AttackConfig,
  target: NormalisedTarget,
  payload: string | null,
  options: BuildRequestOptions = {},
): BuiltRequest {
  const { extraVars = {}, identity = null, previousProfile = null, navigation = false } = options;
  const test = getTest(config.testId);
  const point = injectionPointFor(config);

  const token =
    typeof config.values['auth.token'] === 'string' ? (config.values['auth.token'] as string) : '';

  const vars: TemplateVars = {
    PAYLOAD: payload ?? '',
    TOKEN: token,
    DOMAIN: target.host,
    TARGET: target.host,
    USERNAME:
      typeof config.values['bf.username'] === 'string'
        ? (config.values['bf.username'] as string)
        : 'admin',
    DEPTH: String(config.values['crawl.depth'] ?? ''),
    ...extraVars,
  };

  // --- query ---------------------------------------------------------
  let queryPairs: KvPair[] = config.http.query.map((p) => ({ ...p }));
  let payloadUsed = false;

  for (const pair of queryPairs) {
    if (hasPayloadPlaceholder(pair.value ?? '')) payloadUsed = true;
  }
  const bodyHasPlaceholder = hasPayloadPlaceholder(config.http.body ?? '');
  if (bodyHasPlaceholder) payloadUsed = true;
  for (const header of config.http.headers) {
    if (hasPayloadPlaceholder(header.value ?? '')) payloadUsed = true;
  }

  if (payload !== null && !payloadUsed && payload !== undefined) {
    const param = targetParameter(config);
    const effectivePoint = point ?? 'query';
    if (param) {
      const idx = queryPairs.findIndex((p) => p.key === param);
      if (effectivePoint === 'query') {
        if (idx >= 0) queryPairs[idx] = { ...queryPairs[idx], value: payload } as KvPair;
        else queryPairs.push({ key: param, value: payload });
      }
    } else if (effectivePoint === 'query' && queryPairs.length > 0) {
      // Fall back to the first parameter so a payload is always exercised.
      const first = queryPairs[0];
      if (first) queryPairs[0] = { ...first, value: payload };
    }
  }

  const query = encodeQuery(queryPairs, vars);

  // --- headers -------------------------------------------------------
  // Identity first, so an explicit test header always wins over the profile.
  const profile =
    config.options.anonymity === 'browser'
      ? selectProfile(previousProfile, config.options.rotateUserAgent, 'desktop')
      : null;

  const identityHeaders = buildIdentityHeaders({
    mode: config.options.anonymity,
    profile,
    userAgentOverride: config.options.userAgentOverride,
    hasBody: Boolean(config.http.body && config.http.body.trim()),
    navigation,
  });

  const headers: Record<string, string> = {};

  for (const header of config.http.headers) {
    const key = header.key?.trim();
    if (!key || header.enabled === false) continue;
    headers[key] = pairValue(header.value ?? '', vars);
  }

  // Fill in anything the config did not specify from the identity profile.
  const supplied = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(identityHeaders.headers)) {
    if (!supplied.has(key.toLowerCase())) headers[key] = value;
  }

  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = identityHeaders.userAgent;
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
    headers['Accept'] = identityHeaders.headers['Accept'] ?? '*/*';
  }

  // Drop an Authorization header that resolved to an empty bearer token.
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  if (authKey) {
    const value = headers[authKey] ?? '';
    if (/^bearer\s*$/i.test(value.trim()) || value.trim() === '') {
      delete headers[authKey];
    }
  }

  // --- body ----------------------------------------------------------
  let body: string | null = null;
  if (config.http.body && config.http.body.trim() && !['GET', 'HEAD'].includes(config.http.method)) {
    body = substitute(config.http.body, vars);
  }

  // Explicit target-parameter injection into the body when configured.
  if (payload !== null && point === 'body' && !bodyHasPlaceholder && body === null) {
    const param = targetParameter(config);
    if (param) body = `${encodeURIComponent(param)}=${encodeURIComponent(payload)}`;
  }

  // --- path ----------------------------------------------------------
  let path = substitute(config.http.path || '/', vars);
  if (!path.startsWith('/')) path = `/${path}`;
  if (payload !== null && point === 'path') {
    path = path.replace(/\/?$/, `/${encodeURIComponent(payload)}`);
  }

  const url = `${target.origin}${path}${query ? `?${query}` : ''}`;

  // --- identity guard (must run last) --------------------------------
  // Nothing identifying may survive into a packet. This runs after every other
  // transformation so a header added by any path still gets checked.
  const sanitized = sanitizeOutgoingHeaders(headers, identity);
  const finalHeaders =
    identityHeaders.family && config.options.anonymity === 'browser'
      ? orderHeaders(sanitized.headers, identityHeaders.family)
      : sanitized.headers;

  return {
    url,
    method: config.http.method,
    headers: finalHeaders,
    body,
    payload,
    injectionPoint: point,
    userAgent: finalHeaders['User-Agent'] ?? finalHeaders['user-agent'] ?? '',
    profileId: identityHeaders.profileId,
    redactedHeaders: sanitized.removed,
  };
}

/**
 * Generate the oversized JSON body used by the Oversized Body test.
 * Body size is honoured exactly; field count controls how many keys pad it out.
 */
export function generateOversizedBody(sizeKb: number, fieldCount: number, duplicateKeys: boolean, depth: number): string {
  const targetBytes = Math.max(1, sizeKb) * 1024;
  const fields = Math.max(1, Math.min(fieldCount, 100_000));

  // Build a nested skeleton first so depth is meaningful.
  const nested: unknown = buildNested(depth);
  const obj: Record<string, unknown> = { __nested: nested };

  // Pad with fields until the payload reaches the requested size.
  const filler = 'A'.repeat(64);
  let i = 0;
  let serialised = JSON.stringify(obj);
  while (Buffer.byteLength(serialised, 'utf8') < targetBytes && i < fields * 4 + 10_000) {
    const key = duplicateKeys ? 'dup' : `field_${i}`;
    obj[key] = `${filler}_${i}`;
    i += 1;
    serialised = JSON.stringify(obj);
    if (i >= fields && Buffer.byteLength(serialised, 'utf8') >= targetBytes) break;
    if (i >= fields * 4) break;
  }

  // Final exact pad so the body matches the requested size as closely as JSON allows.
  let final = JSON.stringify(obj);
  const shortfall = targetBytes - Buffer.byteLength(final, 'utf8');
  if (shortfall > 32) {
    obj['__pad'] = 'P'.repeat(shortfall - 16);
    final = JSON.stringify(obj);
  }
  return final;
}

function buildNested(depth: number): unknown {
  let node: unknown = { leaf: true };
  for (let i = 1; i < Math.max(1, Math.min(depth, 200)); i += 1) {
    node = { [`level_${i}`]: node };
  }
  return node;
}

/** Extract the numeric/string value of a config field with a typed fallback. */
export function num(values: ConfigValues, id: string, fallback: number): number {
  const raw = values[id];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function bool(values: ConfigValues, id: string, fallback = false): boolean {
  const raw = values[id];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export function str(values: ConfigValues, id: string, fallback = ''): string {
  const raw = values[id];
  return typeof raw === 'string' ? raw : fallback;
}

export function list(values: ConfigValues, id: string): string[] {
  const raw = values[id];
  if (Array.isArray(raw)) {
    return (raw as unknown[])
      .map((v) => String(v))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof raw === 'string') {
    return raw
      .split('\n')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}
