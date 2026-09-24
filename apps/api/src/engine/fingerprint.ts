/**
 * Platform fingerprinting.
 *
 * Answers two separate questions, because they have different answers:
 *
 *   1. What is in FRONT of the target? (the edge — Cloudflare, EdgeOne, Akamai…)
 *   2. What is BEHIND it? (the origin — nginx, COS, S3, IIS…)
 *
 * These are not the same thing and conflating them produces wrong conclusions.
 * A Tencent COS bucket behind EdgeOne returns `Server: tencent-cos` and
 * `EO-Cache-Status`, so the edge is EdgeOne and the origin is COS object storage.
 * Reporting either as the other would mislead an operator about what they are
 * actually testing.
 *
 * Signatures are observed response-header patterns. Providers add and remove
 * them over time, so detection is best-effort and every match records the header
 * that produced it — an operator can always see the evidence.
 */

import type { PlatformFingerprint } from '@teo/shared';

export type { PlatformFingerprint };

/* ------------------------------------------------------------------ *
 * Edge / CDN signatures
 * ------------------------------------------------------------------ */

interface Signature {
  /** Short stable code, e.g. `cloudflare`. */
  code: string;
  name: string;
  /** Header name (lower-case) that proves this provider. */
  headers?: string[];
  /** Header name plus a value pattern that must also match. */
  headerValues?: Array<{ header: string; pattern: RegExp }>;
  /** `Server` header patterns that identify this provider directly. */
  server?: RegExp;
  kind: 'edge' | 'origin' | 'cdn-software';
}

/**
 * Ordered: the first match wins, so providers with distinctive headers are
 * listed before generic ones. A response carries several of these at once
 * (CloudFront sets `via` and `x-amz-cf-id`), and the specific one is the useful
 * answer.
 */
