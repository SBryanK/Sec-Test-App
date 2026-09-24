# Validation Report

Everything in this document was executed on this machine. Nothing is projected
or estimated.

Reproduce the whole thing with:

```bash
./ops/verify.sh        # typecheck + 144 automated tests
node ops/e2e-app.mjs   # 30-check flow through the installed APK on an emulator
```

---

## 1. Automated test suites

| Suite | File | Result |
|---|---|---|
| Detector unit tests | `apps/api/test/detectors.test.ts` | **52 / 52 pass** |
| Platform fingerprinting | `apps/api/test/fingerprint.test.ts` | **16 / 16 pass** |
| Engine end-to-end | `apps/api/test/engine.e2e.test.ts` | **22 / 22 pass** |
| Catalog + validation | `packages/shared/test/catalog.test.ts` | **28 / 28 pass** |
| API integration | `apps/api/test/api.integration.test.ts` | **30 / 30 pass** |
| Operator anonymity | `apps/api/test/anonymity.test.ts` | **34 / 34 pass** |
| Access control | `apps/api/test/access-control.test.ts` | **20 / 20 pass** |
| Load concurrency primitives | `apps/api/test/concurrency.test.ts` | **18 / 18 pass** |
| Mobile UI contract | `apps/mobile/test/ui-contract.test.ts` | **16 / 16 pass** |
| Mobile API client | `apps/mobile/test/api-client.test.ts` | **23 / 23 pass** |
| **Total** | | **259 / 259 pass** |

Typecheck is clean across all workspaces. `ops/verify.sh` additionally builds the
production bundle and asserts it stays up and serves a request.

### Live behavioural checks (`ops/check-live.ts`)

Unit tests can only assert what a function returned. The checks below assert
what the **target observed** and what the **ledger recorded**, against the
running stack — the things a mock cannot lie about. They run as part of
`ops/verify.sh` and currently pass **33 / 33**:

| Check | What it proves |
|---|---|
| Spike rate ceiling | A config asking for 2000 rps is capped at the server's 30 rps limit, the cap is reported in metrics, and the **achieved** rate is 30 rps |
| Flood pacing | 10 connections at 40 rps produce 40 rps **in total**, not 400 |
| Evidence fidelity | The `User-Agent` in every trace equals the one the fixture actually received, compared header-for-header |
| Anonymity honesty | A pinned `User-Agent` yields no rotation and the trace does not claim any; removing it yields 4–5 distinct profiles across 9 requests |
| Identity containment | No trace of the operator's name or address appears in any header the fixture received |
| Charges follow traffic | A rejected submission costs nothing; completed runs are charged |
| Top-up flow | A request reaches the admin queue, a grant closes it, the balance moves by exactly the granted amount, and the record stays auditable |

### Why the engine tests are trustworthy

Each executor is run twice — once against a deliberately **vulnerable** fixture,
once against a deliberately **protected** one — and the two runs must reach
**opposite** verdicts:

| Test | Vulnerable target | Protected target |
|---|---|---|
| SQL Injection | `bypassed`, CRITICAL, ≥2 findings | `blocked`, 0 findings |
| XSS | `bypassed`, HIGH, ≥1 finding | `blocked`, 0 findings |
| Path Traversal | `bypassed`, CRITICAL, ≥1 finding | `blocked`, 0 findings |
| User-Agent Anomaly | `bypassed`, ≥1 finding | `blocked`, 0 findings |

A detector that always fires would pass the left column and fail the right one.
This is the property that separates a working scanner from a confident-sounding
one.

Every emitted trace is also asserted to carry the forensic fields the platform
promises: sequence number, absolute URL, method, positive request byte count,
recorded total latency, and a verdict — with unique sequence numbers per run.

---

## 2. On-device validation (Android)

Release APK built with Gradle 9.3.1 against Android SDK 35, installed on an
`arm64-v8a` API-35 emulator, driven through the accessibility tree.

**51 / 51 checks passed.** Evidence screenshots are in `artifacts/`.

