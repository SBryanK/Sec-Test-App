import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type {
  AttackConfig,
  AuthSession,
  ExportFormat,
  HistoryFilter,
  HistoryPage,
  RunProgress,
  RunRecord,
  TestCategory,
  TestDefinition,
  TestParametersDocument,
  UserAccount,
} from '@teo/shared';

const STORAGE_KEY = 'teo.apiBaseUrl';
const TOKEN_KEY = 'teo.session';

/**
 * Resolve the API base URL.
 *
 * The Android emulator cannot reach the host's `127.0.0.1` — it must use the
 * `10.0.2.2` alias. We default per platform and let an operator override the
 * value at runtime from the Profile screen, since a real engagement will point
 * at a staging deployment rather than a laptop.
 */
function defaultBaseUrl(): string {
  const fromConfig = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (fromConfig) return fromConfig;
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://127.0.0.1:8787';
}

let baseUrl = defaultBaseUrl();
let session: AuthSession | null = null;

export function getBaseUrl(): string {
  return baseUrl;
}

export async function loadBaseUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (stored) baseUrl = stored;
  return baseUrl;
}

export async function setBaseUrl(url: string): Promise<void> {
  baseUrl = url.replace(/\/+$/, '');
  await AsyncStorage.setItem(STORAGE_KEY, baseUrl);
}

/* ------------------------------------------------------------------ *
 * Server URL handling (team onboarding)
 * ------------------------------------------------------------------ */

export const DEFAULT_API_PORT = 8787;

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

  // Tolerate a pasted URL that includes a path.
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

export interface DiscoveryResult {
  name: string;
  version: string;
  testCount: number;
  addresses: string[];
  reachedAt: string;
}

/**
 * Check whether a server answers, and describe it.
 *
 * Uses the unauthenticated discovery endpoint so a team member can verify the
 * address *before* they have credentials.
 */
export async function probeServer(url: string, timeoutMs = 8000): Promise<DiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/discovery`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Server replied with HTTP ${res.status}`);
    return (await res.json()) as DiscoveryResult;
  } catch (err) {
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
}

export function getSession(): AuthSession | null {
  return session;
}

/**
 * The session token lives in the platform keystore, not AsyncStorage.
 *
 * AsyncStorage is unencrypted SQLite inside the app sandbox — readable on a
 * rooted or jailbroken device, and included in some device backups. This app
 * holds a long-lived credential that can launch traffic at customer
 * infrastructure, so it belongs in the Keychain / Android Keystore.
 */
async function readStoredSession(): Promise<string | null> {
  try {
    const secure = await SecureStore.getItemAsync(TOKEN_KEY);
    if (secure) return secure;
    // Migrate a token written by an older build, then remove the plaintext copy.
    const legacy = await AsyncStorage.getItem(TOKEN_KEY);
    if (legacy) {
      await SecureStore.setItemAsync(TOKEN_KEY, legacy);
      await AsyncStorage.removeItem(TOKEN_KEY);
      return legacy;
    }
    return null;
  } catch {
    // SecureStore is unavailable on web and in some test environments; fall
    // back rather than losing the session entirely.
    return AsyncStorage.getItem(TOKEN_KEY);
  }
}

export async function loadSession(): Promise<AuthSession | null> {
  const raw = await readStoredSession();
  if (!raw) return null;
  try {
    session = JSON.parse(raw) as AuthSession;
    return session;
  } catch {
    return null;
  }
}

export async function saveSession(next: AuthSession | null): Promise<void> {
  session = next;
  try {
    if (next) {
      await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
      await AsyncStorage.removeItem(TOKEN_KEY);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    if (next) await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify(next));
    else await AsyncStorage.removeItem(TOKEN_KEY);
  }
}

