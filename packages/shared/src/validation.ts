import { ALL_TEST_IDS, ALL_TESTS, getTest } from './catalog';
import type {
  AttackConfig,
  ConfigValues,
  ExecutionOptions,
  FieldDef,
  FieldValue,
  HttpBlock,
  KvPair,
  TargetBlock,
  TestDefinition,
  TestId,
} from './types';

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
  timeoutMs: 15_000,
  followRedirects: false,
  verifyTls: true,
  maxRps: 1000,
  maxRequests: 20_000,
  jitter: false,
  baselineDiff: true,
  maxConcurrency: 50,
  // Never advertise the tool by default — leaking "a pentest tool is running"
  // into a target's logs is itself a finding.
  anonymity: 'neutral',
  rotateUserAgent: true,
  userAgentOverride: null,
  egressProxy: null,
};

/** Build the initial value map for a test from its declared field defaults. */
export function defaultValues(test: TestDefinition): ConfigValues {
  const values: ConfigValues = {};
  for (const field of test.fields) {
    if (field.type === 'note' || field.type === 'section' || field.type === 'divider') continue;
    values[field.id] = (field.default ?? emptyForField(field));
  }
  return values;
}

function emptyForField(field: FieldDef): FieldValue {
  switch (field.type) {
    case 'number':
      return 0;
    case 'checkbox':
      return false;
    case 'lines':
      return [];
    case 'keyvalue':
      return [];
    case 'slider':
      return field.min ?? 1;
    default:
      return '';
  }
}

export function defaultHttpBlock(test: TestDefinition): HttpBlock {
  const http = test.http ?? {};
  return {
    method: http.method ?? 'GET',
    path: http.path ?? '/',
    query: clonePairs(http.query),
    headers: clonePairs(http.headers),
    body: http.body ?? '',
  };
}

function clonePairs(pairs: KvPair[] | undefined): KvPair[] {
  return (pairs ?? []).map((p) => ({ ...p }));
}

let idCounter = 0;
/** Collision-resistant client-side id for cart line items. */
export function makeConfigId(testId: TestId): string {
  idCounter += 1;
  return `${testId}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function buildDefaultConfig(testId: TestId, domain = ''): AttackConfig {
  const test = getTest(testId);
  return {
    id: makeConfigId(testId),
    testId,
    target: { domain },
    http: defaultHttpBlock(test),
    values: defaultValues(test),
    options: { ...DEFAULT_EXECUTION_OPTIONS },
  };
}

/** One config per test, sharing a target — powers "Run All At Once". */
export function buildAllTestsConfigs(domain = ''): AttackConfig[] {
  return ALL_TEST_IDS.map((id) => buildDefaultConfig(id, domain));
}

export function totalCreditCost(configs: AttackConfig[]): number {
  return configs.reduce((sum, c) => sum + getTest(c.testId).creditCost, 0);
}

/* ------------------------------------------------------------------ *
 * Target normalisation
 * ------------------------------------------------------------------ */

export interface NormalisedTarget {
  /** Bare hostname or IP. */
  host: string;
  port: number | null;
  useTls: boolean;
  /** Fully-qualified origin, e.g. `https://example.com:8443`. */
  origin: string;
}

/**
 * Accepts `example.com`, `example.com:8443`, `https://example.com/x?y=1`,
 * `192.168.1.10`, `[::1]:8080` and returns a canonical target.
 * Throws with an operator-readable message when the input cannot be used.
 */