| # | Check | Result |
|---|---|---|
| 1 | App launches (1s splash, then login) | ✅ |
| 2 | Login screen renders | ✅ |
| 3 | Login form exposes two inputs | ✅ |
| 4 | Authenticates against the API | ✅ |
| 5 | All four categories render | ✅ |
| 6 | Run All Tests action present | ✅ |
| 7 | DoS category lists its tests | ✅ |
| 8 | Config renders the target field | ✅ |
| 9 | Config renders HTTP method + path | ✅ |
| 10 | Config renders numeric params with hints | ✅ |
| 11 | Domain validation banner when empty | ✅ |
| 12 | Defaults panel exposes shipped values | ✅ |
| 13 | Target field accepts input | ✅ |
| 14 | Cart reachable from the catalog | ✅ |
| 15 | Cart lists the queued test | ✅ |
| 16 | Cart shows the target | ✅ |
| 17 | Cart shows credit cost | ✅ |
| 18 | Live run screen renders progress | ✅ |
| 19 | Run reaches a terminal state | ✅ |
| 20 | Run produced no transport errors | ✅ |
| 21 | Results screen shows a summary | ✅ |
| 22 | Results screen exposes per-request tab | ✅ |
| 23 | Per-request telemetry renders | ✅ |
| 24 | Can navigate back to the tab shell | ✅ |
| 25 | History lists the completed run | ✅ |
| 26 | Profile shows the account | ✅ |
| 27 | Profile exposes credits / privacy / help | ✅ |
| 28 | Language toggle present (EN / 中文) | ✅ |
| 29 | Connection validation returns a result | ✅ |
| 30 | Cart exposes the request-identity control | ✅ |
| 31 | Identity offers neutral / browser / identify | ✅ |
| 32 | Identity mode is selectable | ✅ |
| 33 | Server connection screen opens | ✅ |
| 34 | Connect screen explains team setup | ✅ |
| 35 | Access request screen opens | ✅ |
| 36 | It explains that approval is required | ✅ |
| 37 | Request form collects name, email and password | ✅ |
| 38 | Results explain what happened in plain language | ✅ |
| 39 | Results show an iteration breakdown | ✅ |
| 40 | Results no longer show a credits row | ✅ |
| 41 | Results no longer show max severity | ✅ |
| 42 | Request log tab reachable | ✅ |
| 43 | Probe rows reachable by accessibility label | ✅ |
| 44 | Trace detail shows the request URL | ✅ |
| 45 | Trace detail shows the remote address | ✅ |
| 46 | Trace detail lists response headers | ✅ |
| 47 | Trace detail shows the status code | ✅ |
| 48 | History shows the platform path | ✅ |
| 49 | History explains the outcome in a sentence | ✅ |
| 50 | History shows iteration detail | ✅ |
| 51 | No fatal exceptions during the flow | ✅ |

**51 / 51** — re-verified against the release APK built from the corrected source.

### Recorded run from the device

A default HTTP Spike (500 requests, 20 threads, 50 ms interval) launched from
the app against the fixture:

```
Probes              500
Bypassed              0
Blocked               0
Errors                0
Duration         1386 ms
Achieved rate   360.75 req/s
Mean first byte   1.92 ms
Bytes sent        51.8 KB
Bytes received   343.7 KB
Findings              0
```

Every one of the 500 probes was persisted and is individually inspectable in the
Requests tab with its own DNS/TCP/TLS/first-byte/byte-count breakdown.

**That 360.75 req/s figure is itself the measurement of a bug.** The defaults ask
for 20 threads at a 50 ms interval, and the run reported the result without ever
comparing it to what was configured: the real dispatch rate was
`threads × 1000/interval` = **400 rps**, four hundred times the 20 rps an operator
would read from the form. The per-test metrics now record both the requested and
the effective rate, and `ops/check-live.ts` asserts the achieved rate against the
ceiling from a live run. See defect #56.

### Recorded run from the device, after the fixes

The same flow was re-run on a release APK built from the corrected source
(Android 15 emulator, `ops/e2e-app.mjs`):

