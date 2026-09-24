# Attack Feasibility — What Actually Works From a Phone

You asked which of the attacks in the reference screenshots can genuinely be
performed in the real world from a handset, which cannot, and what should be
added. This is that analysis, and it is not theoretical: every row marked
**Validated** below was executed against the deterministic fixture in
`apps/fixture` and asserted in `apps/api/test/engine.e2e.test.ts`.

The distinction that matters is **where the packets originate**, not what the
attack is called. A handset is a perfectly good HTTP client and a poor load
generator.

---

## Summary

| # | Test | Category | Feasible from phone? | Executor | Validated |
|---|------|----------|----------------------|----------|-----------|
| 1 | HTTP Spike | DoS Protection | ⚠️ Partially | Device + server | ✅ |
| 2 | Connection Flood | DoS Protection | ⚠️ Partially | Device + server | ✅ |
| 3 | SQL Injection | Web Protection | ✅ Yes | Device | ✅ |
| 4 | XSS | Web Protection | ✅ Yes | Device | ✅ |
| 5 | Path Traversal | Web Protection | ✅ Yes | Device | ✅ |
| 6 | Oversized Body | Web Protection | ⚠️ Partially | Device + server | ✅ |
| 7 | User-Agent Anomaly | Bot Management | ✅ Yes | Device | ✅ |
| 8 | Web Crawler | Bot Management | ⚠️ Partially | Device + server | ✅ |
| 9 | Brute Force | API Protection | ✅ Yes | Device | ✅ |
| 10 | IDOR Enumeration | API Protection | ✅ Yes | Device | ✅ |
| 11 | Schema Validation | API Protection | ✅ Yes | Device | ✅ |
| 12 | Business Logic | API Protection | ✅ Yes | Device | ✅ |

**7 fully phone-capable · 5 partial · 0 impossible-as-specified.**

No test in the reference catalog is physically impossible from a phone, because
every one of them is an HTTP-level attack. The partial ratings are about
*intensity and fidelity*, not possibility — and each degrades in a specific,
documented way.

---

## Why the partial ratings are partial

### 1. HTTP Spike — ⚠️ Partial

**What works from the phone.** Bursting a few hundred requests is genuinely
effective and is how you test rate limiting, connection limits and origin
autoscaling triggers.

**Where the phone stops.** Three hard ceilings:

- **Carrier NAT.** Mobile networks put thousands of subscribers behind a small
  pool of public IPs. Your burst arrives from one IP, so per-IP rate limiting
  fires immediately — you measure the rate limiter, not the origin's capacity.
- **Radio latency and jitter.** LTE adds 30–70 ms of variable latency that no
  amount of application tuning removes, which contaminates p95/p99 measurements.
- **Background execution limits.** Android doze and iOS background suspension
  will throttle or kill a long spike. A 600-second test cannot be trusted from a
  handset that has been screen-locked.

**Verdict.** Fine for rate-limit and WAF-behaviour testing up to a few hundred
requests per second. Anything above that is a measurement of the phone's radio,
not the target. The app labels it *Device + server* and the server executor
takes over above the device ceiling.

### 2. Connection Flood — ⚠️ Partial

**What works from the phone.** Holding 100 parallel TCP connections and issuing
requests over them is real L4-adjacent pressure and does exercise connection
pool limits and keep-alive handling.

**Where the phone stops.** The OS file-descriptor ceiling and the carrier's
per-device connection tracking. You will hit `EMFILE` or silent NAT eviction
long before the target's connection table is stressed.

**Verdict.** Useful against small origins and for testing connection-limit
configuration. Not a volumetric L4 flood — no handset can be one.

### 6. Oversized Body — ⚠️ Partial

**What works from the phone.** Generating a multi-megabyte body locally and
posting it is exactly the right test for request-size limits and parser
hardening. The generation cost is on-device and free.

**Where the phone stops.** Uplink bandwidth. On LTE, uploading 10 MB takes
seconds and burns battery; the default 1 MB case is instant but the 10 MB
ceiling in the UI is a slow test from a handset.

**Verdict.** Fully effective up to roughly 1 MB. Above that the server executor
is faster and doesn't tie up the device.

### 8. Web Crawler — ⚠️ Partial

**What works from the phone.** Breadth-first crawling at depth 1–2 against a
normal site is completely practical and is enough to test whether crawler-class
traffic is throttled.

**Where the phone stops.** Depth multiplies request volume roughly
six-fold per level. Depth 5 on a medium site is thousands of requests — an
unreasonable thing to run from a battery-powered device on a metered
connection.

**Verdict.** Depth 1–3 from the device; deeper crawls go to the server executor.

---

## What is genuinely impossible from a phone (and correctly absent)

These are **not** in the reference catalog, and none of them were added. They
cannot be built into a handset app, and they are also the categories with real
potential for collateral damage:

| Vector | Why it cannot work from a phone |
|---|---|
| SYN / UDP / ICMP flood | Requires raw sockets. Non-rooted Android and all of iOS deny `SOCK_RAW`. |
| Volumetric L3/L4 DDoS | Needs aggregate bandwidth across many hosts. One radio cannot produce it. |
| DNS / NTP / memcached amplification | Requires spoofed source addresses, which the carrier network drops, and is abuse regardless. |
| Reflection attacks | Same spoofing requirement. |
| TLS handshake exhaustion at scale | Needs tens of thousands of concurrent handshakes; handset FD and CPU limits cap it at a few hundred. |
| Distributed/botnet-style testing | Requires a fleet, by definition. |