export function normaliseTarget(raw: string, overrides?: Partial<TargetBlock>): NormalisedTarget {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Domain cannot be empty');

  let candidate = trimmed;
  let explicitTls: boolean | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const withScheme = candidate;
    const scheme = withScheme.slice(0, withScheme.indexOf('://')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`Unsupported scheme "${scheme}" — use http or https`);
    }
    explicitTls = scheme === 'https';
    candidate = withScheme.slice(withScheme.indexOf('://') + 3);
  }

  // Strip path / query / fragment.
  candidate = candidate.split(/[/?#]/)[0] ?? '';

  let host: string;
  let port: number | null = null;

  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close === -1) throw new Error('Malformed IPv6 address');
    host = candidate.slice(1, close);
    const rest = candidate.slice(close + 1);
    if (rest.startsWith(':')) port = parsePort(rest.slice(1));
  } else {
    const colonCount = (candidate.match(/:/g) ?? []).length;
    if (colonCount > 1) {
      // Bare IPv6 without brackets — no port possible.
      host = candidate;
    } else if (colonCount === 1) {
      const [h, p] = candidate.split(':');
      host = h ?? '';
      port = parsePort(p ?? '');
    } else {
      host = candidate;
    }
  }

  host = host.trim().toLowerCase();
  if (!host) throw new Error('Domain cannot be empty');
  if (/\s/.test(host)) throw new Error('Domain cannot contain spaces');
  if (!/^[a-z0-9._~%!$&'()*+,;=@-]+$/i.test(host) && !host.includes(':')) {
    throw new Error('Domain contains invalid characters');
  }

  if (overrides?.port != null) port = overrides.port;
  const useTls = overrides?.useTls ?? explicitTls ?? true;

  const defaultPort = useTls ? 443 : 80;
  const effectivePort = port ?? defaultPort;
  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  const showPort = effectivePort !== defaultPort;
  const origin = `${useTls ? 'https' : 'http'}://${hostForUrl}${showPort ? `:${effectivePort}` : ''}`;

  return { host, port, useTls, origin };
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  return port;
}

/* ------------------------------------------------------------------ *
 * Placeholder substitution
 * ------------------------------------------------------------------ */

export interface TemplateVars {
  PAYLOAD?: string;
  TOKEN?: string;
  DOMAIN?: string;
  TARGET?: string;
  USERNAME?: string;
  DEPTH?: string;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Z_]+)\s*\}\}/g;

export function substitute(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value === undefined ? match : value;
  });
}

export function hasPayloadPlaceholder(value: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(value);
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  fieldId: string;
  /** Short label used as the banner prefix, e.g. "Domain". */
  label: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Renders an issue the way the screenshots do: `Domain: Domain cannot be empty`. */
export function formatIssue(issue: ValidationIssue): string {
  return `${issue.label}: ${issue.message}`;
}

export function validateField(field: FieldDef, value: FieldValue | undefined): ValidationIssue | null {
  const label = field.label;

  if (field.type === 'number' || field.type === 'slider') {
    const num = typeof value === 'number' ? value : Number(value);
    if (value === '' || value === null || value === undefined) {
      return field.required
        ? { fieldId: field.id, label, message: `${label} is required`, severity: 'error' }
        : null;
    }
    if (!Number.isFinite(num)) {
      return { fieldId: field.id, label, message: `${label} must be a number`, severity: 'error' };
    }
    if (field.min !== undefined && num < field.min) {
      return {
        fieldId: field.id,
        label,
        message: `${label} must be at least ${field.min}`,
        severity: 'error',
      };
    }
    if (field.max !== undefined && num > field.max) {
      return {
        fieldId: field.id,
        label,
        message: `${label} must be at most ${field.max}`,
        severity: 'error',
      };
    }
    return null;
  }

  if (field.type === 'lines') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
    if (cleaned.length === 0 && field.required) {
      return { fieldId: field.id, label, message: `${label} must not be empty`, severity: 'error' };
    }
    return null;
  }

  if (field.type === 'text' || field.type === 'textarea') {
    const str = typeof value === 'string' ? value.trim() : '';
    if (!str && field.required) {
      return { fieldId: field.id, label, message: `${label} is required`, severity: 'error' };
    }
    return null;
  }

  return null;
}

/**
 * Validate a full attack config. The domain check mirrors the pink
 * "Domain: Domain cannot be empty" banner in the reference UI.
 */
