import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cacheStatus, describeFingerprint, fingerprint, KNOWN_PLATFORMS } from '../src/engine/fingerprint.ts';

/**
 * Platform fingerprinting.
 *
 * The header sets below are the real signatures each provider emits. Two of them
 * recreate responses observed in the wild:
 *
 *   - The EdgeOne/COS set is taken from Tencent's documented default response
 *     headers plus a captured response from an EdgeOne-fronted property.
 *   - The Cloudflare set matches a standard proxied response.
 *
 * The edge/origin distinction is the thing worth testing: `Server: tencent-cos`
 * identifies the *origin* (COS object storage), not the CDN in front of it.
 */

/** A captured response from an EdgeOne-fronted property serving from Tencent COS. */
const EDGEONE_COS = {
  'accept-ranges': 'bytes',
  'access-control-allow-methods': 'HEAD',
  'access-control-max-age': '3600',
  age: '0',
  'alt-svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
  'cache-control': 'max-age=2592000',
  'content-length': '1120',
  'content-type': 'image/png',
  date: 'Thu, 24 Sep 2026 02:47:51 GMT',
  'eo-cache-status': 'HIT',
  'eo-log-uuid': '6610923526439148775',
  etag: '"9b5351b819ae325b7a8ef18f7f8f61a3"',
  server: 'tencent-cos',
  'strict-transport-security': 'max-age=16070400;includeSubDomains;preload',
  'x-cos-hash-crc64ecma': '6091418549718155128',
  'x-cos-request-id': 'NmExNzFiZGRfODUxMWE0MGFfMTA4MF9jMjcxZDk=',
  'x-cos-storage-class': 'MAZ_STANDARD',
  'x-cos-version-id': 'MTg0NDUwNDQ2NjI3Mzg3MTk2Mzc',
};

describe('edge detection', () => {
  it('identifies EdgeOne as the edge and COS as the origin', () => {
    const fp = fingerprint(EDGEONE_COS);
    assert.equal(fp.edge?.code, 'edgeone');
    assert.equal(fp.origin?.code, 'tencent-cos');
    assert.equal(fp.cacheStatus, 'HIT');
    assert.equal(fp.directToOrigin, false);
  });

  it('reads it back as a sentence an operator can act on', () => {
    assert.equal(
      describeFingerprint(fingerprint(EDGEONE_COS)),
      'Tencent EdgeOne → Tencent COS (cache HIT)',
    );
  });

  it('identifies EdgeOne from Server: TencentEdgeOne alone', () => {
    // Documented behaviour: EdgeOne adds this when the origin sends no Server.
    const fp = fingerprint({ server: 'TencentEdgeOne', 'eo-log-uuid': '123' });
    assert.equal(fp.edge?.code, 'edgeone');
    assert.equal(fp.origin, null);
  });

  it('identifies the common edges from their distinctive headers', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['cloudflare', { 'cf-ray': '7d8f9c0e1a2b3c4d-SIN', 'cf-cache-status': 'HIT' }],
      ['akamai', { 'akamai-grn': '0.1a2b3c4d.1699999999.1f2e3d4' }],
      ['fastly', { 'x-served-by': 'cache-sin-wsat1880042-SIN', 'x-cache': 'HIT' }],
      ['cloudfront', { 'x-amz-cf-id': 'abc123', 'x-amz-cf-pop': 'SIN52-C1' }],
      ['azure-frontdoor', { 'x-azure-ref': '0abc123def' }],
      ['sucuri', { 'x-sucuri-id': '12345' }],
      ['imperva', { 'x-iinfo': '9-12345678-12345679 NNNN' }],
    ];

    for (const [expected, headers] of cases) {
      const fp = fingerprint(headers);
      assert.equal(fp.edge?.code, expected, `expected ${expected}, got ${fp.edge?.code ?? 'none'}`);
    }
  });

  it('identifies Akamai from the Server header', () => {
    assert.equal(fingerprint({ server: 'AkamaiGHost' }).edge?.code, 'akamai');
  });

  it('identifies a self-hosted Varnish as the edge', () => {
    const fp = fingerprint({ via: '1.1 varnish (Varnish/7.4)', 'x-varnish': '123456' });
    assert.equal(fp.edge?.code, 'varnish');
  });
});

