import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type {
  AttackConfig,
  ExportFormat,
  HistoryFilter,
  RunMode,
  RunRecord,
  TestCategoryId,
  TestId,
  TestParametersDocument,
  UserAccount,
} from '@teo/shared';
import {
  ALL_TESTS,
  CATEGORIES,
  DEFAULT_EXECUTION_OPTIONS,
  TEST_COUNT,
  buildDefaultConfig,
  describeConfigSet,
  getTest,
  hasBlockingIssue,
  isCategoryId,
  isTestId,
  normaliseTarget,
  totalCreditCost,
  tryGetTest,
  validateConfig,
} from '@teo/shared';

import { config as appConfig } from './config.ts';
import { closePool } from './db/pool.ts';
import { verifyPassword } from './db/migrate.ts';
import {
  approveUser,
  countTraces,
  runPlatforms,
  summariseRun,
  createRegistrationRequest,
  createRun,
  deleteRun,
  getFindings,
  getRun,
  getTraces,
  getUserByEmail,
  getUserById,
  listAllUsers,
  listPendingUsers,
  listRuns,
  listSavedConfigs,
  rejectUser,
  requestCredits,
  revokeUserTokens,
  runStore,
  saveConfig,
  setUserLanguage,
  setUserStatus,
} from './db/repo.ts';
import { probe } from './engine/httpClient.ts';
import { describeFingerprint, fingerprint } from './engine/fingerprint.ts';
import { buildRequest } from './engine/requestBuilder.ts';
import { ProgressBus, executeRun, activeRuns, type ExecuteRunArgs } from './engine/runner.ts';

const bus = new ProgressBus();

/* ------------------------------------------------------------------ *
 * Sign-in failure gate
 * ------------------------------------------------------------------ */

interface GateEntry {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

/**
 * Per-account sign-in throttle.
 *
 * Keyed on client IP *and* the submitted address, so failures aimed at one
 * account cannot lock out another. Counts only failures, and clears on success.
 *
 * In-memory by design: this deployment runs as a single node. If the API is ever
 * replicated, move this to Redis — otherwise each replica enforces its own
 * budget.
 */
class LoginGate {
  private readonly entries = new Map<string, GateEntry>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  private key(ip: string, email: string): string {
    return `${ip}:${email.trim().toLowerCase()}`;
  }

  /** Drop entries whose window has fully expired, so the map cannot grow forever. */
  private prune(now: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil < now && now - entry.firstFailureAt > this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  check(ip: string, email: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    this.prune(now);
    const entry = this.entries.get(this.key(ip, email));
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };

    if (entry.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000),
      };
    }

    // Window elapsed — start counting again.
    if (now - entry.firstFailureAt > this.windowMs) {
      this.entries.delete(this.key(ip, email));
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(ip: string, email: string): void {
    const now = Date.now();
    const key = this.key(ip, email);
    const existing = this.entries.get(key);

    if (!existing || now - existing.firstFailureAt > this.windowMs) {
      this.entries.set(key, { failures: 1, firstFailureAt: now, blockedUntil: 0 });
      return;
    }

    existing.failures += 1;
    if (existing.failures >= this.maxFailures) {
      existing.blockedUntil = now + this.windowMs;
    }
  }

  recordSuccess(ip: string, email: string): void {
    this.entries.delete(this.key(ip, email));
  }
}

const loginGate = new LoginGate(
  appConfig.security.loginMaxAttempts,
  appConfig.security.loginWindowMs,
);

/* ------------------------------------------------------------------ *
 * Run queue
 * ------------------------------------------------------------------ */

/**
 * Bounded in-process queue.
 *
 * The interface is deliberately narrow so it can be swapped for a BullMQ/Redis
 * implementation without touching the route handlers — see ops/README.md for the
 * worker deployment path.
 */
class RunQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  get depth(): number {
    return this.pending.length + this.running;
  }

  enqueue(task: () => Promise<void>): boolean {
    if (this.depth >= appConfig.limits.maxQueueDepth) return false;
    this.pending.push(task);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.running += 1;
      task()
        .catch((err: unknown) => {
          console.error('[queue] task failed:', err);
        })
        .finally(() => {
          this.running -= 1;
          void this.drain();
        });
    }
  }
}

