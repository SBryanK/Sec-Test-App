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

export const config = {
  port: Number(process.env.PORT ?? 8787),
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
    loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 10),
    loginWindowMs: Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60 * 1000),

    /** Request body ceiling. Runs are JSON configs; they are never large. */
    bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES ?? 2 * 1024 * 1024),

    /**
     * Who can see a run.
     *   shared  every authenticated operator sees every run (team engagements)
     *   private each operator sees only their own runs (least privilege)
     */
    runVisibility: (process.env.RUN_VISIBILITY === 'private' ? 'private' : 'shared') as
      | 'shared'
      | 'private',

    /** Set when running behind a reverse proxy so req.ip is the real client. */
    trustProxy: process.env.TRUST_PROXY === 'true',
  },

  /** Global execution ceilings. These are typo guards, not policy gates. */
  limits: {
    maxRequests: Number(process.env.MAX_REQUESTS ?? 20_000),
    maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? 50),
    maxRps: Number(process.env.MAX_RPS ?? 1000),
    /** Runs accepted but not yet started before the API sheds load. */
    maxQueueDepth: Number(process.env.MAX_QUEUE_DEPTH ?? 50),
  },

  /** Default account created on first boot so the app is usable immediately. */
  seedUser: {
    id: process.env.SEED_USER_ID ?? '00000000-0000-4000-8000-000000000001',
    email: process.env.SEED_USER_EMAIL ?? 'operator@example.com',
    displayName: process.env.SEED_USER_NAME ?? 'Bryan Santasila',
    password: process.env.SEED_USER_PASSWORD ?? 'edgeone',
    role: 'admin' as const,
    creditsTotal: Number(process.env.SEED_USER_CREDITS ?? 100),
  },
} as const;

export const RUN_ID = (): string => randomUUID();