The app does not pretend to offer these. Where a vector is impossible, the
catalog says so rather than emitting a fake result — a pentest tool that reports
a test it did not actually perform is worse than one that omits it.

---

## Tests worth adding

All of the following are pure HTTP-level work, so they are fully phone-capable
and reuse the existing executor framework. None generate load.

### High value — add these

| Test | What it proves | OWASP / CWE |
|---|---|---|
| **SSRF** | The origin fetches attacker-chosen URLs — reaches cloud metadata endpoints (`169.254.169.254`) and internal services. High impact on cloud-hosted origins. | A10:2021, CWE-918 |
| **JWT tampering** | `alg: none`, weak HMAC secret, `kid` injection, expired-token acceptance. Common in API-first products. | A07:2021, CWE-347 |
| **Rate-limit / lockout bypass** | `X-Forwarded-For` rotation, case-toggled paths, trailing-slash and encoded-path variants that dodge a per-path limiter. Directly tests edge config. | A04:2021, CWE-307 |
| **Security headers + TLS grade** | Missing HSTS/CSP/`X-Content-Type-Options`, weak cipher suites, expiring certificates. Cheap, and a standard deliverable line-item. | A05:2021, CWE-693 |
| **CORS misconfiguration** | Reflected `Origin` plus `Access-Control-Allow-Credentials: true` — a serious and extremely common API flaw. | A05:2021, CWE-942 |
| **Open redirect** | `?next=`/`?returnUrl=` accepting external hosts; a standard phishing enabler and a WAF-rule gap. | A01:2021, CWE-601 |
| **Cache poisoning / deception** | Unkeyed header injection into cacheable responses, and `X-Cache` leakage of another user's response. Directly relevant to a CDN product like EdgeOne. | A05:2021, CWE-444 |
| **Exposed sensitive files** | `/.git/config`, `/.env`, `/.aws/credentials`, `backup.sql`, `/.DS_Store`. Trivially automatable, frequently pays out. | A05:2021, CWE-538 |

### Medium value — add if you have the appetite

| Test | Notes |
|---|---|
| **XXE** | XML external entity expansion; needs XML body support, which the schema test already exercises. |
| **SSTI** | Template injection (`{{7*7}}`, `${7*7}`) — overlaps with the existing injection framework. |
| **Command injection** | Time-based and OOB detection, same shape as the SQLi time-based path. |
| **CRLF / header injection** | `%0d%0a` in parameters leading to response splitting. |
| **Host header injection** | Password-reset poisoning and cache poisoning vectors. |
| **GraphQL introspection + depth abuse** | Schema disclosure and unbounded nested query cost. |
| **Subdomain takeover** | Dangling CNAME to an unclaimed bucket or PaaS app. |
| **Default credentials** | Product-specific credential lists; a small extension of the brute-force executor. |

### Requires the server-side agent (not phone-capable)

| Test | Why |
|---|---|
| **HTTP request smuggling** | Needs byte-precise control over `Content-Length`/`Transfer-Encoding` framing and raw socket timing. A phone can *drive* it, but the executor must own the socket. |
| **TLS/JA3 fingerprint variation** | A handset cannot change its own TLS ClientHello fingerprint from JavaScript. This is exactly why User-Agent spoofing alone is weak, and why the Bot Management category is marked partial. |

---

## Detection fidelity — what each executor can and cannot prove

Being explicit about this is what separates a useful pentest tool from a
vulnerability scanner that cries wolf.

| Test | Proves | Does **not** prove |
|---|---|---|
| SQL Injection | A database error leaked, or the response flipped from rejected to accepted, or a measurable time delay matched the injected sleep. | Data exfiltration. The tool does not extract rows, by design. |
| XSS | The payload was reflected with its dangerous characters intact. | Execution. Confirming execution needs a browser; the server executor runs headless for stored/DOM confirmation. |
| Path Traversal | Known file signatures (`root:x:0:0`, `[extensions]`) appeared in the response. | That arbitrary files are readable — only that the listed ones are. |
| Oversized Body | The server accepted a body of the configured size without a limit. | Memory exhaustion. The tool does not attempt to crash the target. |
| User-Agent Anomaly | The spoofed identity was neither challenged nor blocked. | That real bot traffic would also pass — JA3 is unchanged. |
| Brute Force | One dictionary candidate was accepted. | Nothing about credentials outside the supplied dictionary. |
| IDOR | An identifier returned content while a known-forbidden one was refused. | The full blast radius; it samples the configured range. |
| Schema Validation | A malformed body was accepted with a 2xx. | Downstream impact of the malformed data. |
| Business Logic | Identical replays all succeeded, optionally with differing bodies. | Financial impact, which depends on the operation's semantics. |

---

## Load-test safety ceilings

Every load-bearing test clamps to the range its own configuration screen
advertises. These limits are enforced **server-side**, so a modified client
cannot exceed them:

| Parameter | Range | Enforced in |
|---|---|---|
| Burst requests | 10 – 1000 | `validateConfig` + engine budget |
| Request interval | 10 – 5000 ms | `validateConfig` |
| Concurrent threads | 1 – 50 | `validateConfig` + `maxConcurrency` |
| Concurrent connections | 1 – 100 | `validateConfig` |
| Requests per second | 1 – 1000 | `validateConfig` + `maxRps` |
| Test duration | 5 – 600 s | `validateConfig` |
| Total requests per run | ≤ 20 000 | `maxRequests` |
| IDOR enumeration span | ≤ 5000 requests | `validateConfig` |

A typo of `50000` in the burst field is rejected with HTTP 422 before any
packet leaves the device.
