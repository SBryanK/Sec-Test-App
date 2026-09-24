# Production Deployment

What must be in place before this runs against real customer targets, and what
is still your responsibility.

This document is deliberately blunt about the second part. A pentest platform
holds a customer's target list and can generate arbitrary outbound traffic from
inside your network — it is a high-value asset that deserves more than a
default install.

---

## 1. What the code already does

These are implemented and verified, not aspirational.

| Control | Where | Verified by |
|---|---|---|
| Refuses to boot in production without `JWT_SECRET` / `DATABASE_URL` | `config.ts` `required()` | Manual — see VALIDATION.md |
| Login brute-force limiting (10 attempts / 15 min per IP, failures only) | `@fastify/rate-limit` on `/api/auth/login` | 12 wrong passwords → 10×401 then 429 |
| Global API rate limit (600 req/min) | `server.ts` | — |
| Request body ceiling (2 MB, was 32 MB) | `server.ts` `bodyLimit` | 3 MB body → 413 |
| CORS deny-by-default in production | `config.ts` `security.corsOrigins` | `[]` when `NODE_ENV=production` |
| JWT in the platform keystore, not plaintext storage | `apps/mobile/src/api/client.ts` | Migrates existing tokens on first launch |
| Operator identity never reaches the target | `engine/anonymity.ts` | 1235 captured requests, zero leaks |
| Credential headers redacted in trace logs | `executors/context.ts` | — |
| Proxy credentials redacted in provenance | `server.ts` `redactProxy()` | — |
| Parameterised SQL throughout | `db/repo.ts` | — |
| Versioned, transactional migrations | `db/migrations/`, `db/migrate.ts` | Migration 002 applied and rolled back cleanly |
| Runs with zero critical dependency advisories | `package.json` | `npm audit --omit=dev` |

### Recent security fixes worth knowing about

- **`@fastify/jwt` 9.1.0 → 10.2.2.** The old version pulled `fast-jwt@5.0.6`, which
  carried six advisories including an **authentication bypass via empty HMAC
  secret** and a **cache-confusion flaw that could return claims from a different
  token** — which for this application means one operator being treated as
  another. This was the single most important fix in this pass.
- **The production bundle did not work at all.** `start` ran `tsx`, a
  devDependency, so `npm ci --omit=dev` produced an API that could not start.
  There is now a real build (`npm run build:api` → `node dist/index.js`).
- **The bundle then exited immediately.** A `import.meta.url === process.argv[1]`
  guard in `migrate.ts` became true once bundled, so the server ran the migration
  CLI and exited 0 without ever serving a request. The CLI now lives in its own
  module and library files have no side-effecting main block.

---

## 2. Your operating model

This deployment is **one operator's laptop, invitation-only, no proxy**. That
changes which of the usual production concerns actually apply.

| Decision | Consequence |
|---|---|
| **No egress proxy** | Attack traffic leaves from your laptop's IP. The target's logs will show it. Every other anonymity control (headers, User-Agent, ordering) still applies — see `OPSEC.md`. |
| **No reverse proxy / TLS** | Colleagues reach the API over plain HTTP on your LAN. Acceptable on a trusted network; the JWT is in the clear on that segment, so avoid untrusted Wi-Fi. |
| **Secrets on one laptop** | Covered — see below. |
| **You are the golden gate** | Implemented — see below. |
| **Non-expiring tokens** | Implemented, with revocation — see below. |

### Secrets

`JWT_SECRET` is generated on this machine and lives in `.env.local`, which is
**gitignored and never committed**. Verified: `git check-ignore` matches it, and
no tracked file contains a secret of that shape.

Back up `.env.local` somewhere safe. If you lose it, every issued token becomes
invalid and everyone re-signs-in — annoying, not fatal.

Rotating it invalidates all sessions immediately. That is the intended lever if
you ever suspect the file was exposed.

### The golden gate

Access is invitation-only, and it works like this:

1. A colleague installs the app and taps **"Don't have access? Request it"**.
2. They submit their name, email and a password of at least 12 characters.
   The account is created as **pending** and cannot sign in.
3. You open **Profile → Access requests** and approve or reject it.
4. Only after approval can they sign in, from their own device.

Enforced **server-side in the authentication hook**, so it applies to every
protected route — not just the ones that happen to check. The test suite asserts
this across six routes, because an earlier version enforced it in a helper that
some routes never called and the whole feature was cosmetic.

Also available to you as admin:

- **Suspend** — takes effect on the operator's *next request*, without waiting
  for a token to expire.
- **Sign out everywhere** — revokes every token that operator holds. Recovers
  from a leaked credential without locking the account.
- You cannot suspend or revoke yourself; both attempts return 400.

Sign-in failures are throttled **per account** (10 per 15 minutes), and a correct
password always succeeds. A pre-handler rate limit could not do this — it decides
before checking the password, so an attacker burning the budget would lock out
legitimate operators. That is a denial of service, not a defence.