```
51 / 51 on-device checks passed
```

The run's own live figures, with the ceiling in force, are asserted by
`ops/check-live.ts` rather than transcribed here, so they cannot drift out of
date. Its 33 checks currently pass, including:

```
spike   requested 2000 rps -> target 30 rps -> achieved 30.22 rps
flood   10 connections at 40 rps -> achieved 40.11 rps in total
crawl   recorded User-Agent == the User-Agent the fixture received (7 compared)
browser 4-5 distinct profiles across 9 requests once the config stops pinning a UA
```

---

## 3. Defects found *by* this validation

These are real bugs the test suites caught. They are listed because they are the
evidence that the testing was real.

### Engine

| # | Defect | Impact | Fix |
|---|---|---|---|
| 1 | `1' OR 1=1--` returning `200 Welcome back, administrator` was classified `blocked` and produced **no finding** | A textbook auth bypass was silently missed | Added `detectAuthBypass` (rejected→accepted flip) and removed a `passed`→`blocked` relabel that was masking it |
| 2 | The SQLi control request was itself an attack payload (`1' AND '1'='2'--`) | Boolean divergence could never be attributed to the injection | Control changed to a benign variant (`2`) |
| 3 | Any HTTP 503 counted as "rate limited / blocked" | A collapsing origin was reported as a **defended** one — the opposite conclusion | 503 reclassified as a server error; rate-limit detection narrowed to 403/406/429/451 |
| 4 | A run where **every** probe failed at the transport layer produced `bypassed` + HIGH "origin degraded" | A mistyped target raised a false HIGH finding on every run | Zero successful responses now yields `error`, with a hint when the failures were TLS handshakes |
| 5 | Escaped XSS reflection (`&lt;script&gt;`) was not detected at all | A well-defended endpoint and an untested one were indistinguishable | Added escaped-form comparison; encoded reflection now reports `passed` with a signature |
| 6 | Challenge pages containing "Checking your browser" were not recognised | A bot challenge was reported as an unthrottled bypass | Challenge phrase list extended |
| 7 | Edge provider name was dropped when a block had no body signature | Operators could not tell *what* blocked the request | Provider is now named from response headers in both branches |

### Mobile app

| # | Defect | Impact | Fix |
|---|---|---|---|
| 8 | `expo-file-system@19` was pinned instead of `~57.0.7`, leaving two copies of the module | App **crashed on launch** (`NoClassDefFoundError: FilePermissionModule`) | All Expo deps realigned with `npx expo install --fix` |
| 9 | `react-native-gesture-handler@2.28` imports a Renderer shim removed in RN 0.86 | JS bundling failed outright | Dependency removed (no gesture-handler APIs were used) |
| 10 | `usesCleartextTraffic` is not a valid `app.json` field — it was silently ignored | Login failed with `CLEARTEXT communication not permitted` | Moved to the `expo-build-properties` plugin; verified present in `AndroidManifest.xml` |
| 11 | The catalog was fetched once on mount, before login completed | Test tab permanently showed **"0 tests · 0 categories"** after signing in | `CatalogProvider` now refetches whenever the signed-in operator changes |
| 12 | Cart FAB existed only on the Test tab | "Add to Cart" navigated *back* to the category screen — a dead end with no route to the cart | Extracted a shared `CartFab`, now present on the catalog, category and config screens |

### Operator anonymity & portability