/* ------------------------------------------------------------------ *
 * Error type
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
 * Core request
 * ------------------------------------------------------------------ */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Return raw text instead of parsed JSON. */
  raw?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, raw = false, timeoutMs = 30_000, signal } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (raw) return (await response.text()) as T;

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok) {
      const payload = parsed as { message?: string; error?: string };
      throw new ApiError(
        payload.message ?? `Request failed with HTTP ${response.status}`,
        response.status,
        payload.error,
      );
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, 0, 'timeout');
    }
    throw new ApiError(
      err instanceof Error ? err.message : 'Network request failed',
      0,
      'network_error',
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

export interface LoginResponse extends AuthSession {}

export const api = {
  async health(): Promise<{ status: string; version: string; queueDepth: number }> {
    return request('/api/health', { timeoutMs: 6000 });
  },

  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    await saveSession(res);
    return res;
  },

  async logout(): Promise<void> {
    await saveSession(null);
  },

  /** Request access. Creates a pending account that an admin must approve. */
  async register(input: {
    email: string;
    displayName: string;
    password: string;
    note?: string;
  }): Promise<{ status: string; message: string }> {
    return request('/api/auth/register', { method: 'POST', body: input });
  },

  /* ---------------- administration ---------------- */

  async pendingRequests(): Promise<{ requests: UserAccount[] }> {
    return request('/api/admin/requests');
  },

  async allUsers(): Promise<{ users: UserAccount[] }> {
    return request('/api/admin/users');
  },

  async approveRequest(id: string): Promise<{ approved: boolean }> {
    return request(`/api/admin/requests/${id}/approve`, { method: 'POST' });
  },

  async rejectRequest(id: string): Promise<{ rejected: boolean }> {
    return request(`/api/admin/requests/${id}/reject`, { method: 'POST' });
  },

  async suspendUser(id: string): Promise<{ suspended: boolean }> {
    return request(`/api/admin/users/${id}/suspend`, { method: 'POST' });
  },

  async activateUser(id: string): Promise<{ activated: boolean }> {
    return request(`/api/admin/users/${id}/activate`, { method: 'POST' });
  },

  /** Revoke every token an operator holds — recovers from a leaked credential. */
  async revokeUserTokens(id: string): Promise<{ revoked: boolean }> {
    return request(`/api/admin/users/${id}/revoke`, { method: 'POST' });
  },

  async me(): Promise<UserAccount> {
    return request('/api/auth/me');
  },

  async catalog(): Promise<{
    categories: TestCategory[];
    tests: TestDefinition[];
    testCount: number;
  }> {
    return request('/api/catalog');
  },

  async validateConnection(domain: string): Promise<{ results: ConnectionResult[] }> {
    return request('/api/validate-connection', {
      method: 'POST',
      body: { domain },
      timeoutMs: 45_000,
    });
  },

  async createRun(input: {
    configs: AttackConfig[];
    mode?: 'single' | 'batch' | 'custom';
    label?: string;
    device?: string;
    platform?: string;
    appVersion?: string;
    note?: string;
  }): Promise<{ run: RunRecord }> {
    return request('/api/runs', { method: 'POST', body: input });
  },

  async getRun(id: string): Promise<{
    run: RunRecord;
    findings: Finding[];
    traceCount: number;
    tests: TestSummary[];
    /** Edge/origin paths this run traversed, most used first. */
    platforms: Array<{ summary: string; probes: number }>;
  }> {
    return request(`/api/runs/${id}`);
  },

  async getTraces(
    id: string,
    opts: { testId?: string; verdict?: string; limit?: number; offset?: number } = {},
  ): Promise<{ traces: TraceRow[] }> {
    const params = new URLSearchParams();
    if (opts.testId) params.set('testId', opts.testId);
    if (opts.verdict) params.set('verdict', opts.verdict);
    params.set('limit', String(opts.limit ?? 200));
    params.set('offset', String(opts.offset ?? 0));
    return request(`/api/runs/${id}/traces?${params.toString()}`);
  },

  async getFindings(id: string): Promise<{ findings: Finding[] }> {
    return request(`/api/runs/${id}/findings`);
  },

  async cancelRun(id: string): Promise<{ cancelled: boolean }> {
    return request(`/api/runs/${id}/cancel`, { method: 'POST' });
  },

  async deleteRun(id: string): Promise<{ deleted: boolean }> {
    return request(`/api/runs/${id}`, { method: 'DELETE' });
  },

  async history(filter: HistoryFilter = {}): Promise<HistoryPage> {
    const params = new URLSearchParams();
    if (filter.status && filter.status !== 'any') params.set('status', filter.status);
    if (filter.categories?.length) params.set('categories', filter.categories.join(','));
    if (filter.domainContains) params.set('domainContains', filter.domainContains);
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
    if (filter.limit) params.set('limit', String(filter.limit));
    if (filter.cursor) params.set('cursor', filter.cursor);
    return request(`/api/history?${params.toString()}`);
  },

  async exportRuns(input: {
    runIds: string[];
    format: ExportFormat;
    includeTraces?: boolean;
  }): Promise<string> {
    return request('/api/export', { method: 'POST', body: input, raw: true, timeoutMs: 60_000 });
  },

  async credits(): Promise<UserAccount> {
    return request('/api/credits');
  },

  async requestCredits(): Promise<{ id: string; requestedAt: string }> {
    return request('/api/credits/request', { method: 'POST' });
  },

  async setLanguage(language: 'en' | 'zh'): Promise<{ language: string }> {
    return request('/api/profile/language', { method: 'PATCH', body: { language } });
  },

  async importDocument(
    document: TestParametersDocument,
    cart: AttackConfig[],
  ): Promise<{
    cart: AttackConfig[];
    added: number;
    total: number;
    errors: Array<{ index: number; message: string }>;
  }> {
    return request('/api/import', { method: 'POST', body: { document, cart } });
  },

  async template(testId: string): Promise<TestParametersDocument> {
    return request(`/api/templates/${testId}`);
  },

  async saveConfig(testId: string, name: string, config: AttackConfig): Promise<{ id: string }> {
    return request('/api/configs', { method: 'POST', body: { testId, name, config } });
  },

  async savedConfigs(): Promise<{ configs: SavedConfig[] }> {
    return request('/api/configs');
  },

};