### Non-expiring tokens

`JWT_EXPIRY=never` is the default: an approved operator signs in once and keeps
working. The trade is explicit — **a leaked token stays valid until you revoke
it**, which is why `users.token_version` exists. Revoking bumps the version, and
the next request from any older token is rejected with 401.

Every authenticated request re-checks both the account status and the token
version, so revocation and suspension are immediate rather than eventual.

---

## 3. What still needs doing

Fewer items than a conventional deployment, but these are real.

### Back up the database — **required**

```bash
# The cluster lives here:
#   .teo-pg/data   (or TEO_PGDATA from .env.local)
pg_dump "$DATABASE_URL" | gzip > "teo-$(date +%F).sql.gz"
```

`runs`, `request_traces` and `findings` are engagement evidence. Losing them
mid-engagement means re-testing a customer's production system. Copy the dump
somewhere other than the laptop — a backup on the same disk is not a backup.

### Trace retention — **required if you use this long-term**

`request_traces` is the only table that grows without bound: ~9,500 rows from a
handful of runs already. Nothing prunes it. Recipe for monthly partitions plus
`DROP TABLE` in `ops/README.md` §3.

### A target authorization record — **your policy call**

The app deliberately has no allowlist, as you asked. What it does have is run
provenance: operator, target, timestamp, config hash, and the identity mode used.
That is a strong forensic trail.

It records *what happened*. It does not prove permission existed. Before pointing
this at a customer, make sure the authorization for that target lives somewhere
outside this tool — a signed SOW, an email, a ticket.

### Rotate the seed password

`SEED_USER_PASSWORD` defaults to `edgeone`. It is the administrator account, and
it is the one credential that can approve new operators. Change it in
`.env.local` before you hand the APK to anyone.

---

## 4. Deploying

```bash
# Build
npm ci                       # dev deps needed to build
npm run build:api

# Release — runtime deps only
npm ci --omit=dev
node apps/api/dist/db/migrate-cli.js     # apply migrations
node apps/api/dist/index.js              # serve
```

Migrations run automatically on boot, and are also runnable as a separate
pre-deploy step — which is what you want, so a bad migration fails the deploy
before the new version takes traffic.

### Environment

| Variable | Default | Production |
|---|---|---|
| `DATABASE_URL` | local dev URL | **required** |
| `JWT_SECRET` | dev placeholder | **required** — boot fails without it |
| `NODE_ENV` | `development` | `production` |
| `TRUST_PROXY` | `false` | `true` behind a proxy |
| `CORS_ORIGINS` | permissive in dev | comma-separated list, or leave empty |
| `RUN_VISIBILITY` | `shared` | `private` for least privilege |
| `LOGIN_MAX_ATTEMPTS` | `10` | tune to your team size |
| `LOGIN_WINDOW_MS` | `900000` | 15 minutes |
| `BODY_LIMIT_BYTES` | `2097152` | 2 MB |
| `RATE_LIMIT_MAX` | `600` | per minute, per IP |
| `MAX_REQUESTS` / `MAX_CONCURRENCY` / `MAX_RPS` | `20000` / `50` / `1000` | execution ceilings |
| `MAX_QUEUE_DEPTH` | `50` | shed load beyond this |
| `RUN_CONCURRENCY` | `4` | runs executing in parallel |
| `SEED_USER_PASSWORD` | `edgeone` | **change it** |

### Run visibility

`RUN_VISIBILITY=shared` (the default) lets every operator see every run — the
team-engagement behaviour the README describes.

`RUN_VISIBILITY=private` restricts each operator to their own runs.

**Deletion is always owner-scoped regardless of this setting.** Being able to see
a colleague's run must not mean being able to destroy the evidence.

---

## 5. Readiness verdict

| Area | Status |
|---|---|
| Secrets / PII in the repository | ✅ clean — audited; signing secret lives only in gitignored `.env.local` |
| Dependency vulnerabilities (runtime) | ✅ no criticals (the JWT auth-bypass and identity-mixup advisories are fixed); 15 moderate remain in build-only Expo tooling |
| Authentication | ✅ invitation-only, per-account throttling, non-expiring tokens |
| Authorization | ✅ enforced in the auth hook across every protected route; suspension and revocation take effect immediately |
| Admin controls | ✅ approve, reject, suspend, reinstate, sign-out-everywhere |
| Production build | ✅ bundles and runs on plain `node`; asserted by `verify.sh` |
| Target-facing anonymity | ✅ unless you add an egress proxy, the target sees your laptop's IP |
| Database backups | ⚠️ **yours** |
| Trace retention | ⚠️ **yours** — unbounded growth |
| Target authorization record | ⚠️ **yours** — a policy decision, not a code gap |

**Safe to publish internally: yes.** 199 tests pass, the critical advisories are
fixed, and the production bundle is verified to start and serve.

**Safe to point at a customer: yes, once you have changed the seed password and
have an authorization record for that target outside this tool.** The remaining
items are operational, not code.