| # | Defect | Impact | Fix |
|---|---|---|---|
| 17 | `EdgeOne-SecTest/1.0 (+internal-pentest)` was the default User-Agent, and the connection-flood raw socket and robots.txt fetch hardcoded it too | Every engagement announced the tool, and that it was a pentest, into the customer's logs | Replaced with an identity layer; default mode now sends no tool identity |
| 18 | Most executors called `buildRequest` directly, bypassing the identity sanitizer | The guard silently did not run for them — operator identity *could* have reached the wire | All 18 call sites routed through `buildFor`/`probeWith`; caught by the wire-level test, not by inspection |
| 19 | Node appends `Host` and `Content-Length` **last**; every real client sends `Host` first | Header order was itself a non-browser fingerprint, which would have undone browser mode entirely | `hoistConnectionHeaders()` restores the canonical positions |
| 20 | Browser profile rotation picked randomly with no memory of the previous pick | The same profile could appear twice in a row — itself a fingerprinting signal | Rotation state now carries across requests in a run; asserted by test |
| 21 | An identity-bearing header supplied by a test config would have been transmitted | A config could leak the operator even with the guard present | Sanitizer runs last, after all config merging; asserted on the wire |
| 22 | Compressed responses (gzip/br) were never decoded | Browser mode advertises compression, so the evidence view would show binary noise, and identical responses hashed differently | `gzip`/`deflate`/`br`/`zstd` decoding with reverse-order application per RFC 9110 |
| 23 | `creditsRemaining` was computed as `allowance − charges`, discarding grants | **An admin approving a credit request saw the balance never move** | Remaining is now `allowance + Σ(all ledger deltas)`; regression test added |
| 24 | The integration suite consumed real credits and eventually failed with an opaque HTTP 402 | Test runs would fail confusingly after enough iterations | Added an explicit `credits:topup` dev utility, invoked by `verify.sh` |
| 25 | `usesCleartextTraffic` again — the plugin was registered as a bare string, so its options were dropped | Would have re-broken login; caught by re-checking the generated manifest rather than trusting the config | Plugin entry corrected and verified in `AndroidManifest.xml` |

**Wire-level proof of the anonymity work:**

```
requests captured: 1235
✔ no tool or operator identity on the wire

rotation sequence: Edge/Win → Chrome/Win → Safari/mac → Chrome/Win → Firefox/Linux → Chrome/mac
consecutive repeat: none
```

### Production-readiness pass

| # | Defect | Impact | Fix |
|---|---|---|---|
| 26 | `@fastify/jwt@9.1.0` pulled `fast-jwt@5.0.6` — **6 advisories, 2 critical** | **Authentication bypass via empty HMAC secret**, and a cache-confusion flaw that could return claims from a *different token* — one operator treated as another | Upgraded to `@fastify/jwt@10.2.2` (fast-jwt 6.3.3); login, rejected tokens and all 30 API tests re-verified |
| 27 | `start` ran `tsx`, a **devDependency** | `npm ci --omit=dev` produced an API that could not start at all — the documented production command was broken | Real build step (`npm run build:api` → `node dist/index.js`), added to `verify.sh` as a smoke test |
| 28 | After bundling, the server **exited immediately after "listening"** | A `import.meta.url === process.argv[1]` guard in `migrate.ts` became true once bundled, so the server ran the migration CLI and exited 0 without serving | CLI moved to `db/migrate-cli.ts`; library modules no longer carry a side-effecting main block |
| 29 | `@teo/shared` marked external by `packages: 'external'` | Bundle crashed at startup — the workspace package ships raw TypeScript that plain node cannot load | Externals now derived from `dependencies`, excluding the workspace package so it bundles |
| 30 | README claimed "every operator sees the same run history"; the code filtered `WHERE user_id = $1` | Documentation and behaviour disagreed | Made visibility explicit: `RUN_VISIBILITY=shared` (default) or `private`. Deletion stays owner-scoped either way |
| 31 | **No rate limiting on `/api/auth/login`** | A platform that *ships* a brute-force test had a brute-forceable login, with a documented default password | `@fastify/rate-limit`: 10 failures / 15 min per IP, successful sign-ins not counted. Verified: 10×401 then 429 |
| 32 | JWT stored in plain AsyncStorage | 30-day credential readable on a rooted device and in device backups | Moved to the platform keystore via `expo-secure-store`, with automatic migration of existing tokens |
| 33 | `bodyLimit` 32 MB | Memory-exhaustion lever for any authenticated caller | 2 MB default, `BODY_LIMIT_BYTES` override. Verified: 3 MB → 413 |
| 34 | CORS `origin: true` | Reflected any origin, in every environment | Deny-by-default in production; `CORS_ORIGINS` allowlist |
| 35 | `schema.sql` applied on every boot with `CREATE TABLE IF NOT EXISTS` | **Could never apply a schema change** — adding a column later would silently do nothing on an existing database | Versioned, transactional migrations in `db/migrations/`. Verified by adding migration 002, watching the column appear, then rolling it back |
| 36 | `.npmrc` contained an absolute path to my machine | Broke `npm install` for every colleague, and leaked a local path | Removed; cache relocation is now an opt-in `TEO_NPM_CACHE` in `.env.local` |
| 37 | Personal Gmail address was the shipped seed default in 6 files | PII in a repo being published internally | Neutral `operator@example.com` default; the real address lives only in the gitignored `.env.local` |