const SIGNATURES: Signature[] = [
  // ---- major edges -------------------------------------------------------
  {
    code: 'edgeone',
    name: 'Tencent EdgeOne',
    kind: 'edge',
    // Documented defaults: EO-Cache-Status, EO-LOG-UUID, Server: TencentEdgeOne.
    headers: ['eo-cache-status', 'eo-log-uuid', 'x-edgeone-request-id', 'eo-version'],
    server: /tencentedgeone|edgeone/i,
  },
  {
    code: 'cloudflare',
    name: 'Cloudflare',
    kind: 'edge',
    headers: ['cf-ray', 'cf-cache-status', 'cf-request-id', 'cf-mitigated', 'cf-chl-bypass'],
    server: /^cloudflare$/i,
  },
  {
    code: 'akamai',
    name: 'Akamai',
    kind: 'edge',
    headers: [
      'akamai-grn',
      'x-akamai-transformed',
      'x-akamai-request-id',
      'x-akamai-config-log-detail',
      'x-check-cacheable',
    ],
    server: /akamaighost/i,
  },
  {
    code: 'fastly',
    name: 'Fastly',
    kind: 'edge',
    // Deliberately NOT matched on `via: varnish`: Fastly is Varnish-based, so
    // that header appears on self-hosted Varnish too and would misidentify it.
    headers: ['x-served-by', 'x-fastly-request-id', 'fastly-io-info', 'fastly-debug-digest'],
    server: /^fastly$/i,
  },
  {
    code: 'cloudfront',
    name: 'AWS CloudFront',
    kind: 'edge',
    headers: ['x-amz-cf-id', 'x-amz-cf-pop'],
    headerValues: [{ header: 'via', pattern: /cloudfront/i }],
    server: /^cloudfront$/i,
  },
  {
    code: 'azure-frontdoor',
    name: 'Azure Front Door',
    kind: 'edge',
    headers: ['x-azure-ref', 'x-msedge-ref', 'x-fd-healthprobe', 'x-fd-int-roxy-purgeid'],
    server: /azure/i,
  },
  {
    code: 'imperva',
    name: 'Imperva / Incapsula',
    kind: 'edge',
    headers: ['x-iinfo'],
    headerValues: [{ header: 'x-cdn', pattern: /incapsula/i }],
    server: /incapsula/i,
  },
  {
    code: 'sucuri',
    name: 'Sucuri',
    kind: 'edge',
    headers: ['x-sucuri-id', 'x-sucuri-cache', 'x-sucuri-block'],
    server: /sucuri/i,
  },
  {
    code: 'alibaba',
    name: 'Alibaba Cloud CDN / ESA',
    kind: 'edge',
    // `x-cache` is deliberately absent. It is one of the most widely used
    // cache headers on the internet — CloudFront, Fastly, Varnish and countless
    // nginx configs all set it — so listing it here reported any of them as
    // Alibaba whenever the provider's own header was missing or stripped. The
    // remaining signals are Alibaba-specific: the Swift save-time pair, the
    // EagleEye trace id, and the `cacheN.l2` Via pattern.
    headers: ['ali-swift-global-savetime', 'x-swift-cachetime', 'eagleid', 'ali-swift-stat-host'],
    headerValues: [{ header: 'via', pattern: /cache\d*\.l2/i }],
    server: /tengine|alicdn/i,
  },
  {
    code: 'google',
    name: 'Google Cloud CDN',
    kind: 'edge',
    headerValues: [{ header: 'via', pattern: /(^|\s)1\.1 google/i }],
    server: /gws|google frontend|google cloud/i,
  },
  {
    code: 'bunny',
    name: 'Bunny CDN',
    kind: 'edge',
    headers: ['cdn-requestid', 'cdn-cache'],
    server: /bunnycdn/i,
  },
  {
    code: 'gcore',
    name: 'Gcore',
    kind: 'edge',
    server: /^gcore$/i,
  },
  {
    code: 'stackpath',
    name: 'StackPath / Highwinds',
    kind: 'edge',
    headers: ['x-hw'],
  },
  {
    code: 'keycdn',
    name: 'KeyCDN',
    kind: 'edge',
    server: /keycdn/i,
  },
  {
    code: 'edgio',
    name: 'Edgio / Limelight',
    kind: 'edge',
    server: /ecacc|edgio/i,
  },

  // ---- cache software the operator may be running themselves -------------
  {
    code: 'varnish',
    name: 'Varnish',
    kind: 'cdn-software',
    headers: ['x-varnish'],
    headerValues: [{ header: 'via', pattern: /varnish/i }],
  },

  // ---- origin server software -------------------------------------------
  { code: 'openresty', name: 'OpenResty', kind: 'origin', server: /openresty/i },
  { code: 'nginx', name: 'nginx', kind: 'origin', server: /^nginx(\/|$)/i },
  // Tomcat before Apache: `Apache-Coyote/1.1` is Tomcat, and the generic
  // Apache rule would otherwise claim it.
  { code: 'tomcat', name: 'Apache Tomcat', kind: 'origin', server: /tomcat|coyote/i },
  { code: 'apache', name: 'Apache httpd', kind: 'origin', server: /apache/i },
  { code: 'iis', name: 'Microsoft IIS', kind: 'origin', server: /microsoft-iis/i },
  { code: 'litespeed', name: 'LiteSpeed', kind: 'origin', server: /litespeed/i },
  { code: 'caddy', name: 'Caddy', kind: 'origin', server: /^caddy$/i },
  { code: 'envoy', name: 'Envoy', kind: 'origin', server: /^envoy$/i },
  { code: 'traefik', name: 'Traefik', kind: 'origin', server: /traefik/i },
  { code: 'jetty', name: 'Jetty', kind: 'origin', server: /jetty/i },
  { code: 'gunicorn', name: 'Gunicorn', kind: 'origin', server: /gunicorn/i },
  { code: 'werkzeug', name: 'Werkzeug', kind: 'origin', server: /werkzeug/i },
  { code: 'kestrel', name: 'Kestrel', kind: 'origin', server: /kestrel/i },
  { code: 'cowboy', name: 'Cowboy', kind: 'origin', server: /^cowboy$/i },
  { code: 'passenger', name: 'Phusion Passenger', kind: 'origin', server: /phusion|passenger/i },
  { code: 'gws', name: 'Google Web Server', kind: 'origin', server: /^gws$/i },
  { code: 'github', name: 'GitHub Pages', kind: 'origin', server: /github\.com/i },
  { code: 'vercel', name: 'Vercel', kind: 'origin', server: /vercel/i },
  { code: 'netlify', name: 'Netlify', kind: 'origin', server: /netlify/i },
  { code: 'tencent-cos', name: 'Tencent COS', kind: 'origin', server: /tencent-cos/i, headers: ['x-cos-request-id'] },
  { code: 's3', name: 'Amazon S3', kind: 'origin', server: /amazons3/i, headers: ['x-amz-request-id'] },
  { code: 'oss', name: 'Alibaba OSS', kind: 'origin', server: /aliyuncs|oss/i, headers: ['x-oss-request-id'] },
];