/* ------------------------------------------------------------------ *
 * Response shapes (kept local — they mirror the server's JSON)
 * ------------------------------------------------------------------ */

export interface ConnectionResult {
  input: string;
  reachable: boolean;
  host: string | null;
  origin: string | null;
  statusCode: number | null;
  statusMessage: string;
  server: string | null;
  /** Edge and origin identification, with the evidence that produced it. */
  platform: {
    edge: { code: string; name: string } | null;
    origin: { code: string; name: string } | null;
    server: string | null;
    cacheStatus: string | null;
    signals: string[];
    directToOrigin: boolean;
  } | null;
  /** One-line summary, e.g. `Tencent EdgeOne → Tencent COS (cache HIT)`. */
  platformSummary: string | null;
  tls: {
    protocol: string | null;
    cipher: string | null;
    authorized: boolean;
    subject: string | null;
    issuer: string | null;
    validTo: string | null;
    daysUntilExpiry: number | null;
  } | null;
  timing: {
    dnsMs: number | null;
    tcpMs: number | null;
    tlsMs: number | null;
    ttfbMs: number | null;
    totalMs: number | null;
  };
  bytesReceived: number;
  redirectChain: string[];
  error: string | null;
}

/** Per-test outcome with the iteration detail the results screen renders. */
export interface TestSummary {
  testId: string;
  probes: number;
  passed: number;
  blocked: number;
  bypassed: number;
  errors: number;
  firstBlockedIteration: number | null;
  firstBypassedIteration: number | null;
  firstErrorIteration: number | null;
  firstStatusCode: number | null;
  lastStatusCode: number | null;
  statusCodes: number[];
}

export interface SavedConfig {
  id: string;
  testId: string;
  name: string;
  config: AttackConfig;
  updatedAt: string;
}

export interface TraceRow {
  id: string;
  run_id: string;
  config_id: string;
  test_id: string;
  seq: number;
  iteration: number | null;
  remote_address: string | null;
  method: string;
  url: string;
  request_headers: Record<string, string>;
  request_body_preview: string | null;
  request_bytes: number;
  payload: string | null;
  injection_point: string | null;
  status_code: number | null;
  response_headers: Record<string, string>;
  response_body_preview: string | null;
  response_bytes: number;
  response_hash: string | null;
  dns_ms: number | null;
  tcp_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number | null;
  verdict: string;
  severity: string | null;
  reason: string | null;
  signature: string | null;
  error: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  runId: string;
  testId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  verdict: string;
  description: string;
  evidence: string;
  remediation: string;
  traceIds: string[];
  references: string[];
}

/**
 * Subscribe to a run's live progress over Server-Sent Events.
 *
 * React Native's fetch has no streaming body support, so this uses XMLHttpRequest
 * with `onprogress` and parses SSE frames from the accumulating response text —
 * the standard approach for SSE on RN without a native module.
 */
export function streamRun(
  runId: string,
  handlers: {
    onProgress: (progress: RunProgress) => void;
    onError?: (message: string) => void;
    onDone?: () => void;
  },
): () => void {
  const xhr = new XMLHttpRequest();
  let offset = 0;
  let closed = false;

  xhr.open('GET', `${baseUrl}/api/runs/${runId}/stream`);
  if (session?.token) xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
  xhr.setRequestHeader('Accept', 'text/event-stream');

  const parse = (): void => {
    const text = xhr.responseText;
    const slice = text.slice(offset);
    const frames = slice.split('\n\n');
    // The final element may be a partial frame; keep it for the next tick.
    offset = text.length - (frames.pop() ?? '').length;

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(6).trim() : 'message';
      const payload = dataLine.slice(5).trim();
      if (event === 'progress') {
        try {
          const progress = JSON.parse(payload) as RunProgress;
          handlers.onProgress(progress);
          if (progress.status !== 'running' && !closed) {
            closed = true;
            handlers.onDone?.();
          }
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  };

  xhr.onprogress = parse;
  xhr.onload = () => {
    parse();
    if (!closed) handlers.onDone?.();
  };
  xhr.onerror = () => handlers.onError?.('Live progress stream disconnected');
  xhr.ontimeout = () => handlers.onError?.('Live progress stream timed out');
  xhr.send();

  return () => {
    closed = true;
    xhr.abort();
  };
}