export function validateConfig(config: AttackConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const test = getTest(config.testId);

  // Structural checks first. The API is a public surface: a hand-rolled POST
  // can omit `http` or `query` entirely, and without this the engine crashed
  // deep inside the request builder with
  // "Cannot read properties of undefined (reading 'query')" — after the run had
  // been queued, charged, and reported as failed for no actionable reason.
  const http = config.http as Partial<AttackConfig['http']> | undefined;
  const structural: Array<[keyof AttackConfig['http'], string]> = [
    ['query', 'Query parameters'],
    ['headers', 'Headers'],
  ];
  for (const [key, label] of structural) {
    if (http !== undefined && http !== null && !Array.isArray(http[key])) {
      issues.push({
        fieldId: `http.${String(key)}`,
        label,
        message: `${label} must be a list`,
        severity: 'error',
      });
    }
  }
  if (http === undefined || http === null) {
    issues.push({
      fieldId: 'http',
      label: 'HTTP block',
      message: 'The request definition is missing — rebuild this configuration from the catalog',
      severity: 'error',
    });
  }
  if ((config.target as Partial<AttackConfig['target']> | undefined) === undefined) {
    issues.push({
      fieldId: 'target',
      label: 'Target',
      message: 'The target block is missing',
      severity: 'error',
    });
  }

  const domain = config.target.domain?.trim() ?? '';
  if (!domain) {
    issues.push({
      fieldId: 'target.domain',
      label: 'Domain',
      message: 'Domain cannot be empty',
      severity: 'error',
    });
  } else {
    try {
      normaliseTarget(domain, config.target);
    } catch (err) {
      issues.push({
        fieldId: 'target.domain',
        label: 'Domain',
        message: err instanceof Error ? err.message : 'Invalid domain',
        severity: 'error',
      });
    }
  }

  for (const field of test.fields) {
    const issue = validateField(field, config.values[field.id]);
    if (issue) issues.push(issue);
  }

  // Cross-field checks that would otherwise fail at execution time.
  if (config.testId === 'idor_enumeration') {
    const start = Number(config.values['idor.start'] ?? 0);
    const end = Number(config.values['idor.end'] ?? 0);
    const step = Number(config.values['idor.step'] ?? 1);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
      issues.push({
        fieldId: 'idor.end',
        label: 'End ID',
        message: 'End ID must be greater than or equal to Start ID',
        severity: 'error',
      });
    }
    if (step <= 0) {
      issues.push({
        fieldId: 'idor.step',
        label: 'Step',
        message: 'Step must be at least 1',
        severity: 'error',
      });
    }
    const span = Math.abs(end - start) / Math.max(step, 1);
    if (span > 5000) {
      issues.push({
        fieldId: 'idor.end',
        label: 'Enumeration range',
        message: `Range would issue ${Math.round(span)} requests — narrow it to 5000 or fewer`,
        severity: 'error',
      });
    }
  }

  if (config.testId === 'web_crawler') {
    const depth = Number(config.values['crawl.depth'] ?? 1);
    const maxPages = Number(config.values['crawl.max_pages'] ?? 100);
    if (depth > 3 && maxPages > 2000) {
      issues.push({
        fieldId: 'crawl.max_pages',
        label: 'Crawl budget',
        message: `Depth ${depth} with ${maxPages} pages can fetch a very large number of URLs`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/* ------------------------------------------------------------------ *
 * Payload extraction
 * ------------------------------------------------------------------ */

/** Field ids that hold one-per-line payload dictionaries, per test. */
const PAYLOAD_FIELDS: Partial<Record<TestId, string>> = {
  sql_injection: 'sql.payloads',
  xss: 'xss.payloads',
  path_traversal: 'pt.payloads',
  brute_force: 'bf.passwords',
  schema_validation: 'sv.fuzz_cases',
  user_agent_anomaly: 'ua.profiles',
};

export function payloadFieldId(testId: TestId): string | undefined {
  return PAYLOAD_FIELDS[testId];
}

export function payloadsFor(config: AttackConfig): string[] {
  const fieldId = payloadFieldId(config.testId);
  if (!fieldId) return [];
  const raw = config.values[fieldId];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map((v) => String(v)).filter((v) => v.length > 0);
}

/* ------------------------------------------------------------------ *
 * Config hashing (provenance)
 * ------------------------------------------------------------------ */

/**
 * Deterministic canonical JSON — object keys sorted, undefined dropped — so the
 * same logical config always hashes identically regardless of key insertion
 * order. Used for the run's provenance stamp.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export function describeConfigSet(configs: AttackConfig[]): string {
  return canonicalise(
    configs.map((c) => ({
      testId: c.testId,
      target: { domain: c.target.domain, port: c.target.port ?? null, useTls: c.target.useTls ?? null },
      http: c.http,
      values: c.values,
      options: c.options,
    })),
  );
}

/* ------------------------------------------------------------------ *
 * Catalog helpers
 * ------------------------------------------------------------------ */

export function allTests(): TestDefinition[] {
  return ALL_TESTS;
}

/** Total default credit cost of running every test once. */
export function allTestsCreditCost(): number {
  return ALL_TESTS.reduce((sum, t) => sum + t.creditCost, 0);
}