/* ------------------------------------------------------------------ *
 * Cache status
 * ------------------------------------------------------------------ */

/**
 * Cache outcome for the request, when the edge reports one.
 *
 * Useful observability: it tells an operator whether they hit a warm edge or
 * went to origin, which changes how to read the latency numbers.
 */
export function cacheStatus(headers: Record<string, string>): string | null {
  for (const name of ['eo-cache-status', 'cf-cache-status', 'x-cache', 'x-cache-status', 'cdn-cache']) {
    const value = headerValue(headers, name);
    if (value) return value;
  }
  return null;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return headerValue(headers, name) !== null;
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

function matches(headers: Record<string, string>, sig: Signature): string | null {
  const server = headerValue(headers, 'server');
  if (sig.server && server && sig.server.test(server)) {
    return `Server: ${server}`;
  }
  for (const name of sig.headers ?? []) {
    const value = headerValue(headers, name);
    if (value !== null) return `${name}: ${value}`;
  }
  for (const { header, pattern } of sig.headerValues ?? []) {
    const value = headerValue(headers, header);
    if (value !== null && pattern.test(value)) return `${header}: ${value}`;
  }
  return null;
}

/**
 * Identify the edge and origin behind a response.
 *
 * Returns the most specific match for each layer, plus every matched signal so
 * the conclusion can be checked rather than trusted.
 */
export function fingerprint(headers: Record<string, string>): PlatformFingerprint {
  const signals: string[] = [];
  let edge: { code: string; name: string } | null = null;
  let origin: { code: string; name: string } | null = null;
  let cacheSoftware: { code: string; name: string } | null = null;

  for (const sig of SIGNATURES) {
    const evidence = matches(headers, sig);
    if (!evidence) continue;
    signals.push(`${sig.name} (${evidence})`);

    if (sig.kind === 'edge' && !edge) edge = { code: sig.code, name: sig.name };
    else if (sig.kind === 'origin' && !origin) origin = { code: sig.code, name: sig.name };
    else if (sig.kind === 'cdn-software' && !cacheSoftware) {
      cacheSoftware = { code: sig.code, name: sig.name };
    }
  }

  // A self-hosted cache in front of the origin is the edge, if nothing else is.
  if (!edge && cacheSoftware) edge = cacheSoftware;

  const server = headerValue(headers, 'server');
  const cache = cacheStatus(headers);

  return {
    edge,
    origin,
    server,
    cacheStatus: cache,
    signals,
    /**
     * True when nothing identified the edge. The operator is probably talking
     * straight to an origin, which is itself worth knowing — it means no edge
     * security is in the path.
     */
    directToOrigin: edge === null,
  };
}

/** One-line human summary, e.g. `Tencent EdgeOne → Tencent COS (cache HIT)`. */
export function describeFingerprint(fp: PlatformFingerprint): string {
  if (fp.directToOrigin) {
    return fp.server ? `Direct to origin (${fp.server})` : 'No edge detected';
  }
  const parts = [fp.edge?.name ?? 'Unknown edge'];
  if (fp.origin) parts.push(fp.origin.name);
  else if (fp.server) parts.push(fp.server);
  const chain = parts.join(' → ');
  return fp.cacheStatus ? `${chain} (cache ${fp.cacheStatus})` : chain;
}

/** Exposed for tests and for the settings screen. */
export const KNOWN_PLATFORMS = SIGNATURES.map((s) => ({
  code: s.code,
  name: s.name,
  kind: s.kind,
}));

export { hasHeader };