const queue = new RunQueue(Number(process.env.RUN_CONCURRENCY ?? 4));

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      appConfig.nodeEnv === 'production'
        ? { level: 'info' }
        : { level: 'warn', transport: undefined },
    // Run payloads are JSON configs — kilobytes. The previous 32 MB ceiling
    // was a memory-exhaustion lever for any authenticated caller.
    bodyLimit: appConfig.security.bodyLimitBytes,
    // Behind a reverse proxy this makes req.ip the real client, which the
    // login limiter and run provenance both depend on.
    trustProxy: appConfig.security.trustProxy,
  });

  // CORS: an explicit allowlist in production, permissive only in development.
  // Reflecting any origin would let an arbitrary website drive a logged-in
  // operator's session.
  await app.register(cors, {
    origin: appConfig.security.corsOrigins,
    credentials: false,
  });

  await app.register(jwt, { secret: appConfig.jwtSecret });

  // Accept an empty body on JSON requests. Several endpoints (approve, revoke,
  // cancel) take no payload, and a client that sets Content-Type without
  // sending one is common enough that a 400 here is just a confusing trap.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw === '') return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Global safety net. Individual endpoints tighten this further.
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: '1 minute',
    allowList: [],
  });

  /**
   * Authentication hook, applied to every protected route.
   *
   * This does the full check — signature, account status, and token version —
   * because a route that only verified the signature would silently bypass
   * suspension and revocation. Enforcement has to live in the hook, not in a
   * helper that handlers may forget to call.
   *
   * The resolved account is cached on the request so handlers do not pay for a
   * second lookup.
   */
  const resolvedUser = new WeakMap<FastifyRequest, UserAccount>();

  const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      return;
    }

    const payload = req.user as { sub?: string; ver?: number };
    if (!payload?.sub) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Malformed token' });
      return;
    }

    const user = await getUserById(payload.sub);
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Account no longer exists' });
      return;
    }

    if (user.status !== 'active') {
      await reply.code(403).send({
        error: user.status === 'pending' ? 'pending_approval' : 'account_suspended',
        message:
          user.status === 'pending'
            ? 'Your access request is awaiting approval by an administrator.'
            : 'This account has been suspended. Contact the administrator.',
      });
      return;
    }

    if ((payload.ver ?? 0) !== user.tokenVersion) {
      await reply.code(401).send({
        error: 'token_revoked',
        message: 'This session has been revoked. Please sign in again.',
      });
      return;
    }

    resolvedUser.set(req, user);
  };

  /**
   * Who may see this operator's runs.
   *
   * `shared` (the default) lets the whole team see every run, which is what a
   * shared engagement server is for. `private` restricts each operator to their
   * own — set RUN_VISIBILITY=private for least privilege.
   */
  const scopeFor = (user: UserAccount): string | undefined =>
    appConfig.security.runVisibility === 'private' ? user.id : undefined;

  /** The authenticated account, already validated by the authenticate hook. */
  const currentUser = async (req: FastifyRequest): Promise<UserAccount> => {
    const cached = resolvedUser.get(req);
    if (cached) return cached;

    // Defensive: reaching here means a route used currentUser without the
    // authenticate preHandler. Reject rather than trust an unvalidated token.
    const payload = req.user as { sub?: string } | undefined;
    if (!payload?.sub) {
      throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
    }
    const user = await getUserById(payload.sub);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 401 });
    return user;
  };

  /** Require an admin, for access-control endpoints. */
  const requireAdmin = async (req: FastifyRequest): Promise<UserAccount> => {
    const user = await currentUser(req);
    if (user.role !== 'admin') {
      throw Object.assign(new Error('Administrator access required'), { statusCode: 403 });
    }
    return user;
  };

  /* ---------------- health & catalog ---------------- */

  app.get('/api/health', async () => ({
    status: 'ok',
    version: appConfig.appVersion,
    uptimeSeconds: Math.round(process.uptime()),
    queueDepth: queue.depth,
    activeRuns: activeRuns.size,
  }));

  /**
   * Unauthenticated discovery endpoint.
   *
   * A team member has to be able to point the app at this server *before* they
   * have credentials, and to tell one server from another on a shared network.
   * It deliberately exposes nothing sensitive: a name, a version, and the
   * addresses this host is reachable on.
   */
  app.get('/api/discovery', async (req) => ({
    name: appConfig.serverName,
    version: appConfig.appVersion,
    testCount: TEST_COUNT,
    /** Addresses other devices can use, best-effort. */
    addresses: lanAddresses().map((ip) => `http://${ip}:${appConfig.port}`),
    /** What this request arrived on, which is the value the caller should keep. */
    reachedAt: `${req.protocol}://${req.headers.host ?? `${req.ip}:${appConfig.port}`}`,
  }));

  /**
   * The full test catalog — drives the Test tab and every config screen.
   * Authenticated: the catalog describes the available attack surface and is
   * not something an unauthenticated caller should be able to enumerate.
   */
  app.get('/api/catalog', { preHandler: authenticate }, async () => ({
    categories: CATEGORIES,
    tests: ALL_TESTS,
    testCount: TEST_COUNT,
    defaultOptions: DEFAULT_EXECUTION_OPTIONS,
  }));

  app.get('/api/tests/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const test = tryGetTest(id);
    if (!test) return reply.code(404).send({ error: 'not_found', message: `Unknown test "${id}"` });
    return { test };
  });

  /* ---------------- auth ---------------- */

  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.trim();
    const password = body?.password ?? '';

    if (!email || !password) {
      return reply.code(400).send({ error: 'bad_request', message: 'Email and password are required' });
    }

    // Throttle before doing any work, but only for accounts already failing.
    // A pre-handler rate limit cannot do this correctly: it decides before the
    // password is checked, so an attacker burning the budget would lock out
    // legitimate operators. That is a denial of service, not a defence.
    const gate = loginGate.check(req.ip, email);
    if (!gate.allowed) {
      return reply.code(429).send({
        error: 'too_many_attempts',
        message: `Too many failed sign-ins for this account. Try again in ${gate.retryAfterSeconds}s.`,
      });
    }

    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      loginGate.recordFailure(req.ip, email);
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid email or password' });
    }

    // Correct credentials clear the counter, so a legitimate operator is never
    // held out by somebody else's failed attempts.
    loginGate.recordSuccess(req.ip, email);

    // Status is only revealed once the password is known to be correct, so an
    // unauthenticated caller cannot enumerate which addresses have accounts.
    if (user.status === 'pending') {
      return reply.code(403).send({
        error: 'pending_approval',
        message: 'Your access request is awaiting approval by an administrator.',
      });
    }
    if (user.status === 'suspended') {
      return reply.code(403).send({
        error: 'account_suspended',
        message: 'This account has been suspended. Contact the administrator.',
      });
    }

    const { passwordHash: _hash, ...account } = user;
    // `never` means exactly that — sign without an expiry claim. Revocation is
    // handled by users.token_version, checked on every request.
    const token =
      appConfig.jwtExpiry === 'never'
        ? app.jwt.sign({ sub: account.id, email: account.email, ver: account.tokenVersion })
        : app.jwt.sign(
            { sub: account.id, email: account.email, ver: account.tokenVersion },
            { expiresIn: appConfig.jwtExpiry },
          );

    return {
      token,
      refreshToken: token,
      expiresAt:
        appConfig.jwtExpiry === 'never'
          ? 'never'
          : new Date(Date.now() + 30 * 86_400_000).toISOString(),
      user: account,
    };
    },
  );

  app.get('/api/auth/me', { preHandler: authenticate }, async (req) => currentUser(req));

  /**
   * Request access.
   *
   * Access is invitation-only: this creates a *pending* account that cannot
   * sign in until an administrator approves it.
   *
   * The limit here is deliberately generous. Registration is not a
   * credential-guessing vector — the real gate is admin approval — and a tight
   * per-IP limit would block legitimate onboarding, since an entire office
   * shares one NAT address. This is only an anti-flood backstop.
   */
  app.post(
    '/api/auth/register',
    {
      config: {
        rateLimit: {
          max: Number(process.env.REGISTER_MAX_ATTEMPTS ?? 50),
          timeWindow: appConfig.security.loginWindowMs,
        },
      },
    },
    async (req, reply) => {
      if (!appConfig.allowRegistration) {
        return reply
          .code(403)
          .send({ error: 'registration_closed', message: 'Registration is closed. Contact the administrator.' });
      }

      const body = req.body as
        | { email?: string; displayName?: string; password?: string; note?: string }
        | undefined;
      const email = body?.email?.trim().toLowerCase();
      const displayName = body?.displayName?.trim();
      const password = body?.password ?? '';

      if (!email || !displayName || !password) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'Name, email and password are all required' });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return reply.code(400).send({ error: 'bad_request', message: 'That does not look like an email address' });
      }
      if (password.length < 12) {
        return reply
          .code(400)
          .send({ error: 'weak_password', message: 'Choose a password of at least 12 characters' });
      }

      const outcome = await createRegistrationRequest({
        email,
        displayName,
        password,
        note: body?.note,
      });

      if (!outcome.ok) {
        return reply.code(409).send({
          error: 'already_registered',
          message: 'An account or pending request already exists for that address',
        });
      }

      return reply.code(201).send({
        status: 'pending',
        message: 'Request received. An administrator will approve it before you can sign in.',
      });
    },
  );

  /* ---------------- administration ---------------- */

  /** Pending access requests. */
  app.get('/api/admin/requests', { preHandler: authenticate }, async (req) => {
    await requireAdmin(req);
    return { requests: await listPendingUsers() };
  });

  app.get('/api/admin/users', { preHandler: authenticate }, async (req) => {
    await requireAdmin(req);
    return { users: await listAllUsers() };
  });

  app.post('/api/admin/requests/:id/approve', { preHandler: authenticate }, async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    const ok = await approveUser(id, admin.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: 'No pending request with that id' });
    return { approved: true, id };
  });

  app.post('/api/admin/requests/:id/reject', { preHandler: authenticate }, async (req, reply) => {
    await requireAdmin(req);
    const { id } = req.params as { id: string };
    const ok = await rejectUser(id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: 'No pending request with that id' });
    return { rejected: true, id };
  });

  app.post('/api/admin/users/:id/suspend', { preHandler: authenticate }, async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    if (id === admin.id) {
      return reply.code(400).send({ error: 'bad_request', message: 'You cannot suspend your own account' });
    }
    const ok = await setUserStatus(id, 'suspended');
    if (!ok) return reply.code(404).send({ error: 'not_found', message: 'No such user' });
    return { suspended: true, id };
  });

  app.post('/api/admin/users/:id/activate', { preHandler: authenticate }, async (req, reply) => {
    await requireAdmin(req);
    const { id } = req.params as { id: string };
    const ok = await setUserStatus(id, 'active');
    if (!ok) return reply.code(404).send({ error: 'not_found', message: 'No such user' });
    return { activated: true, id };
  });

  /** Revoke every token an operator holds. Recovers from a leaked credential. */
  app.post('/api/admin/users/:id/revoke', { preHandler: authenticate }, async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    if (id === admin.id) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'Revoking your own tokens would sign you out immediately' });
    }
    const version = await revokeUserTokens(id);
    return { revoked: true, id, tokenVersion: version };
  });

  /* ---------------- connection validation (Search tab) ---------------- */

  /**
   * Backs the "Test Connection" button: a single instrumented request that
   * reports reachability, edge provider and the full timing breakdown.
   */
  app.post('/api/validate-connection', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as { domain?: string } | undefined;
    const raw = body?.domain ?? '';

    if (!raw.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: 'Domain cannot be empty' });
    }

    // Multiple targets may be supplied, separated by comma/semicolon/newline.
    const targets = raw
      .split(/[,;\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);

    const results = await Promise.all(
      targets.map(async (entry) => {
        try {
          const target = normaliseTarget(entry);
          const built = buildRequest(
            { ...buildDefaultConfig('http_spike', entry), http: { method: 'GET' as const, path: '/', query: [], headers: [], body: '' } },
            target,
            null,
          );
          const result = await probe({
            url: built.url,
            method: 'GET',
            headers: built.headers,
            timeoutMs: 10_000,
            followRedirects: true,
            verifyTls: false,
            maxBodyBytes: 256 * 1024,
          });

          return {
            input: entry,
            reachable: result.error === null && result.statusCode !== null,
            host: target.host,
            origin: target.origin,
            statusCode: result.statusCode,
            statusMessage: result.statusMessage,
            server: result.responseHeaders['Server'] ?? result.responseHeaders['server'] ?? null,
            platform: fingerprint(result.responseHeaders),
            platformSummary: describeFingerprint(fingerprint(result.responseHeaders)),
            tls: result.tls,
            timing: result.timing,
            bytesReceived: result.responseBytes,
            redirectChain: result.redirectChain,
            error: result.error,
          };
        } catch (err) {
          return {
            input: entry,
            reachable: false,
            host: null,
            origin: null,
            statusCode: null,
            statusMessage: '',
            server: null,
            platform: null,
            platformSummary: null,
            tls: null,
            timing: { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, totalMs: null },
            bytesReceived: 0,
            redirectChain: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return { results };
  });

  /* ---------------- runs ---------------- */

  app.post('/api/runs', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const body = req.body as {
      configs?: AttackConfig[];
      mode?: RunMode;
      label?: string;
      device?: string;
      platform?: string;
      appVersion?: string;
      note?: string;
    } | undefined;

    const configs = body?.configs ?? [];
    if (!Array.isArray(configs) || configs.length === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'At least one test configuration is required' });
    }
    if (configs.length > 64) {
      return reply.code(400).send({ error: 'bad_request', message: 'Too many configurations in one run (max 64)' });
    }

    // Server-side validation is authoritative: the client cannot bypass it.
    const issues = configs.flatMap((cfg, index) =>
      validateConfig(cfg).map((issue) => ({ ...issue, index, testId: cfg.testId })),
    );
    if (hasBlockingIssue(issues)) {
      return reply.code(422).send({
        error: 'invalid_config',
        message: issues
          .filter((i) => i.severity === 'error')
          .map((i) => `${i.label}: ${i.message}`)
          .join('; '),
        issues,
      });
    }

    const credits = totalCreditCost(configs);
    if (credits > user.creditsRemaining) {
      return reply.code(402).send({
        error: 'insufficient_credits',
        message: `This run costs ${credits} credit(s); ${user.creditsRemaining} remaining`,
      });
    }

    const mode: RunMode =
      body?.mode ?? (configs.length === 1 ? 'single' : configs.length === TEST_COUNT ? 'batch' : 'custom');

    const testIds = [...new Set(configs.map((c) => c.testId))];
    const label =
      body?.label ??
      (mode === 'batch'
        ? `All Tests (${testIds.length})`
        : testIds.length === 1
          ? getTest(testIds[0] as TestId).label
          : `${testIds.length} tests`);

    const id = randomUUID();
    const provenance = {
      operatorId: user.id,
      operatorEmail: user.email,
      device: body?.device ?? 'unknown',
      platform: body?.platform ?? 'unknown',
      appVersion: body?.appVersion ?? appConfig.appVersion,
      configHash: `sha256:${createHash('sha256').update(describeConfigSet(configs)).digest('hex')}`,
      sourceIp: req.ip,
      anonymity: configs[0]?.options.anonymity ?? 'neutral',
      egressProxy: redactProxy(configs[0]?.options.egressProxy ?? null),
      note: body?.note,
    };

    const host = configs[0]?.target.domain ?? '';
    let targetLabel = host;
    try {
      targetLabel = normaliseTarget(host).host;
    } catch {
      /* keep the raw string so the run is still recorded */
    }

    const run = await createRun({
      id,
      userId: user.id,
      mode,
      label,
      target: targetLabel,
      configs,
      creditsUsed: credits,
      provenance,
    });

    const accepted = queue.enqueue(async () => {
      const args: ExecuteRunArgs = { run, store: runStore, bus, limits: appConfig.limits };
      await executeRun(args);
    });

    if (!accepted) {
      return reply.code(503).send({ error: 'queue_full', message: 'Execution queue is saturated; retry shortly' });
    }

    return reply.code(201).send({ run });
  });

  app.get('/api/runs/:id', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    const run = await getRun(id, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });
    const [findings, traceCount, tests, platforms] = await Promise.all([
      getFindings(id),
      countTraces(id),
      summariseRun(id),
      runPlatforms(id),
    ]);
    return { run, findings, traceCount, tests, platforms };
  });

  app.get('/api/runs/:id/traces', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    const run = await getRun(id, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });

    const q = req.query as Record<string, string | undefined>;
    const traces = await getTraces(id, {
      testId: q.testId && isTestId(q.testId) ? q.testId : undefined,
      verdict: q.verdict as never,
      limit: q.limit ? Number(q.limit) : 200,
      offset: q.offset ? Number(q.offset) : 0,
      includeBodies: q.bodies !== 'false',
    });
    return { traces };
  });

  app.get('/api/runs/:id/findings', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    const run = await getRun(id, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });
    return { findings: await getFindings(id) };
  });

  /** Live progress stream for the run screen. */
  app.get('/api/runs/:id/stream', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    const run = await getRun(id, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay the current state so a late subscriber is never blank.
    send('snapshot', { run });

    const unsubscribe = bus.subscribe(id, (progress) => {
      send('progress', progress);
      if (progress.status !== 'running') {
        setTimeout(() => {
          unsubscribe();
          reply.raw.end();
        }, 100);
      }
    });

    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);

    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    return reply;
  });

  app.post('/api/runs/:id/cancel', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    const run = await getRun(id, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });

    const controller = activeRuns.get(id);
    if (!controller) {
      return reply.code(409).send({ error: 'not_running', message: 'Run is not currently executing' });
    }
    controller.abort();
    return { cancelled: true, runId: id };
  });

  app.delete('/api/runs/:id', { preHandler: authenticate }, async (req) => {
    const user = await currentUser(req);
    const { id } = req.params as { id: string };
    // Deletion is always owner-scoped, never visibility-scoped: being able to
    // *see* a colleague's run must not mean being able to destroy the evidence.
    // An admin override would belong here, gated on user.role.
    return { deleted: await deleteRun(id, user.id) };
  });

  /* ---------------- history ---------------- */

  app.get('/api/history', { preHandler: authenticate }, async (req) => {
    const user = await currentUser(req);
    const q = req.query as Record<string, string | undefined>;

    const filter: HistoryFilter = {
      status: (q.status as HistoryFilter['status']) ?? 'any',
      categories: q.categories
        ? (q.categories.split(',').filter(isCategoryId) as TestCategoryId[])
        : undefined,
      domainContains: q.domainContains,
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : 25,
      cursor: q.cursor,
    };

    return listRuns(filter, scopeFor(user));
  });

  /* ---------------- export ---------------- */

  app.post('/api/export', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const body = req.body as { runIds?: string[]; format?: ExportFormat; includeTraces?: boolean } | undefined;
    const runIds = body?.runIds ?? [];
    const format = body?.format ?? 'json';
    const includeTraces = body?.includeTraces ?? false;

    if (runIds.length === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'Select at least one run to export' });
    }

    const bundles = [];
    for (const id of runIds.slice(0, 100)) {
      const run = await getRun(id, scopeFor(user));
      if (!run) continue;
      bundles.push({
        run,
        findings: await getFindings(id),
        traces: includeTraces ? await getTraces(id, { limit: 2000, includeBodies: false }) : undefined,
      });
    }

    if (bundles.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'No matching runs' });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'csv') {
      const rows = [
        'run_id,created_at,target,label,test_ids,status,duration_ms,credits,probes,blocked,bypassed,errors,mean_ttfb_ms,max_severity',
      ];
      for (const { run, findings } of bundles) {
        const s = run.summary;
        rows.push(
          [
            run.id,
            run.createdAt,
            csv(run.target),
            csv(run.label),
            csv(run.testIds.join('|')),
            run.status,
            run.durationMs ?? '',
            run.creditsUsed,
            s?.totalProbes ?? 0,
            s?.blocked ?? 0,
            s?.bypassed ?? 0,
            s?.errors ?? 0,
            s?.meanTtfbMs ?? '',
            s?.maxSeverity ?? '',
          ].join(','),
        );
        for (const f of findings) {
          rows.push(
            [
              run.id,
              run.createdAt,
              csv(run.target),
              csv(`FINDING: ${f.title}`),
              f.testId,
              f.verdict,
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              f.severity,
            ].join(','),
          );
        }
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="teo-sectest-${stamp}.csv"`);
      return rows.join('\n');
    }

    if (format === 'html') {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return renderHtmlReport(bundles, user);
    }

    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="teo-sectest-${stamp}.json"`);
    return {
      generator: `EdgeOne Security Test ${appConfig.appVersion}`,
      exportedAt: new Date().toISOString(),
      exportedBy: user.email,
      runs: bundles,
    };
  });

  /* ---------------- credits & profile ---------------- */

  app.get('/api/credits', { preHandler: authenticate }, async (req) => currentUser(req));

  app.post('/api/credits/request', { preHandler: authenticate }, async (req) => {
    const user = await currentUser(req);
    return requestCredits(user);
  });

  app.patch('/api/profile/language', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const body = req.body as { language?: string } | undefined;
    if (body?.language !== 'en' && body?.language !== 'zh') {
      return reply.code(400).send({ error: 'bad_request', message: 'language must be "en" or "zh"' });
    }
    await setUserLanguage(user.id, body.language);
    return { language: body.language };
  });

  /* ---------------- saved configs ---------------- */

  app.post('/api/configs', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const body = req.body as { testId?: string; name?: string; config?: AttackConfig } | undefined;
    if (!body?.testId || !isTestId(body.testId) || !body.config) {
      return reply.code(400).send({ error: 'bad_request', message: 'testId and config are required' });
    }
    return saveConfig(user.id, body.testId, body.name ?? getTest(body.testId).label, body.config);
  });

  app.get('/api/configs', { preHandler: authenticate }, async (req) => {
    const user = await currentUser(req);
    return { configs: await listSavedConfigs(user.id) };
  });

  /* ---------------- import / export of TestParameters ---------------- */

  app.get('/api/templates/:testId', { preHandler: authenticate }, async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isTestId(testId)) {
      return reply.code(404).send({ error: 'not_found', message: `Unknown test "${testId}"` });
    }
    const doc: TestParametersDocument = {
      $schema: 'https://edgeone.internal/schemas/test-parameters-v1.json',
      version: 1,
      tests: [{ testId, target: { domain: '' }, values: buildDefaultConfig(testId).values }],
    };
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="${testId}_template.json"`);
    return doc;
  });

  /**
   * Additive import: parsed tests are appended to the caller's cart. Nothing is
   * overwritten, matching the "no override" behaviour described in the UI.
   */
  app.post('/api/import', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as { document?: TestParametersDocument; cart?: AttackConfig[] } | undefined;
    const doc = body?.document;

    if (!doc || doc.version !== 1 || !Array.isArray(doc.tests)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'Expected a TestParameters document with version: 1' });
    }

    const cart: AttackConfig[] = body?.cart ?? [];
    const added: AttackConfig[] = [];
    const errors: Array<{ index: number; message: string }> = [];

    doc.tests.forEach((entry, index) => {
      if (!isTestId(entry.testId)) {
        errors.push({ index, message: `Unknown test id "${entry.testId}"` });
        return;
      }
      const base = buildDefaultConfig(entry.testId, entry.target?.domain ?? '');
      const merged: AttackConfig = {
        ...base,
        target: { ...base.target, ...entry.target },
        http: { ...base.http, ...(entry.http ?? {}) },
        values: { ...base.values, ...(entry.values ?? {}) },
        options: { ...base.options, ...DEFAULT_EXECUTION_OPTIONS, ...(entry.options ?? {}) },
      };
      cart.push(merged);
      added.push(merged);
    });

    return { cart, added: added.length, errors, total: cart.length };
  });

  /* ---------------- verification helper ---------------- */

  /**
   * Re-check a single stored probe: re-issues the request and reports whether the
   * verdict still holds. Backs the "verify" action on a finding.
   */
  app.post('/api/verify/:runId/:seq', { preHandler: authenticate }, async (req, reply) => {
    const user = await currentUser(req);
    const { runId, seq } = req.params as { runId: string; seq: string };
    const run = await getRun(runId, scopeFor(user));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found' });

    const traces = (await getTraces(runId, { limit: 2000 })) as Array<{
      seq: number;
      method: string;
      url: string;
      payload: string | null;
      injection_point: string | null;
      status_code: number | null;
      request_headers: Record<string, string>;
      verdict: string;
    }>;

    const original = traces.find((t) => t.seq === Number(seq));
    if (!original) return reply.code(404).send({ error: 'not_found', message: 'Probe not found' });

    const result = await probe({
      url: original.url,
      method: original.method as never,
      headers: original.request_headers,
      body: null,
      timeoutMs: 15_000,
      followRedirects: false,
      verifyTls: false,
    });

    return {
      original: { statusCode: original.status_code, verdict: original.verdict },
      replayed: {
        statusCode: result.statusCode,
        timing: result.timing,
        responseBytes: result.responseBytes,
        responseHash: result.responseHash,
        error: result.error,
      },
      unchanged: result.statusCode === original.status_code,
    };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error('[api] unhandled error:', err);
    void reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: err.message,
    });
  });

  return app;
}

/* ------------------------------------------------------------------ *
 * HTML report (printable to PDF)
 * ------------------------------------------------------------------ */

interface ExportBundle {
  run: RunRecord;
  findings: Awaited<ReturnType<typeof getFindings>>;
  traces?: unknown[];
}

function renderHtmlReport(bundles: ExportBundle[], user: UserAccount): string {
  const escape = (value: unknown): string =>
    String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );

  const sections = bundles
    .map(({ run, findings }) => {
      const s = run.summary;
      const findingRows = findings
        .map(
          (f) => `
        <div class="finding sev-${escape(f.severity)}">
          <h4>${escape(f.title)} <span class="pill">${escape(f.severity)}</span></h4>
          <p class="muted">${escape(f.testId)} · ${escape(f.verdict)}</p>
          <p>${escape(f.description)}</p>
          <pre>${escape(f.evidence)}</pre>
          <p class="remediation"><strong>Remediation.</strong> ${escape(f.remediation)}</p>
          <p class="muted">${f.references.map(escape).join(' · ')}</p>
        </div>`,
        )
        .join('');

      return `
      <section>
        <h2>${escape(run.label)} — ${escape(run.target)}</h2>
        <table>
          <tr><th>Status</th><td>${escape(run.status)}</td><th>Duration</th><td>${run.durationMs ?? 0} ms</td></tr>
          <tr><th>Probes</th><td>${s?.totalProbes ?? 0}</td><th>Credits</th><td>${run.creditsUsed}</td></tr>
          <tr><th>Blocked</th><td>${s?.blocked ?? 0}</td><th>Bypassed</th><td>${s?.bypassed ?? 0}</td></tr>
          <tr><th>Max severity</th><td>${escape(s?.maxSeverity ?? 'none')}</td><th>Mean TTFB</th><td>${s?.meanTtfbMs ?? '—'} ms</td></tr>
          <tr><th>Bytes sent</th><td>${s?.bytesSent ?? 0}</td><th>Bytes received</th><td>${s?.bytesReceived ?? 0}</td></tr>
          <tr><th>Config hash</th><td colspan="3" class="mono">${escape(run.provenance.configHash)}</td></tr>
          <tr><th>Operator</th><td colspan="3">${escape(run.provenance.operatorEmail)} · ${escape(run.provenance.device)} · ${escape(run.createdAt)}</td></tr>
        </table>
        <h3>Findings (${findings.length})</h3>
        ${findingRows || '<p class="muted">No actionable findings.</p>'}
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>EdgeOne Security Test — Report</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #0B1B33; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 19px; margin-top: 36px; border-bottom: 2px solid #3B7DFF; padding-bottom: 6px; }
  h3 { font-size: 15px; margin-top: 24px; }
  h4 { font-size: 15px; margin: 0 0 4px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid #DCE3EF; padding: 6px 10px; text-align: left; }
  th { background: #F4F7FB; width: 130px; }
  .finding { border-left: 4px solid #ccc; padding: 10px 14px; margin: 12px 0; background: #FAFBFD; }
  .sev-critical { border-color: #B3261E; } .sev-high { border-color: #E8590C; }
  .sev-medium { border-color: #F2A900; } .sev-low { border-color: #3B7DFF; } .sev-info { border-color: #8A94A6; }
  .pill { font-size: 11px; text-transform: uppercase; background: #0B1B33; color: #fff; padding: 2px 7px; border-radius: 9px; }
  pre { background: #0B1B33; color: #D7E3F4; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
  .muted { color: #6B7688; font-size: 12px; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; word-break: break-all; }
  .remediation { font-size: 13px; }
  @media print { body { margin: 12mm; } section { page-break-inside: avoid; } }
</style></head>
<body>
  <h1>EdgeOne Security Test — Engagement Report</h1>
  <p class="muted">Generated ${escape(new Date().toISOString())} by ${escape(user.email)} · ${bundles.length} run(s)</p>
  ${sections}
</body></html>`;
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Strip credentials from a proxy URL before it is written to the database. */
function redactProxy(proxyUrl: string | null): string | null {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return 'invalid';
  }
}

/* ------------------------------------------------------------------ *
 * Network helpers
 * ------------------------------------------------------------------ */

/**
 * Non-internal IPv4 addresses this host can be reached on.
 *
 * Used to tell a team member what to type into the app. A machine typically has
 * several (Wi-Fi, Ethernet, VPN, Docker bridges); we surface them all rather
 * than guessing, because the right one depends on the network the phone is on.
 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out.sort();
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

export async function start(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: appConfig.port, host: appConfig.host });

  console.log('');
  console.log(`  ${appConfig.serverName} — listening on port ${appConfig.port}`);
  console.log('');
  console.log(`    this machine   http://127.0.0.1:${appConfig.port}`);
  const addresses = lanAddresses();
  if (addresses.length === 0) {
    console.log('    other devices  (no LAN address detected)');
  } else {
    for (const ip of addresses) {
      console.log(`    other devices  http://${ip}:${appConfig.port}`);
    }
  }
  console.log('');
  console.log('    Point the app at one of these from Profile → API endpoint,');
  console.log('    or tap a link below on the device:');
  for (const ip of addresses) {
    console.log(`      teosectest://connect?url=${encodeURIComponent(`http://${ip}:${appConfig.port}`)}`);
  }
  console.log('');
  if (!process.env.JWT_SECRET && appConfig.nodeEnv === 'production') {
    console.warn('  ⚠ JWT_SECRET is not set — refusing to run in production without it');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[api] ${signal} received, shutting down`);
    for (const controller of activeRuns.values()) controller.abort();
    await app.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export { bus, queue };
