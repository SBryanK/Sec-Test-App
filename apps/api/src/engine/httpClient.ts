import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';

const { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } = zlib;

import type { HttpMethod, TimingBreakdown } from '@teo/shared';

/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

/** Bytes of a body/response retained for evidence. */
export const PREVIEW_BYTES = 2048;

export interface ProbeOptions {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: Buffer | string | null;
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  /** Reuse a keep-alive agent (flood/spike tests) instead of a fresh socket. */
  agent?: http.Agent | https.Agent | false;
  signal?: AbortSignal;
  /** Stop reading the body after this many bytes (oversized-body tests). */
  maxBodyBytes?: number;
  /**
   * Egress proxy (`http://user:pass@host:port`). All traffic is tunnelled so the
   * target never observes the executor's own address.
   */
  proxyUrl?: string | null;
}

export interface ProbeResult {
  statusCode: number | null;
  statusMessage: string;
  responseHeaders: Record<string, string>;
  /** First PREVIEW_BYTES of the decoded body. */
  bodyPreview: string;
  /** Exact number of body bytes received. */
  bodyBytes: number;
  /** Header bytes actually received, as reported on the wire. */
  responseHeaderBytes: number;
  /** Body + headers, after decoding. */
  responseBytes: number;
  /** Bytes actually transferred on the wire, before decompression. */
  wireBytes: number;
  /** The Content-Encoding that was decoded, if any. */
  contentEncoding: string | null;
  /** SHA-256 over the decoded body. */
  responseHash: string | null;
  /** Serialised HTTP/1.1 request size: request line + headers + body. */
  requestBytes: number;
  requestHeaderBytes: number;
  timing: TimingBreakdown;
  /** Any 3xx Location chain that was followed. */
  redirectChain: string[];
  /** Raw TLS certificate summary, when the connection was secure. */
  tls: TlsInfo | null;
  /** True when the request was tunnelled through an egress proxy. */
  viaProxy: boolean;
  /**
   * The resolved IP and port that answered, e.g. `43.174.196.51:443`.
   * Equivalent to "Remote address" in a browser network panel — for a
   * CDN-fronted target this names the edge node that served the request.
   */
  remoteAddress: string | null;
  /** Round-trip time to establish the connection, ms. */
  error: string | null;
}

export interface TlsInfo {
  protocol: string | null;
  cipher: string | null;
  authorized: boolean;
  authorizationError: string | null;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
}