### Access control ("the golden gate")

| # | Defect | Impact | Fix |
|---|---|---|---|
| 38 | Status and revocation were checked in a `currentUser()` helper that **several routes never called** | The entire access-control feature was cosmetic — `/api/catalog` and others accepted suspended and revoked tokens | Enforcement moved into the `authenticate` hook itself; the test asserts it across six protected routes, not one |
| 39 | `@fastify/rate-limit` on sign-in blocked **successful** logins once the bucket filled | `skipSuccessfulRequests` cannot help — the limiter decides before the password is checked, so an attacker burning the budget could lock every operator out of the golden gate. A denial of service I introduced | Replaced with a per-account failure gate that always lets a correct password through and clears on success |
| 40 | Registration limited to 5 per 15 min **per IP** | Would block a team onboarding behind one office NAT — directly at odds with the intended workflow | Raised to 50/hour as an anti-flood backstop; admin approval is the real gate |
| 41 | POST endpoints rejected `Content-Type: application/json` with an empty body | Body-less actions (approve, revoke) returned a confusing 400 for a very common client shape | Added an empty-body-tolerant JSON parser |

### Connection detail and iteration reporting

| # | Defect | Impact | Fix |
|---|---|---|---|
| 42 | Trace INSERT used **hardcoded JSONB placeholder indices** (6 and 12) | Adding two columns shifted them, so the wrong columns were cast and **the API refused to start** | Indices now resolved from column names, so they cannot drift again |
| 43 | Result tabs and probe rows had no accessibility labels | A screen reader could not operate them, and the driver could not either | Labelled; both are now reachable and tested |
| 44 | `Text` primitive lacked `selectable` | Header values and URLs could not be copied out of a finding | Added |
| 45 | Protected fixture could only allow or block | "Blocking began at iteration N" was untestable — there was no mid-run throttle | Fixture now rate-limits after N requests, matching a real edge |

### Concurrency, billing and evidence pass

