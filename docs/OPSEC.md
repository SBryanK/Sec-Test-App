# Operator Anonymity

What the target sees when we test it, and what it still sees no matter what we do.

The goal is narrow and specific: **a target's SOC should not learn from our traffic
that a pentest is running, or who is running it.** Anything an analyst could
latch onto — a tool User-Agent, an operator email in a header, a browser
fingerprint that does not add up — is a free detection and a finding in itself.

---

## The three modes

Selected per run on the cart screen under **What the target sees**, and recorded
in every run's provenance.

### `neutral` — the default

```
User-Agent: Mozilla/5.0 (compatible; GenericClient/1.0)
Accept: */*
Connection: keep-alive
```

No tool name. No browser pretence. Nothing that distinguishes the request from
any generic HTTP client. This is the default because leaking "a pentest tool is
running" into a customer's logs is a result you have to explain, and it is
entirely avoidable.

### `browser` — full browser fingerprint

A complete, internally-consistent modern browser identity:

- A real User-Agent from a current browser build.
- **Matching** `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` client
  hints — sent for Chromium profiles only. A Safari User-Agent carrying
  Chromium client hints is a scanner tell and is worse than sending nothing.
- The `Sec-Fetch-*` family (`Site`, `Mode`, `User`, `Dest`).
- `Accept`, `Accept-Language`, `Accept-Encoding`, `Upgrade-Insecure-Requests`.
- **Canonical header order** for the browser family. See below.
- **Rotated per request**, never repeating the immediately previous profile.

Six profiles ship: Chrome/Windows, Chrome/macOS, Edge/Windows, Firefox/Windows,
Firefox/Linux, Safari/macOS. Each family has its own header ordering, because
Chromium, Gecko and WebKit genuinely emit headers in different sequences.

### `identify` — announce the tool

```
User-Agent: EdgeOne-SecTest/1.0 (+authorised-pentest; contact security@edgeone.internal)
```

For a purple-team exercise, or an engagement where the customer's SOC has asked
to allow-list you. The app shows a warning banner when this is selected, because
it is the one mode that deliberately contaminates the target's logs.

---

## The identity guard

`sanitizeOutgoingHeaders()` runs on **every** request, in every mode, after every
other transformation:

1. Any header whose *name* is an identity carrier (`X-Operator-Email`,
   `From`, `X-Pentester`, …) is dropped.
2. Any header whose *value* contains the operator's email or name is dropped.

Operator identity belongs in our own provenance record, never in a packet to a
third party. The guard is unconditional — it does not depend on the operator
remembering to enable it.

**Verified on the wire, not in the code.** The integration tests run real
executors against a fixture that records every header it receives, then assert
that the operator email, the operator name, and the tool name never appear:

```
requests captured: 1235
✔ no tool or operator identity on the wire
```

An earlier version of this feature routed most executors through the
identity-aware builder but left several calling the raw one — so the guard never
ran for them. The wire-level test caught it. That is the entire reason the test
asserts on what *arrived* rather than on what the code *intended*.

---

## Header order is a fingerprint too

Node appends `Host` and `Content-Length` **after** any caller-supplied headers.
Every real client — every browser, curl, wget — sends `Host` first. A header
block that ends with `Host: …` is trivially detectable, which would have undone
browser mode entirely.

The client now hoists them into the browser's positions. What the target
actually receives in `browser` mode:

```
host, connection, content-length, sec-ch-ua, sec-ch-ua-mobile,
sec-ch-ua-platform, upgrade-insecure-requests, user-agent, accept,
sec-fetch-site, sec-fetch-mode, sec-fetch-user, sec-fetch-dest,
accept-encoding, accept-language, content-type
```

and for Safari (WebKit ordering, no client hints):

```
host, connection, content-length, accept, sec-fetch-site, sec-fetch-dest,
accept-language, sec-fetch-mode, user-agent, accept-encoding, content-type
```

Rotation is genuine: state carries across requests within a run, so the same
profile is never used twice in a row.

```
rotation sequence: Edge/Win → Chrome/Win → Safari/mac → Chrome/Win → Firefox/Linux → Chrome/mac
consecutive repeat: none
```

---

## Response decoding

Browser mode advertises `Accept-Encoding: gzip, deflate, br`, so targets
compress. Bodies are decoded before being hashed or previewed — otherwise the
evidence view would show binary noise, and two byte-identical responses would
hash differently every time the compressor picked a different window.

`gzip`, `deflate`, `br` and `zstd` (when the Node build supports it) are decoded,
applied in reverse order per RFC 9110. A coding we cannot decode stops the chain
and returns the raw bytes rather than corrupting them.

---

## Egress proxy

Source IP is the single biggest signature, and no amount of header work hides
it. Set a proxy on the cart screen (or `executionOptions.egressProxy`):

- **HTTP targets** — absolute-form request target through the proxy.
- **HTTPS targets** — `CONNECT` tunnel, then TLS negotiated over it.

HTTPS tunnelling matters: without it, HTTPS traffic would go direct and the
target would see the executor's real address, which defeats the point of
configuring a proxy at all.

Credentials are redacted before the proxy URL is written to the run's provenance.

---

## What this does **not** hide

Being precise about this matters more than the feature list. The following remain
observable, and some cannot be fixed from a Node-based executor at all:

| Signal | Status |
|---|---|
| **TLS fingerprint (JA3/JA4)** | **Not addressed.** Node's TLS stack has a distinctive ClientHello — cipher ordering, extensions, ALPN. A WAF with JA3 matching will flag this regardless of headers. Fixing it needs a TLS library with a controllable ClientHello (uTLS-style), which is a separate piece of work. |
| **HTTP/2 and HTTP/3** | We speak HTTP/1.1. Chrome negotiates h2 or h3 with essentially every modern origin. A client offering only HTTP/1.1 is unusual, though not damning. |
| **Source IP** | Hidden **only** if you configure an egress proxy. The default posture is direct. |
| **Timing and volume** | A 500-request burst in 1.4 s is not something a human browser does. Rate and concurrency limits bound this; they do not disguise it. |
| **Payload content** | The attack payloads are, by definition, attack payloads. This work hides *who* is testing, not *that* something is being tested — a WAF will still see `1' OR 1=1--`. |
| **TLS SNI** | The target hostname is in the clear in the ClientHello unless you use ECH, which Node does not support. |
| **DNS** | Resolution goes through the executor's resolver. Use a proxy to change where lookups originate. |

**In short:** header-level identity is handled thoroughly and verified on the
wire. Network-level fingerprinting (TLS, HTTP version, IP) is the operator's
responsibility, and the honest options are an egress proxy plus accepting that
JA3 remains a tell.

---

## Verifying it yourself

```bash
npx tsx --test apps/api/test/anonymity.test.ts     # 34 tests
```

The wire-level tests start the fixture, run real executors, and query what the
fixture received. To inspect it manually while the stack is up:

```bash
curl -s http://127.0.0.1:9900/_log | jq '.requests[-1] | {userAgent, headerOrder}'
curl -s http://127.0.0.1:9900/_reset          # clear the capture buffer
```