describe('origin detection', () => {
  it('identifies common origin servers from the Server header', () => {
    const cases: Array<[string, string]> = [
      ['nginx', 'nginx/1.24.0'],
      ['openresty', 'openresty/1.21.4.1'],
      ['apache', 'Apache/2.4.58 (Ubuntu)'],
      ['iis', 'Microsoft-IIS/10.0'],
      ['litespeed', 'LiteSpeed'],
      ['caddy', 'Caddy'],
      ['tomcat', 'Apache-Coyote/1.1'],
      ['gunicorn', 'gunicorn/21.2.0'],
    ];
    for (const [expected, server] of cases) {
      assert.equal(fingerprint({ server }).origin?.code, expected, `${server} should map to ${expected}`);
    }
  });

  it('reports no edge when the request went straight to an origin', () => {
    const fp = fingerprint({ server: 'nginx/1.24.0' });
    assert.equal(fp.edge, null);
    assert.equal(fp.directToOrigin, true);
    assert.match(describeFingerprint(fp), /Direct to origin \(nginx\/1\.24\.0\)/);
  });
});

describe('evidence and honesty', () => {
  it('records which header produced each conclusion', () => {
    const fp = fingerprint(EDGEONE_COS);
    assert.ok(fp.signals.length >= 2, 'expected several signals');
    assert.ok(
      fp.signals.some((s) => s.includes('eo-cache-status')),
      'the EdgeOne signal should name its header',
    );
    assert.ok(
      fp.signals.some((s) => s.includes('tencent-cos')),
      'the COS signal should name its header',
    );
  });

  it('returns nothing rather than guessing on an anonymous response', () => {
    const fp = fingerprint({ 'content-type': 'text/html', date: 'Thu, 24 Sep 2026 02:47:51 GMT' });
    assert.equal(fp.edge, null);
    assert.equal(fp.origin, null);
    assert.equal(fp.server, null);
    assert.equal(fp.directToOrigin, true);
    assert.deepEqual(fp.signals, []);
  });

  it('handles header names case-insensitively', () => {
    const fp = fingerprint({ 'CF-Ray': 'abc-SIN', Server: 'cloudflare' });
    assert.equal(fp.edge?.code, 'cloudflare');
  });

  it('prefers the specific edge over a generic one', () => {
    // CloudFront sets `via` and `x-amz-cf-id`; the specific header must win.
    const fp = fingerprint({ via: '1.1 abc.cloudfront.net (CloudFront)', 'x-amz-cf-id': 'xyz' });
    assert.equal(fp.edge?.code, 'cloudfront');
  });

  it('exposes the platform list for the UI', () => {
    assert.ok(KNOWN_PLATFORMS.length > 20);
    assert.ok(KNOWN_PLATFORMS.some((p) => p.code === 'edgeone' && p.kind === 'edge'));
    assert.ok(KNOWN_PLATFORMS.some((p) => p.code === 'tencent-cos' && p.kind === 'origin'));
  });
});

describe('cache status', () => {
  it('reads the provider-specific cache header', () => {
    assert.equal(cacheStatus({ 'eo-cache-status': 'MISS' }), 'MISS');
    assert.equal(cacheStatus({ 'cf-cache-status': 'DYNAMIC' }), 'DYNAMIC');
    assert.equal(cacheStatus({ 'x-cache': 'Hit from cloudfront' }), 'Hit from cloudfront');
  });

  it('prefers the edge that is actually present', () => {
    assert.equal(cacheStatus({ 'eo-cache-status': 'HIT', 'cf-cache-status': 'MISS' }), 'HIT');
  });

  it('returns null when the edge reports nothing', () => {
    assert.equal(cacheStatus({ server: 'nginx' }), null);
  });
});