| # | Defect | Impact | Fix |
|---|---|---|---|
| 56 | **Dispatch pacing was per worker, not per test** | `threads × 1000/interval` was the real rate: the defaults (20 threads, 50 ms) put **400 rps** on the target while the config said 20, and `maxRps` was ignored entirely — the platform's own ceiling was unenforceable. Measured at **485 rps against a 50 rps target** | A shared `makePacer` serialises dispatch scheduling; `effectiveRps` applies the ceiling and the run reports both the requested and the clamped rate |
| 57 | **The flood's `rps` was per connection** | `flood.rps` is documented as the target rate, but 100 connections at 50 rps sent 5000 rps while config and report both said 50 | Paced across the whole test; measured at **40.11 rps** for a 40 rps target |
| 58 | **One failed trace INSERT poisoned the flush chain** | `flushing = flushing.then(...)` left the chain rejected, so every later batch was silently dropped — the run reported success with most of its evidence missing — and the teardown threw before `activeRuns.delete`, stranding the run as `running` forever | The chain is anchored on a settled link, the first failure is recorded and surfaced, and teardown runs unconditionally |
| 59 | **`runPool` siblings kept attacking after a worker threw** | Measured: **400 further requests fired at the target** after the pool's promise had already rejected. The caller believed the run had stopped; the target disagreed | A failure flag stops new claims; in-flight items settle before the error is rethrown |
| 60 | **`openConnection().send()` never cleared its timeout timer** | Every flood connection held a live timer for the full timeout after answering — thousands of pending timers on a real run, and a socket that errored before the status line left the promise pending | One `finish()` path clears the timer and detaches every listener; socket `error`/`close` also settle it |
| 61 | **`sleep()` leaked an abort listener on every call** | Measured: **50 listeners** after 50 sleeps on one signal; a long load test trips `MaxListenersExceeded` and retains every closure | The listener is removed on the normal path |
| 62 | **Credit check and debit were not atomic** | Both were separate statements, so two concurrent submissions passed on a stale balance and overdrew; a run that never finished was never debited at all | The cost is **reserved** inside the transaction that reads the balance, then **settled** against the tests that actually sent traffic. A partial unique index on `(run_id) WHERE reason='run'` makes settlement idempotent |
| 63 | **`credits_used` recorded the planned cost, not the actual one** | The run row and the ledger disagreed | Both are written from the settled amount |
| 64 | **A test skipped for an invalid config, or an executor that threw before its first request, was still billed** | The operator paid for work that never happened | Billing follows **emitted probes**: a test is charged only if it put at least one request on the wire |
| 65 | **Top-up requests were a `delta = 0` row in the ledger and nothing could grant credits** | "An administrator will approve it" was unimplementable — there was no endpoint anywhere that could add credits to a user, and no way to list requests | Requests have their own table with a lifecycle; `GET /api/admin/credit-requests` and `POST /api/admin/users/:id/credits` were added. Existing marker rows are migrated across and removed from the ledger |
| 66 | **The crawler sent one profile's headers and recorded another's** | Two `buildFor` calls per page consumed two rotation steps and could pick different profiles, so the evidence showed headers the target never received | One build per page, used for both the request and the trace. Verified header-for-header against the fixture |
| 67 | **The crawler seeded its queue with `buildFor(ctx, String(depth))`** | Substituted the crawl depth into any injection point in the URL and burned a rotation step before the first fetch | Seeded from the configured entry URL with a null payload |
| 68 | A browser profile was claimed even when the config's own `User-Agent` overrode it | Rotation state advanced on every request while the target saw one unchanging string, and nothing told the operator their anonymity setting was doing nothing | A profile is reported only when it shaped the request; a one-time warning explains the override |
| 69 | **`identity.name` was `run.provenance.device ? '' : ''` — always empty** | The operator's own display name was never scrubbed from an outbound request | `Provenance.operatorName` travels with the run and is added to the sanitizer's needles |
| 70 | **A structurally invalid config crashed the executor** | `Cannot read properties of undefined (reading 'query')` — surfaced as a failed run and a charge, with no actionable message | `validateConfig` rejects a missing `http`/`query`/`headers` block at submit (HTTP 422) and the request builder defaults defensively |
| 71 | `x-cache` was listed as an Alibaba signature | It is one of the most common cache headers on the internet (CloudFront, Fastly, Varnish, nginx), so any of them could be reported as Alibaba | Removed; only Alibaba-specific signals remain |
| 72 | **`/api/history?categories=` silently ignored an unknown value** | A typo widened the result set while the caller believed it had narrowed it | Unknown categories are rejected with HTTP 400 |
| 73 | The `credits/request` route claimed admin visibility that did not exist | A dead-end button | Replaced by the real queue and grant endpoints above |
| 74 | `findByText` in the E2E harness sampled the accessibility tree once | Assertions raced the UI: a correctly working screen could be reported as missing | Replaced by a polling `waitForOptional`; two genuinely synchronous reads also had a meaningless `await` |
| 75 | `ops/tmp/` scratch scripts were outside every tsconfig, so `eslint .` reported parse errors | The bug-focused lint pass could not be run cleanly | Removed; the durable proofs now live in `apps/api/test/concurrency.test.ts` and `ops/check-live.ts` |