/** Serialise the request message the way it will appear on the wire. */
export function serialiseRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
): { total: number; headerBytes: number; bodyBytes: number } {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}: ${value}`);
  }
  const headerText = `${lines.join('\r\n')}\r\n\r\n`;
  const headerBytes = Buffer.byteLength(headerText, 'utf8');
  const bodyBytes = body ? body.byteLength : 0;
  return { total: headerBytes + bodyBytes, headerBytes, bodyBytes };
}

/** Sum the raw response header block size, matching what the server sent. */
function rawHeaderBytes(rawHeaders: string[] | undefined, statusLine: string): number {
  if (!rawHeaders || rawHeaders.length === 0) return Buffer.byteLength(`${statusLine}\r\n\r\n`);
  let total = Buffer.byteLength(`${statusLine}\r\n`);
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    total += Buffer.byteLength(`${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`);
  }
  return total + 2; // terminating CRLF
}

function headersToObject(rawHeaders: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawHeaders) return out;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (key === undefined || value === undefined) continue;
    const existing = out[key];
    out[key] = existing ? `${existing}, ${value}` : value;
  }
  return out;
}

/** `getPeerCertificate()` types some fields as `string | string[]`; normalise. */
function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter(Boolean).join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Anything else would stringify to "[object Object]"; report nothing instead.
  return null;
}

function summariseCertificate(socket: tls.TLSSocket): TlsInfo | null {
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return null;
  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const daysUntilExpiry =
    validTo && !Number.isNaN(validTo.getTime())
      ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
      : null;
  return {
    protocol: socket.getProtocol(),
    cipher: socket.getCipher()?.name ?? null,
    authorized: socket.authorized,
    authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
    subject: asString(cert.subject?.CN),
    issuer: asString(cert.issuer?.CN),
    validFrom: cert.valid_from ?? null,
    validTo: cert.valid_to ?? null,
    daysUntilExpiry,
  };
}

const emptyTiming = (): TimingBreakdown => ({
  dnsMs: null,
  tcpMs: null,
  tlsMs: null,
  ttfbMs: null,
  totalMs: null,
});

/**
 * Perform one fully-instrumented HTTP request.
 *
 * Every phase is captured separately:
 *   dnsMs   - name resolution (measured around our own lookup wrapper)
 *   tcpMs   - TCP handshake, from lookup completion to `connect`
 *   tlsMs   - TLS handshake, from `connect` to `secureConnect` (https only)
 *   ttfbMs  - time to the FIRST BYTE of the response body
 *   totalMs - request start to response end
 *
 * Never throws for network-level failures: transport errors come back on
 * `result.error` so the caller can record an `error` verdict with full timing.
 */
export async function probe(
  options: ProbeOptions,
  /** Internal: redirect hops already followed. Never set by callers. */
  hops = 0,
): Promise<ProbeResult> {
  const {
    url,
    method,
    headers,
    body,
    timeoutMs,
    followRedirects,
    verifyTls,
    agent,
    signal,
    maxBodyBytes = 8 * 1024 * 1024,
    proxyUrl = null,
  } = options;

  const result: ProbeResult = {
    statusCode: null,
    statusMessage: '',
    responseHeaders: {},
    bodyPreview: '',
    bodyBytes: 0,
    responseHeaderBytes: 0,
    responseBytes: 0,
    wireBytes: 0,
    contentEncoding: null,
    responseHash: null,
    requestBytes: 0,
    requestHeaderBytes: 0,
    timing: emptyTiming(),
    redirectChain: [],
    tls: null,
    viaProxy: false,
    remoteAddress: null,
    error: null,
  };

  const bodyBuffer =
    body === null || body === undefined
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body, 'utf8');

  const t0 = performance.now();
  let dnsMs: number | null = null;
  let tcpMs: number | null = null;
  let tlsMs: number | null = null;
  let firstBodyByteAt: number | null = null;
  let bodyEndedAt: number | null = null;

  const rawChunks: Buffer[] = [];
  let rawCollected = 0;
  const RAW_CAP = 16 * 1024 * 1024; // enough to decode and hash any realistic response
  let received = 0;

  try {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestHeaders: Record<string, string> = { ...headers };
    // Host is set by Node unless we supply it; include it so our byte count is honest.
    if (!Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'host')) {
      requestHeaders['Host'] = parsed.host;
    }
    if (bodyBuffer && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = String(bodyBuffer.byteLength);
    }

    // Reorder before measuring, so the byte count reflects what is sent.
    const orderedHeaders = hoistConnectionHeaders(requestHeaders);
    for (const key of Object.keys(requestHeaders)) delete requestHeaders[key];
    Object.assign(requestHeaders, orderedHeaders);

    const serialised = serialiseRequest(
      method,
      `${parsed.pathname}${parsed.search}`,
      requestHeaders,
      bodyBuffer,
    );
    result.requestBytes = serialised.total;
    result.requestHeaderBytes = serialised.headerBytes;

    const response = await new Promise<{
      statusCode: number | null;
      statusMessage: string;
      rawHeaders: string[] | undefined;
      body: Buffer;
      encoding: string | null;
      truncated: boolean;
      cert: TlsInfo | null;
    }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      // Build the connection target. With a proxy configured the traffic must
      // not go direct, or the target sees the executor's real address.
      const proxy = proxyUrl ? parseProxy(proxyUrl) : null;
      const targetPort = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

      type ConnectionArgs = http.RequestOptions & {
        rejectUnauthorized?: boolean;
        createConnection?: unknown;
      };

      const connection: ConnectionArgs = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: targetPort,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
        // `agent: false` (not undefined) means Node builds a default Agent,
        // which silently overrides `createConnection` — so the CONNECT tunnel
        // below was never used and HTTPS went direct. Only force a fresh
        // connection when we are NOT tunnelling.
        agent: proxy ? undefined : agent === undefined ? false : agent,
        rejectUnauthorized: verifyTls,
        // Time DNS ourselves so the breakdown is exact.
        lookup: (hostname, lookupOptions, callback) => {
          const started = performance.now();
          dns.lookup(hostname, lookupOptions, (err, address, family) => {
            dnsMs = performance.now() - started;
            (callback as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(
              err,
              address as string,
              family,
            );
          });
        },
      };

      if (proxy) {
        result.viaProxy = true;
        if (isHttps) {
          // Tunnel: connect to the proxy but keep the target as the logical host.
          //
          // Credentials go on the CONNECT request inside the tunnel factory.
          // They must NOT be added to `connection.headers`, which are sent to
          // the *target* — doing so leaked the proxy password to every site we
          // tested.
          connection.createConnection = tunnelFactory(
            proxy,
            parsed.hostname,
            targetPort,
            verifyTls,
            timeoutMs,
          ) as unknown as http.RequestOptions['createConnection'];
        } else {
          // Plain HTTP through a proxy uses the absolute-form request target,
          // and here we really are talking to the proxy, so its credentials
          // belong in the request headers.
          connection.hostname = proxy.host;
          connection.port = proxy.port;
          connection.path = url;
          if (proxy.authHeader) {
            connection.headers = {
              ...(connection.headers as Record<string, string>),
              'Proxy-Authorization': proxy.authHeader,
            };
          }
        }
      }

      const req = transport.request(
        connection,
        (res) => {
          const statusCode = res.statusCode ?? null;
          const statusMessage = res.statusMessage ?? '';

          // Which address actually answered. Node reports IPv4-mapped IPv6
          // (`::ffff:127.0.0.1`) on dual-stack sockets; normalise it.
          const sock = res.socket;
          if (sock && !result.remoteAddress) {
            const raw = sock.remoteAddress ?? null;
            const family = sock.remoteFamily ?? '';
            const host = raw?.startsWith('::ffff:') ? raw.slice(7) : raw;
            const port = sock.remotePort;
            if (host) {
              const printable = family === 'IPv6' && !host.includes(':') === false && raw?.includes(':') && !raw?.startsWith('::ffff:')
                ? `[${host}]`
                : host;
              result.remoteAddress = port ? `${printable}:${port}` : printable;
            }
          }
          const rawHeaders = res.rawHeaders;

          if (
            followRedirects &&
            statusCode !== null &&
            statusCode >= 300 &&
            statusCode < 400 &&
            res.headers.location
          ) {
            const location = res.headers.location;
            result.redirectChain.push(location);
            res.resume();
            finish(() =>
              reject(Object.assign(new Error('redirect'), { redirectTo: location, res })),
            );
            return;
          }

          res.on('data', (chunk: Buffer) => {
            if (firstBodyByteAt === null) firstBodyByteAt = performance.now();
            received += chunk.byteLength;
            // Keep the raw (still-compressed) bytes so the body can be decoded
            // before it is hashed or previewed. Hashing compressed bytes would
            // make two identical responses compare as different.
            if (rawCollected < RAW_CAP) {
              const room = RAW_CAP - rawCollected;
              const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
              rawChunks.push(slice);
              rawCollected += slice.byteLength;
            }
            if (received > maxBodyBytes) {
              // Resolve with what we have rather than destroying silently.
              // Destroying emitted neither 'end' nor 'error', so this promise
              // never settled and the whole run hung — and because the socket
              // was gone, `req.setTimeout` could not rescue it either.
              res.destroy();
              finish(() =>
                resolve({
                  statusCode,
                  statusMessage,
                  rawHeaders,
                  body: decodeBody(Buffer.concat(rawChunks), null).body,
                  encoding: null,
                  truncated: true,
                  cert:
                    isHttps && res.socket instanceof tls.TLSSocket
                      ? summariseCertificate(res.socket)
                      : null,
                }),
              );
            }
          });

          res.on('end', () => {
            bodyEndedAt = performance.now();
            const socket = res.socket;
            const cert =
              isHttps && socket instanceof tls.TLSSocket ? summariseCertificate(socket) : null;
            const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
            const raw = Buffer.concat(rawChunks);
            const decoded = decodeBody(raw, encoding);
            finish(() =>
              resolve({
                statusCode,
                statusMessage,
                rawHeaders,
                body: decoded.body,
                encoding: decoded.applied,
                truncated: received > maxBodyBytes,
                cert,
              }),
            );
          });

          res.on('error', (err) => finish(() => reject(err)));

          // Backstop: if the response is torn down for any reason without
          // 'end' or 'error', settle rather than leaving the caller waiting.
          res.on('close', () => {
            if (settled) return;
            if (firstBodyByteAt !== null) {
              finish(() =>
                resolve({
                  statusCode,
                  statusMessage,
                  rawHeaders,
                  body: decodeBody(Buffer.concat(rawChunks), null).body,
                  encoding: null,
                  truncated: true,
                  cert: null,
                }),
              );
            } else {
              finish(() => reject(new Error('Connection closed before a response was received')));
            }
          });
        },
      );

      req.on('socket', (socket) => {
        if ((socket).connecting === false) return; // reused socket
        socket.once('connect', () => {
          tcpMs = performance.now() - (dnsMs !== null ? t0 + dnsMs : t0);
        });
        if (isHttps) {
          socket.once('secureConnect', () => {
            const base = tcpMs !== null && dnsMs !== null ? t0 + dnsMs + tcpMs : t0;
            tlsMs = performance.now() - base;
          });
        }
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => finish(() => reject(err)));

      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('Aborted'));
        } else {
          signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
        }
      }

      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });

    result.statusCode = response.statusCode;
    result.statusMessage = response.statusMessage;
    result.responseHeaders = headersToObject(response.rawHeaders);
    result.tls = response.cert;

    const statusLine = `HTTP/1.1 ${response.statusCode ?? 0} ${response.statusMessage}`;
    result.responseHeaderBytes = rawHeaderBytes(response.rawHeaders, statusLine);
    result.wireBytes = received;
    result.contentEncoding = response.encoding;
    // `bodyBytes` is the decoded size — what the operator cares about and what
    // two responses should be compared on. `wireBytes` is what actually crossed
    // the network, which is what matters for transfer accounting.
    result.bodyBytes = response.body.byteLength;
    result.responseBytes = response.body.byteLength + result.responseHeaderBytes;
    result.bodyPreview = response.body.subarray(0, PREVIEW_BYTES).toString('utf8');
    result.responseHash = `sha256:${createHash('sha256').update(response.body).digest('hex')}`;

    result.timing = {
      dnsMs: dnsMs === null ? null : round(dnsMs),
      tcpMs: tcpMs === null ? null : round(tcpMs),
      tlsMs: tlsMs === null ? null : round(tlsMs),
      ttfbMs: firstBodyByteAt === null ? null : round(firstBodyByteAt - t0),
      totalMs: bodyEndedAt === null ? round(performance.now() - t0) : round(bodyEndedAt - t0),
    };
  } catch (err) {
    // Follow redirects manually so each hop is its own trace row.
    //
    // `hops` is threaded through the recursion. Reading the chain length off
    // this frame always gave 1, so a redirect cycle (`/x` -> `/login` -> `/x`)
    // recursed until the target gave up, hammering it indefinitely.
    const redirectTo = (err as { redirectTo?: string }).redirectTo;
    if (redirectTo && hops < MAX_REDIRECTS) {
      try {
        const next = new URL(redirectTo, url).toString();
        if (result.redirectChain.includes(next)) {
          result.error = `Redirect loop detected at ${next}`;
          return result;
        }
        const followed = await probe({ ...options, url: next, method: 'GET', body: null }, hops + 1);
        return {
          ...followed,
          redirectChain: [...result.redirectChain, ...followed.redirectChain],
          requestBytes: result.requestBytes + followed.requestBytes,
          requestHeaderBytes: result.requestHeaderBytes + followed.requestHeaderBytes,
        };
      } catch {
        /* fall through to the error below */
      }
    }

    result.error = err instanceof Error ? err.message : String(err);
    if (!result.remoteAddress) {
      const target = (err as { address?: string; port?: number }).address;
      if (target) {
        result.remoteAddress = (err as { port?: number }).port
          ? `${target}:${(err as { port?: number }).port}`
          : target;
      }
    }
    result.timing = {
      dnsMs: dnsMs === null ? null : round(dnsMs),
      tcpMs: tcpMs === null ? null : round(tcpMs),
      tlsMs: tlsMs === null ? null : round(tlsMs),
      ttfbMs: firstBodyByteAt === null ? null : round(firstBodyByteAt - t0),
      totalMs: round(performance.now() - t0),
    };
    if (rawCollected > 0) {
      // A partial body still carries evidential value (a truncated error page,
      // for instance), so decode and record whatever arrived.
      const raw = Buffer.concat(rawChunks);
      const decoded = decodeBody(raw, null);
      result.bodyBytes = decoded.body.byteLength;
      result.wireBytes = raw.byteLength;
      result.responseHash = `sha256:${createHash('sha256').update(decoded.body).digest('hex')}`;
      result.bodyPreview = decoded.body.subarray(0, PREVIEW_BYTES).toString('utf8');
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Content decoding
 * ------------------------------------------------------------------ */

/**
 * Decode a response body according to its `Content-Encoding`.
 *
 * This matters for two reasons:
 *   1. Browser-identity mode advertises gzip/br, so targets will compress. An
 *      undecoded body would be binary noise in the evidence view.
 *   2. Two byte-identical responses must hash identically. Hashing compressed
 *      bytes makes the same page compare as different every time the compressor
 *      picks a different window.
 *
 * On failure the raw bytes are returned unchanged, with `applied` left null, so
 * a decode problem can never cost us the evidence itself.
 */
function decodeBody(raw: Buffer, encoding: string | null): { body: Buffer; applied: string | null } {
  const declared = (encoding ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  // Apply codings in reverse order, per RFC 9110.
  let body = raw;
  let applied: string | null = null;

  for (const coding of [...declared].reverse()) {
    try {
      if (coding === 'gzip' || coding === 'x-gzip') {
        body = gunzipSync(body);
        applied = applied ? `${applied}, ${coding}` : coding;
      } else if (coding === 'deflate') {
        // Some servers send raw deflate without the zlib wrapper.
        try {
          body = inflateSync(body);
        } catch {
          body = inflateRawSync(body);
        }
        applied = applied ? `${applied}, ${coding}` : coding;
      } else if (coding === 'br') {
        body = brotliDecompressSync(body);
        applied = applied ? `${applied}, ${coding}` : coding;
      } else if (coding === 'zstd') {
        const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
        if (typeof z.zstdDecompressSync !== 'function') break;
        body = z.zstdDecompressSync(body);
        applied = applied ? `${applied}, ${coding}` : coding;
      } else {
        break; // unknown coding — stop rather than corrupt the bytes
      }
    } catch {
      return { body: raw, applied: null };
    }
  }

  return { body, applied };
}

/* ------------------------------------------------------------------ *
 * Egress proxy
 * ------------------------------------------------------------------ */

export interface ProxyConfig {
  host: string;
  port: number;
  /** Ready-made `Proxy-Authorization` header value, when credentials are present. */
  authHeader: string | null;
  secure: boolean;
}

/** Parse `http://user:pass@host:port` into connection details. */
export function parseProxy(proxyUrl: string): ProxyConfig {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported proxy scheme "${parsed.protocol}" — use http:// or https://`);
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 8080;
  const authHeader =
    parsed.username || parsed.password
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        ).toString('base64')}`
      : null;
  return { host: parsed.hostname, port, authHeader, secure: parsed.protocol === 'https:' };
}

/**
 * Build a `createConnection` that opens a CONNECT tunnel through the proxy and
 * then negotiates TLS with the target over it (RFC 9110 §9.3.6).
 *
 * Without this, HTTPS traffic would go direct and the target would see the
 * executor's real address — which defeats the point of configuring a proxy.
 */
function tunnelFactory(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  verifyTls: boolean,
  timeoutMs: number,
): (options: unknown, callback: (err: Error | null, socket: net.Socket | null) => void) => net.Socket {
  return (_options, callback) => {
    const connectRequest = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.authHeader ? { 'Proxy-Authorization': proxy.authHeader } : {}),
      },
      timeout: timeoutMs,
    });

    connectRequest.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT rejected with HTTP ${res.statusCode ?? 0}`), null);
        return;
      }
      const tlsSocket = tls.connect(
        { socket, servername: targetHost, rejectUnauthorized: verifyTls },
        () => callback(null, tlsSocket),
      );
      tlsSocket.once('error', (err) => callback(err, null));
    });

    connectRequest.once('error', (err) => callback(err, null));
    connectRequest.once('timeout', () =>
      callback(new Error(`Proxy CONNECT timed out after ${timeoutMs}ms`), null),
    );
    connectRequest.end();

    // Node ignores this return value when createConnection is supplied, but the
    // signature requires a socket.
    return undefined as unknown as net.Socket;
  };
}

