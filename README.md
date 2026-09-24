# EdgeOne Security Test

Internal pentest platform: a React Native mobile app (Android + iOS) driving a
scalable Node execution backend that performs real attack simulations and
returns per-request forensic evidence.

```
┌──────────────────────┐        ┌───────────────────────────┐        ┌──────────┐
│  Mobile app          │  HTTP  │  API (Fastify)            │  SQL   │ Postgres │
│  Expo SDK 57         │ ─────► │  · catalog + validation   │ ─────► │ runs     │
│  expo-router         │  SSE   │  · run orchestration      │        │ traces   │
│  Plus Jakarta Sans   │ ◄───── │  · 12 attack executors    │        │ findings │
└──────────────────────┘        └───────────────────────────┘        └──────────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │  Target under test   │
                                   └──────────────────────┘
```

---

## Quick start

```bash
git clone <your-repo> teo-sectest && cd teo-sectest
./ops/setup.sh         # checks prerequisites, creates the DB, installs, migrates
./ops/stack.sh         # API + vulnerable fixture + protected fixture
```

`ops/setup.sh` is idempotent, so it doubles as a "fix my environment" script.
It needs **Node 20+** and **PostgreSQL** (`brew install postgresql@18` on macOS).
It creates a project-local cluster on port 55432 — it will not touch an existing
PostgreSQL install.

`env.sh` derives every path from its own location, so a clone works from any
directory with no edits. Machine-specific overrides go in `.env.local`
(gitignored); see the bottom of `env.sh`.

Then, in a second terminal:

```bash
npm run dev:mobile     # Expo dev server
```

Sign in with the seeded operator: `operator@example.com` / `edgeone`.

---

## Team setup — running it across devices