Each of these was verified by observing the **old** behaviour, not by reasoning
about it. Representative measurements, taken against the pre-fix code:

```
runPool:  5 items at rejection, 400 items after 600ms      (new: <=10)
sleep:    50 leaked abort listeners                        (new: 0)
pacing:   485 rps against a 50 rps target                  (new: 30.22 rps against a 30 rps cap)
```

### Code re-read

| # | Defect | Impact | Fix |
|---|---|---|---|
| 46 | **The connection flood's raw sockets bypassed the egress proxy** | With a proxy configured, a flood still went out from the executor's own IP — silently defeating the anonymity feature for the noisiest test | Raw sockets now CONNECT-tunnel, with auth |
| 47 | **The config screen's Save button persisted nothing** | It reported "Configuration saved" and wrote nothing — `api.saveConfig` was never called | Save now writes, reports failure honestly, and saved configs are loadable from the Import screen |
| 48 | **A failed run charged the full planned cost** | A run that failed after 1 of 12 tests still billed for 12 | Superseded by #64: billing now follows emitted probes, on a settled reservation |
| 49 | Per-test metrics were **computed and discarded** (`void metricsByTest`) | Every run did the work and threw the result away | Persisted into the run summary; they are the observability payload |
| 50 | **Fastly matched on the generic `via: varnish` header** | Self-hosted Varnish was misidentified as Fastly — they share a lineage | Fastly now matches only its own headers |
| 51 | `Apache-Coyote/1.1` matched `apache` before `tomcat` | Tomcat origins were reported as Apache httpd | Specific signatures now precede general ones |
| 52 | **Migration 003 was edited after it had already been applied** | The new column was never created — an applied migration is not re-run | Reverted 003 and added 004; the process mistake is now documented in the migration itself |
| 53 | `api.deleteSavedConfig` was a no-op that resolved successfully | A caller would believe a delete happened | Removed rather than left as a lie |
| 54 | Unused timing locals in the HTTP client (`bodyStart`, `headersAt`) | Dead computation on every single probe | Removed |
| 55 | Business-logic findings cited no trace evidence | A finding pointed at nothing | Now cites the sequences of the replays that produced it |

### Test harness (found because the assertions were checked, not assumed)

| # | Defect | Fix |
|---|---|---|
| 13 | `tapControl('test')` matched the **"Test Connection"** button instead of the **Test** tab | Exact accessibility-label matching for tabs |
| 14 | `findByText('sign in')` matched the "Sign in" *heading*, so the tap never hit the button | Controls are now located by accessibility label only |
| 15 | Back navigation assumed a single press returned to the tabs | `returnToTabs()` pops until the tab bar is actually visible |
| 16 | History/Profile assertions matched the *Results* screen's provenance text | Assertions now require the screen's own heading |

---

## 4. What is validated and what is not

### Validated

- All 12 attack executors against known-vulnerable and known-protected targets.
- Correct verdict discrimination in both directions.
- Full per-request forensic capture (timings, byte counts, status, payload, evidence).
- Authentication, credit accounting, history filtering, export (JSON/CSV/HTML), and additive config import.
- The complete operator journey on a real Android device image, from splash to report.
- Android release build and installation.

### Not validated

- **iOS.** No Xcode and no CocoaPods on this machine, so no iOS build, install
  or run was performed. The source is cross-platform (no Android-only APIs, no
  platform conditionals in app logic), but that is a code-level claim, not a
  tested one. See the README for the build commands once Xcode is available.
- **Real-world targets.** All validation used the local fixture. No external
  system was contacted at any point.
- **Physical devices.** Validation used an emulator. Real hardware differs in
  radio behaviour, background-execution limits and thermal throttling — which is
  precisely why the load tests are labelled *Device + server*.
- **Scale.** Runs were validated at up to 500 probes. The 20 000-request ceiling,
  the BullMQ migration path and the trace partitioning described in
  `ops/README.md` are designs, not measured behaviour.
