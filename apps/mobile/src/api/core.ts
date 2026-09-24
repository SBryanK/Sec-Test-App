import type { AuthSession } from '@teo/shared';

/**
 * Platform-free core of the mobile API client.
 *
 * Everything here is deliberately free of `react-native`, Expo and storage
 * imports. That is not incidental tidiness: `react-native` ships Flow-typed
 * source that Node's esbuild-based test runner cannot parse, so as long as this
 * logic lived next to a `Platform` import it could not be unit tested at all —
 * which is exactly how the response-shaping bug below stayed hidden.
 *
 * `client.ts` binds the device concerns (base URL storage, the Keychain session,
 * the emulator default address) and re-exports these names, so callers keep
 * importing from `../api/client.ts` as before.
 */

export const DEFAULT_API_PORT = 8787;

/* ------------------------------------------------------------------ *
 * Server URL handling (team onboarding)
 * ------------------------------------------------------------------ */

/**
 * Turn whatever a team member types into a usable base URL.
 *
 * People type `192.168.1.42`, or paste `192.168.1.42:8787/`, or paste a full
 * `http://host:port/api/health` from a browser. All three should work — asking
 * someone to remember the scheme and port is how you end up debugging a
 * connection problem over chat instead of testing.
 */
export function normaliseServerUrl(input: string): string {
  let value = (input ?? '').trim();
  if (!value) throw new Error('Enter your server address');

  // Tolerate a pasted URL that includes a path or query.
  value = value.split(/[?#]/)[0] ?? value;

  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`"${input}" is not a valid address`);
  }

  // Strip a trailing /api/... path if someone pasted an endpoint.
  parsed.pathname = parsed.pathname.replace(/\/api\/.*$/, '').replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';

  if (!parsed.port) parsed.port = String(DEFAULT_API_PORT);
  if (parsed.pathname && parsed.pathname !== '/') parsed.pathname = '';

  return `${parsed.protocol}//${parsed.host}`;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ------------------------------------------------------------------ *
 * Response shaping
 * ------------------------------------------------------------------ */

/**
 * Turn a raw response body into a typed value, or throw an `ApiError` that
 * preserves the real HTTP status.
 *
 * The status matters to callers: `AuthProvider` only clears the stored session
 * on 401/403, so reporting a 502 from a reverse proxy as a transport failure
 * (status 0) made launching the app while the backend was down delete a valid
 * token from the Keychain.
 *
 * Exported separately from the fetch wrapper so it can be tested without a
 * network or a Response object.
 */
export function shapeResponse<T>(input: { status: number; ok: boolean; text: string }): T {
  const { status, ok, text } = input;

  let parsed: unknown = {};
  let parseFailed = false;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parseFailed = true;
    }
  }

  if (!ok) {
    const payload = (parseFailed ? {} : parsed) as { message?: string; error?: string };
    throw new ApiError(
      payload.message ??
        `Request failed with HTTP ${status}` +
          (parseFailed && text ? ` (non-JSON response: ${text.slice(0, 80).trim()}…)` : ''),
      status,
      payload.error ?? `http_${status}`,
    );
  }

  if (parseFailed) {
    throw new ApiError('Server returned a non-JSON success response', status, 'bad_response');
  }
  return parsed as T;
}

/* ------------------------------------------------------------------ *
 * Request capabilities — injected by the device layer
 * ------------------------------------------------------------------ */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Return raw text instead of parsed JSON. */
  raw?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RequesterDeps {
  /** Current base URL, without a trailing slash. */
  getBaseUrl(): string;
  /** Bearer token for the signed-in operator, or null. */
  getToken(): string | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Clock hooks so tests need not wait on real timers. */
  now?: () => number;
}

export interface Requester {
  // Property signatures rather than method shorthand: these functions are
  // detached from the object by the device layer, and a method shorthand would
  // carry an implicit `this` binding.
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  probeServer: (url: string, timeoutMs?: number) => Promise<DiscoveryResult>;
}

export interface DiscoveryResult {
  name: string;
  version: string;
  testCount: number;
  addresses: string[];
  reachedAt: string;
}

/**
 * Build the request function around injected capabilities.
 *
 * `Authenticated` requests need a token and a base URL; neither is available at
 * module scope on a device (they come from SecureStore and AsyncStorage), and
 * neither should be a module-level global, which is what made the original
 * client untestable.
 */
export function createRequester(deps: RequesterDeps): Requester {
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    const { method = 'GET', body, raw = false, timeoutMs = 30_000, signal } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = deps.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await doFetch(`${deps.getBaseUrl()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (raw) return text as T;
      return shapeResponse<T>({ status: response.status, ok: response.ok, text });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError(`Request timed out after ${timeoutMs}ms`, 0, 'timeout');
      }
      throw new ApiError(err instanceof Error ? err.message : 'Network request failed', 0, 'network_error');
    } finally {
      clearTimeout(timer);
      // Detach the caller's signal: leaving it attached leaks a listener per
      // request, and a signal that was already aborted never fires anyway.
      signal?.removeEventListener('abort', onExternalAbort);
    }
  };

  /**
   * Check whether a server answers, and describe it.
   *
   * Uses the unauthenticated discovery endpoint so a team member can verify the
   * address *before* they have credentials.
   */
  const probeServer = async (url: string, timeoutMs = 8000): Promise<DiscoveryResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${url.replace(/\/+$/, '')}/api/discovery`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new ApiError(`Server replied with HTTP ${res.status}`, res.status, `http_${res.status}`);
      return shapeResponse<DiscoveryResult>({ status: res.status, ok: true, text: await res.text() });
    } catch (err) {
      if (err instanceof ApiError) {
        throw new Error(`${err.message} — check the address and that you are on the same network`);
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`No response within ${timeoutMs / 1000}s — check the address and that you are on the same network`);
      }
      throw new Error(
        err instanceof Error
          ? `${err.message} — check the address and that you are on the same network`
          : 'Could not reach the server',
      );
    } finally {
      clearTimeout(timer);
    }
  };

  // Returned as arrow properties rather than terse method shorthand: the
  // device layer detaches `request` into a module-level function, and a method
  // shorthand would lose its receiver (`@typescript-eslint/unbound-method`).
  return {
    request: <T>(path: string, options?: RequestOptions): Promise<T> => request<T>(path, options),
    probeServer: (url: string, timeoutMs?: number): Promise<DiscoveryResult> => probeServer(url, timeoutMs),
  };
}

export type { AuthSession };
