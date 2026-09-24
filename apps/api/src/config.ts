import { randomUUID } from 'node:crypto';

function required(name: string, fallback: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return fallback;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

/** The development-only seed password. Never used in production. */
const DEFAULT_SEED_PASSWORD = 'edgeone';

/**
 * Read a positive integer from the environment.
 *
 * `Number('abc')` is NaN, and NaN silently disables whichever limit it feeds —
 * `failures >= NaN` is always false, so the login gate would never block, and
 * `depth >= NaN` would give an unbounded queue. Fall back to the default and say
 * so rather than accepting a value that quietly turns a control off.
 */
function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(
      `[config] ${name}="${raw}" is not a valid number >= ${min}; using ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(parsed);
}

export const config = {
  port: intEnv('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv,
  databaseUrl: required(
    'DATABASE_URL',
    'postgres://teo@127.0.0.1:55432/teo_sectest',
  ),
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me-in-production'),
  /**
   * Token lifetime. `never` issues a non-expiring token.
   *
   * A non-expiring token is a deliberate trade: an approved operator can work
   * without re-authenticating, but a leaked token is valid forever. Revocation
   * (`users.token_version`) is what makes it recoverable — bumping the column
   * invalidates every token that operator holds, immediately.
   */
  jwtExpiry: process.env.JWT_EXPIRY ?? 'never',

  /** Whether unauthenticated visitors may request an account. */
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  appVersion: process.env.APP_VERSION ?? '1.0.0',
  /** Shown by /api/discovery so a team member can tell servers apart. */
  serverName: process.env.SERVER_NAME ?? 'EdgeOne Security Test',

  /**
   * Security posture.
   *
   * Everything here has a safe default and an environment override, because a
   * pentest platform is a high-value target: it holds customer target lists and
   * can generate arbitrary outbound traffic.
   */
  security: {
    /**
     * Allowed browser origins. `true` reflects any origin, which is only
     * appropriate for local development.
     */
    corsOrigins:
      process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.trim()
        ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
        : nodeEnv === 'production'
          ? []
          : true,

    /** Failed sign-ins allowed per IP before the endpoint starts rejecting. */
    loginMaxAttempts: intEnv('LOGIN_MAX_ATTEMPTS', 10),
    loginWindowMs: intEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000, 1000),

    /** Request body ceiling. Runs are JSON configs; they are never large. */
    bodyLimitBytes: intEnv('BODY_LIMIT_BYTES', 2 * 1024 * 1024, 1024),

    /**
     * Who can see a run.
     *   shared  every authenticated operator sees every run (team engagements)
     *   private each operator sees only their own runs (least privilege)
     */
    runVisibility: (process.env.RUN_VISIBILITY === 'private' ? 'private' : 'shared'),

    /** Set when running behind a reverse proxy so req.ip is the real client. */
    trustProxy: process.env.TRUST_PROXY === 'true',
  },

  /** Global execution ceilings. These are typo guards, not policy gates. */
  limits: {
    maxRequests: intEnv('MAX_REQUESTS', 20_000),
    maxConcurrency: intEnv('MAX_CONCURRENCY', 50),
    maxRps: intEnv('MAX_RPS', 1000),
    /** Runs accepted but not yet started before the API sheds load. */
    maxQueueDepth: intEnv('MAX_QUEUE_DEPTH', 50),
  },

  /**
   * The administrator account created on first boot.
   *
   * The password is the one credential that can approve operators, so it is
   * never allowed to default silently in production: an installation reachable
   * on the network with a published password hands admin to anyone who reads
   * this repository. In development the fallback is kept so a fresh clone works,
   * but it is reported loudly at startup.
   */
  seedUser: {
    id: process.env.SEED_USER_ID ?? '00000000-0000-4000-8000-000000000001',
    email: process.env.SEED_USER_EMAIL ?? 'operator@example.com',
    displayName: process.env.SEED_USER_NAME ?? 'Operator',
    password:
      process.env.SEED_USER_PASSWORD ??
      (nodeEnv === 'production' ? '' : DEFAULT_SEED_PASSWORD),
    role: 'admin' as const,
    creditsTotal: intEnv('SEED_USER_CREDITS', 100, 0),
  },

  /** True when the built-in development password is still in use. */
  usingDefaultSeedPassword: (process.env.SEED_USER_PASSWORD ?? '') === '',
} as const;

if (nodeEnv === 'production' && !config.seedUser.password) {
  throw new Error(
    'SEED_USER_PASSWORD must be set in production.\n' +
      'The seeded account is an administrator: it can approve operators and\n' +
      'reach every customer target this server can route to. Refusing to start\n' +
      'with a default or empty password.',
  );
}

export const RUN_ID = (): string => randomUUID();