The APK is a **universal build** (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`),
so the same file installs on any Android phone, tablet or emulator. No per-device
build is needed.

1. **One person runs the server.**
   ```bash
   source env.sh && ./ops/stack.sh
   ```
   It binds `0.0.0.0` and prints every address it can be reached on:
   ```
     this machine   http://127.0.0.1:8787
     other devices  http://192.168.1.42:8787
     other devices  http://10.8.0.3:8787
   ```

2. **Everyone else installs the APK and opens Profile → API endpoint → Change.**
   Enter the address the server printed — `192.168.1.42` is enough; the scheme
   and port are filled in for you. The app verifies the address against the
   server's discovery endpoint and confirms before saving.

3. **Share it instead of typing it.** The server prints a deep link:
   ```
   teosectest://connect?url=http%3A%2F%2F192.168.1.42%3A8787
   ```
   Send that in the team chat; tapping it opens the app already pointed at the
   server.

**Requirements:** the phone and the server must be on the same network, and the
server host's firewall must allow inbound TCP on port 8787.

**Write access is shared.** Every operator sees the same run history, because
they are all talking to the same server. That is deliberate for a team
engagement — one operator can pick up a run another started.

### Which address goes where

| | Meaning | Emulator value |
|---|---|---|
| **API endpoint** | The API, as seen **from the phone** | `http://10.0.2.2:8787` |
| **Scan target** | The target, as seen **from the backend** | `http://127.0.0.1:9900` |

**The phone does not perform the attack — the backend does.** It streams results
back. So a scan target must be reachable from the *API process*.

`10.0.2.2` is a magic alias that only resolves inside the Android emulator. If
you enter it as a scan target, the backend will try to connect to a non-existent
host and every probe will fail with `ETIMEDOUT`. The engine reports that as an
`error` verdict with a hint, rather than a false HIGH finding.

---

## Operator anonymity

A pentest tool that announces itself contaminates the engagement. The app
therefore sends **no tool identity by default**, and an unconditional guard
strips anything identifying — including the operator's email — from every
outgoing request.

Pick the posture per run on the cart screen:

| Mode | What the target sees |
|---|---|
| **Neutral** (default) | A generic HTTP client. No tool name, no browser pretence. |
| **Browser** | A complete, self-consistent modern browser fingerprint: matching UA + client hints + `Sec-Fetch-*`, canonical header order, rotated per request. |
| **Identify** | Announces the tool by name. Only for engagements where that is intended. |

An **egress proxy** can be set for the run so the target never sees the
executor's own address (HTTPS traffic is tunnelled with `CONNECT`).

This is verified on the wire, not just in the code — the tests run real
executors against a fixture that records what it received, then assert the tool
name and operator identity never appear.

**What it does not hide:** TLS fingerprint (JA3/JA4), HTTP/2 negotiation, and
source IP without a proxy. Read **[docs/OPSEC.md](docs/OPSEC.md)** before relying
on this — it lists each remaining signal honestly, including the ones that
cannot be fixed from a Node executor.

---

## What is in the box

| Path | Purpose |
|---|---|
| `packages/shared` | **The catalog.** All 12 tests declared as data, plus validation, target normalisation and placeholder templating. Drives the UI, the API contract and the engine from one source. |
| `apps/api` | Fastify API, Postgres persistence, run orchestration, and the 12 attack executors. |
| `apps/mobile` | Expo/React Native app. One schema-driven renderer draws all 12 config screens. |
| `apps/fixture` | Deliberately vulnerable / deliberately protected HTTP target used to validate the engine. Not shipped in the app. |
| `ops` | Stack launcher, verification script, asset generator. |
| `docs` | Feasibility analysis, validation report. |

### The catalog is the single source of truth

Adding a test means adding one object to `packages/shared/src/catalog/`. From
that, you automatically get:

- a config screen in the app (rendered by `src/components/fields.tsx`),
- client-side and server-side validation from the declared `min`/`max`,
- a cart line item, a history entry and a result view,
- a probe plan for the progress bar,
- an import/export template.

No screen needs to be written for a new test.

---

## The 12 tests

| Test | Category | Runs on | Credits |
|---|---|---|---|
| HTTP Spike | DoS Protection | Device + server | 1 |
| Connection Flood | DoS Protection | Device + server | 1 |
| SQL Injection | Web Protection | Device | 1 |
| XSS | Web Protection | Device | 1 |
| Path Traversal | Web Protection | Device | 1 |
| Oversized Body | Web Protection | Device + server | 1 |
| User-Agent Anomaly | Bot Management | Device | 1 |
| Web Crawler | Bot Management | Device + server | 1 |
| Brute Force | API Protection | Device | 1 |
| IDOR Enumeration | API Protection | Device | 1 |
| Schema Validation | API Protection | Device | 1 |
| Business Logic | API Protection | Device | 1 |

See **[docs/FEASIBILITY.md](docs/FEASIBILITY.md)** for which of these genuinely
work from a handset, which need the server executor, and why.

### Running everything at once

The Test tab has a **Run All Tests** action that queues all 12 tests against one
target and executes them **simultaneously** — the target sees the combined
attack surface, which is what you want when validating a WAF ruleset. Single
tests and arbitrary custom subsets remain available through the cart and work
identically.

You can always see what will run before it runs: the cart lists every queued
test, each row expands to show the effective settings, and each config screen has
a **Defaults** toggle that shows the shipped default next to your edited value.

---

## Forensic telemetry

Every single probe is persisted with a full record. This is what the Request log
tab renders, and what the JSON/CSV/HTML exports contain.

| Field group | Captured |
|---|---|
| Connection | Request URL, method, status code, **remote address** (the resolved IP:port that answered — the edge node, for a CDN-fronted target), server |
| Timing | `dns_ms`, `tcp_ms`, `tls_ms`, `ttfb_ms` (time to **first body byte**), `total_ms` |
| Size | Exact request bytes (request line + headers + body) and response bytes (headers + body) |
| Protocol | Method, full URL, status code, request and response headers |
| Evidence | Payload used, injection point, 2 KB request/response previews, SHA-256 of the full response body |
| Verdict | `blocked` / `bypassed` / `passed` / `error` / `inconclusive`, severity, human-readable reason, matched signature |
| Iteration | Which attempt produced this result — the request number for load tests, the payload's position for dictionary tests |
| Provenance | Operator, device, platform, source IP, and a SHA-256 hash of the exact configuration set |

Credential-bearing headers (`Authorization`, `Cookie`, `X-Api-Key`) are truncated
before storage, so a trace log never holds a live secret.

---

## Platform fingerprinting

Every response is fingerprinted on **two layers**, because they have different
answers:

```
Tencent EdgeOne → nginx
Tencent EdgeOne → Tencent COS (cache HIT)
Cloudflare → openresty
Direct to origin (nginx/1.24.0)
```

The edge is what is in front; the origin is what is behind. `Server: tencent-cos`
identifies the **origin** (COS object storage), not the CDN serving it — reporting
either as the other would mislead an operator about what they are testing.

Recognised edges include **Cloudflare, Tencent EdgeOne, Akamai, Fastly, AWS
CloudFront, Azure Front Door, Imperva/Incapsula, Sucuri, Alibaba, Google Cloud
CDN, Bunny, Gcore, StackPath, KeyCDN, Edgio** and self-hosted **Varnish**.
Origins include nginx, OpenResty, Apache, Tomcat, IIS, LiteSpeed, Caddy, Envoy,
Traefik, Jetty, Gunicorn, Kestrel, Tencent COS, Amazon S3 and Alibaba OSS.

Detection is heuristic and every conclusion carries the header that produced it,
so it can be checked rather than trusted. A response with no identifying headers
returns "no edge detected" instead of a guess.

## Reading a run

Results lead with **What happened** — plain sentences, not a wall of numbers:

> 500 requests sent across 1 test.
> Protection stopped 15 requests. Blocking began at iteration 26 of HTTP Spike Test.

Below that, an **Iterations** strip shows every attempt in order, coloured by
outcome, with markers for the first block and the first bypass. On a 500-request
burst that is the difference between "39% were refused" and "it started pushing
back around a third of the way in".

History gives the same view per run: the **path** traffic took, a one-sentence
**outcome**, compact numbers, and the iteration strips — so a past run can be
understood without opening it.

Tap any probe for the full network panel: request URL, method, status code,
**remote address**, referrer policy, server, and every response header.

## Verdict semantics

Getting these right is the difference between a useful tool and a noisy one.

| Verdict | Meaning |
|---|---|
| **blocked** | An intermediary or the origin deliberately refused the attack. For a defended target this is the *desired* outcome. |
| **bypassed** | The attack reached the origin, or the response flipped from rejected to accepted. Only `bypassed` produces findings. |
| **passed** | The request behaved normally and no attack evidence was found. |
| **error** | Transport or protocol failure. Never counted as a finding. |
| **inconclusive** | Evidence was insufficient to decide — reported honestly rather than guessed. |

A 503 is deliberately classified as a **server error**, not as "blocked":
counting it as protection would report a collapsing origin as a successfully
defended one.

---

## Verification

```bash
./ops/verify.sh          # everything: typecheck, unit, integration, E2E
```

Or individually:

```bash
npm run typecheck                       # all workspaces
npx tsx --test apps/api/test/detectors.test.ts          # 49 detector unit tests
npx tsx --test apps/api/test/engine.e2e.test.ts         # 19 executor E2E tests
npx tsx --test apps/api/test/api.integration.test.ts    # 29 API tests
```

The engine tests run each executor against **two** fixtures — one vulnerable,
one protected — and assert opposite verdicts. A detector that always fires
passes the first half and fails the second.

See **[docs/VALIDATION.md](docs/VALIDATION.md)** for recorded results.

---

## Platform support

| Platform | Status |
|---|---|
| **Android** | Built, installed and functionally validated. Release APK at `apps/mobile/android/app/build/outputs/apk/release/`. |
| **iOS** | Source is fully cross-platform (no Android-only APIs, no platform conditionals in app logic). **Not built or validated** — this machine has no Xcode and no CocoaPods. |

To build iOS on a Mac with Xcode installed:

```bash
cd apps/mobile
npx expo prebuild --platform ios
cd ios && pod install && cd ..
npx expo run:ios
```

---

## Configuration

All settings come from the environment; see `env.sh` for the local defaults.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://teo@127.0.0.1:55432/teo_sectest` | Postgres connection |
| `PORT` | `8787` | API port |
| `JWT_SECRET` | dev placeholder | **Must** be set in production |
| `MAX_REQUESTS` | `20000` | Hard ceiling on probes per run |
| `MAX_CONCURRENCY` | `50` | Executor pool ceiling |
| `MAX_RPS` | `1000` | Request-rate ceiling |
| `MAX_QUEUE_DEPTH` | `50` | Runs accepted before shedding load |
| `RUN_CONCURRENCY` | `4` | Runs executing in parallel |
| `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` | see `env.sh` | Seed operator account — **change the password** |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limiting sees real client IPs |
| `CORS_ORIGINS` | permissive in dev, deny-all in prod | Comma-separated allowlist |
| `RUN_VISIBILITY` | `shared` | `private` restricts each operator to their own runs |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MS` | `10` / 15 min | Sign-in brute-force limiter |
| `BODY_LIMIT_BYTES` | `2097152` | Request body ceiling |

Before deploying anywhere real, read **[docs/PRODUCTION.md](docs/PRODUCTION.md)** —
it covers TLS, secret management, backups and retention, and is explicit about
what the code does *not* do for you.

---

## Scaling the backend

See **[ops/README.md](ops/README.md)** for the horizontal-scaling path: swapping
the in-process queue for BullMQ/Redis, partitioning the `request_traces` table,
and running stateless API replicas behind a load balancer.

## Production build

```bash
npm run build:api            # bundles to apps/api/dist (esbuild)
node apps/api/dist/index.js  # runs on plain node — no tsx, no devDependencies
```

The dev workflow runs TypeScript through `tsx`, which is a devDependency, so a
production install (`npm ci --omit=dev`) cannot use it. The bundle is the
supported deployment path. Schema migrations are versioned and transactional —
see `apps/api/src/db/migrations/`.