/**
 * Hoist Host / Connection / Content-Length to the front of the header block.
 *
 * Node appends `Host` and `Content-Length` *after* any caller-supplied headers.
 * Every real HTTP client — every browser, curl, wget — sends `Host` first. A
 * header block that ends with `Host: ...` is a trivially detectable
 * non-browser signature, which would undo the whole point of browser-identity
 * mode. Reordering here, once, keeps it correct for every mode.
 */
function hoistConnectionHeaders(headers: Record<string, string>): Record<string, string> {
  const priorities = ['host', 'connection', 'content-length'];
  const lower = new Map<string, string>();
  for (const key of Object.keys(headers)) lower.set(key.toLowerCase(), key);

  const out: Record<string, string> = {};
  for (const name of priorities) {
    const key = lower.get(name);
    if (key !== undefined) out[key] = headers[key] as string;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!(key.toLowerCase() in Object.fromEntries(priorities.map((p) => [p, true])))) {
      out[key] = value;
    }
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Raw connection helper (Connection Flood Test)
 * ------------------------------------------------------------------ */

export interface ConnectionHandle {
  /** Resolves once the socket is established. */
  ready: Promise<ConnectionTiming>;
  /** Send a raw HTTP/1.1 request line and read the status code. */
  send(statusLine?: string): Promise<{ statusCode: number | null; bytesRead: number }>;
  close(): void;
  destroyed: boolean;
  reusedCount: number;
}

export interface ConnectionTiming {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  error: string | null;
}

/**
 * Open a real TCP (or TLS) connection and keep it open. This is what makes the
 * Connection Flood test genuinely L4-adjacent rather than just rapid HTTP: the
 * sockets are held, and requests are pipelined over the established session.
 */
export function openConnection(
  host: string,
  port: number,
  useTls: boolean,
  timeoutMs: number,
  verifyTls = true,
  /**
   * User-Agent for the raw request line. Defaults to a generic client rather
   * than the tool's own name, so a flood does not announce itself in the
   * target's logs.
   */
  userAgent = 'Mozilla/5.0 (compatible; GenericClient/1.0)',
  /**
   * Egress proxy for this connection.
   *
   * Raw sockets bypassed the proxy entirely before this existed, so a flood
   * configured "through a proxy" still went out from the executor's own address
   * — quietly defeating the point of setting one.
   */
  proxyUrl: string | null = null,
): ConnectionHandle {
  const handle: Partial<ConnectionHandle> & { reusedCount: number; destroyed: boolean } = {
    reusedCount: 0,
    destroyed: false,
  };

  const t0 = performance.now();
  let dnsMs: number | null = null;
  let tcpMs: number | null = null;
  let tlsMs: number | null = null;
  let socket: net.Socket;

  const ready = new Promise<ConnectionTiming>((resolve) => {
    const onError = (err: Error): void => {
      resolve({ dnsMs, tcpMs, tlsMs, error: err.message });
    };

    if (proxyUrl) {
      // CONNECT tunnel: reach the target *through* the proxy, then optionally
      // wrap the tunnelled socket in TLS.
      const proxy = parseProxy(proxyUrl);
      const proxySocket = net.connect({ host: proxy.host, port: proxy.port });
      proxySocket.setTimeout(timeoutMs);
      proxySocket.once('error', onError);
      proxySocket.once('timeout', () =>
        onError(new Error(`Proxy connection timed out after ${timeoutMs}ms`)),
      );

      let tunnelBuffer = '';
      const onTunnelData = (chunk: Buffer): void => {
        tunnelBuffer += chunk.toString('latin1');
        if (!tunnelBuffer.includes('\r\n\r\n')) return;
        proxySocket.off('data', onTunnelData);

        const statusLine = tunnelBuffer.split('\r\n')[0] ?? '';
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
        if (status !== 200) {
          onError(new Error(`Proxy refused CONNECT to ${host}:${port} (HTTP ${status || '?'})`));
          proxySocket.destroy();
          return;
        }

        if (!useTls) {
          socket = proxySocket;
          resolve({ dnsMs, tcpMs, tlsMs: null, error: null });
          return;
        }
        socket = tls.connect(
          { socket: proxySocket, servername: host, rejectUnauthorized: verifyTls },
          () => resolve({ dnsMs, tcpMs, tlsMs, error: null }),
        );
        socket.once('error', onError);
        socket.once('close', () => {
          handle.destroyed = true;
        });
      };

      proxySocket.on('connect', () => {
        tcpMs = performance.now() - t0;
        proxySocket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
            (proxy.authHeader ? `Proxy-Authorization: ${proxy.authHeader}\r\n` : '') +
            '\r\n',
        );
      });
      proxySocket.on('data', onTunnelData);
      return;
    }

    socket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: verifyTls, servername: host })
      : net.connect({ host, port });

    socket.setTimeout(timeoutMs);

    socket.once('lookup', () => {
      dnsMs = performance.now() - t0;
    });
    socket.once('connect', () => {
      tcpMs = performance.now() - (dnsMs !== null ? t0 + dnsMs : t0);
      if (!useTls) resolve({ dnsMs, tcpMs, tlsMs: null, error: null });
    });
    socket.once('secureConnect', () => {
      tlsMs = performance.now() - t0 - (dnsMs ?? 0) - (tcpMs ?? 0);
      resolve({ dnsMs, tcpMs, tlsMs, error: null });
    });
    socket.once('error', onError);
    socket.once('timeout', () => onError(new Error(`Connection timed out after ${timeoutMs}ms`)));
    socket.once('close', () => {
      handle.destroyed = true;
    });
  });

  handle.ready = ready;
  handle.close = (): void => {
    handle.destroyed = true;
    socket?.destroy();
  };

  handle.send = async (
    statusLine = 'GET / HTTP/1.1',
  ): Promise<{ statusCode: number | null; bytesRead: number }> => {
    const timing = await ready;
    if (timing.error) return { statusCode: null, bytesRead: 0 };

    return new Promise((resolve) => {
      let buf = '';
      let bytesRead = 0;
      let done = false;
      // The timeout used to be created and then left running, so every flood
      // connection kept a live timer for the full `timeoutMs` after it had
      // already answered — thousands of pending timers on a big run. It is
      // cleared on every completion path instead.
      let timer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onGone);
        socket.off('close', onGone);
      };

      const finish = (statusCode: number | null): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ statusCode, bytesRead });
      };

      const onData = (chunk: Buffer): void => {
        bytesRead += chunk.byteLength;
        buf += chunk.toString('latin1');
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
        if (match) {
          finish(Number(match[1]));
        } else if (buf.length > 64 * 1024) {
          finish(null);
        }
      };

      // A socket error or close before the status line arrives would otherwise
      // leave this promise pending until the timeout fired.
      const onGone = (): void => finish(null);

      socket.on('data', onData);
      socket.once('error', onGone);
      socket.once('close', onGone);

      socket.write(
        `${statusLine}\r\nHost: ${host}\r\nConnection: keep-alive\r\nUser-Agent: ${userAgent}\r\nAccept: */*\r\n\r\n`,
      );

      timer = setTimeout(() => finish(null), timeoutMs);
    });
  };

  return handle as ConnectionHandle;
}

export { http, https };
