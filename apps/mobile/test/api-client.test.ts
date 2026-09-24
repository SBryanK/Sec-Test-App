import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  ApiError,
  createRequester,
  normaliseServerUrl,
  shapeResponse,
} from '../src/api/core.ts';

/**
 * API client behaviour under failure.
 *
 * These guard a bug that was actively harmful: `request()` parsed the body
 * before checking `response.ok`, so a reverse proxy answering 502 with an HTML
 * page threw a SyntaxError that was reported as a *network* error with status 0.
 * The real HTTP status was lost — and since the auth provider cleared the stored
 * session on any failure, launching the app while the server was down deleted a
 * valid token from the Keychain.
 *
 * The suite drives `core.ts` rather than `client.ts` because the latter imports
 * `react-native`, whose Flow-typed entry point Node's test runner cannot parse.
 * Keeping the logic platform-free is what makes it testable at all.
 */

const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  const urlOf = (input: RequestInfo | URL): string => {
    if (input instanceof URL) return input.toString();
    return typeof input === 'string' ? input : input.url;
  };
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(urlOf(input), init));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A requester wired the way the app wires it, with a fixed token. */
function makeApi(baseUrl = 'http://server.test', token: string | null = 'test-token') {
  return createRequester({ getBaseUrl: () => baseUrl, getToken: () => token });
}

describe('error reporting', () => {
  it('preserves the HTTP status when the error body is not JSON', async () => {
    const api = makeApi();
    mockFetch(
      () =>
        new Response('<!doctype html><title>502 Bad Gateway</title>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );

    await assert.rejects(
      () => api.request('/api/history'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 502, 'the real status must survive a non-JSON body');
        assert.match(err.message, /502/);
        return true;
      },
    );
  });

  it('surfaces a structured error message when the body is JSON', async () => {
    const api = makeApi();
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'invalid_credentials', message: 'Invalid email or password' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await assert.rejects(
      () => api.request('/api/history'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'invalid_credentials');
        assert.equal(err.message, 'Invalid email or password');
        return true;
      },
    );
  });

  it('reports a transport failure as status 0, distinctly from an auth failure', async () => {
    const api = makeApi();
    mockFetch(() => {
      throw new Error('Network request failed');
    });

    await assert.rejects(
      () => api.request('/api/history'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // The distinction the auth provider depends on: 0 means "could not
        // reach the server", not "your credential is dead".
        assert.equal(err.status, 0);
        assert.equal(err.code, 'network_error');
        return true;
      },
    );
  });

  it('rejects a non-JSON success body rather than returning it as data', async () => {
    const api = makeApi();
    mockFetch(() => new Response('<html>not json</html>', { status: 200 }));

    await assert.rejects(
      () => api.request('/api/history'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 200);
        assert.equal(err.code, 'bad_response');
        return true;
      },
    );
  });

  it('sends the bearer token and JSON content type when a body is present', async () => {
    const api = makeApi();
    // Collected through a holder object: a bare `let` assigned inside a
    // callback is narrowed to its initial value by control-flow analysis, so
    // the assertion would not typecheck.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    });

    await api.request('/api/runs', { method: 'POST', body: { a: 1 } });
    assert.equal(calls.length, 1);
    const call = calls[0] ?? { url: '', init: undefined };
    assert.equal(call.url, 'http://server.test/api/runs');
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-token');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(call.init?.body, '{"a":1}');
  });

  it('omits the authorization header when there is no session', async () => {
    const api = makeApi('http://server.test', null);
    const seen: Array<Record<string, string>> = [];
    mockFetch((_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('{"ok":true}', { status: 200 });
    });

    await api.request('/api/discovery');
    assert.equal(seen[0]?.Authorization, undefined);
  });

  it('does not hang when the caller passes an already-aborted signal', async () => {
    const api = makeApi();
    mockFetch((_url, init) => {
      if (init?.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      return new Response('{}', { status: 200 });
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => api.request('/api/runs/x/traces', { signal: controller.signal }),
      (err: unknown) => err instanceof ApiError && err.code === 'timeout',
    );
  });

  it('still succeeds when the caller never aborts', async () => {
    const api = makeApi();
    mockFetch(() => new Response('{"value":7}', { status: 200 }));

    const controller = new AbortController();
    const result = await api.request<{ value: number }>('/api/anything', { signal: controller.signal });
    assert.equal(result.value, 7);
  });
});

describe('response shaping', () => {
  it('treats an empty body as an empty object rather than a parse failure', () => {
    assert.deepEqual(shapeResponse<Record<string, never>>({ status: 204, ok: true, text: '' }), {});
  });

  it('keeps the status on an empty error body', () => {
    assert.throws(
      () => shapeResponse({ status: 503, ok: false, text: '' }),
      (err: unknown) => err instanceof ApiError && err.status === 503,
    );
  });

  it('falls back to a generic code when the error body has no `error` field', () => {
    assert.throws(
      () => shapeResponse({ status: 429, ok: false, text: '{"message":"slow down"}' }),
      (err: unknown) => err instanceof ApiError && err.code === 'http_429' && err.message === 'slow down',
    );
  });

  it('truncates a long non-JSON error body so the message stays readable', () => {
    const body = 'x'.repeat(500);
    assert.throws(
      () => shapeResponse({ status: 502, ok: false, text: body }),
      (err: unknown) => err instanceof ApiError && err.message.length < 200,
    );
  });
});

describe('server address entry', () => {
  it('accepts what a colleague would actually type', () => {
    assert.equal(normaliseServerUrl('192.168.1.42'), 'http://192.168.1.42:8787');
    assert.equal(normaliseServerUrl('192.168.1.42:8787'), 'http://192.168.1.42:8787');
    assert.equal(normaliseServerUrl('  http://10.0.2.2:8787  '), 'http://10.0.2.2:8787');
    assert.equal(normaliseServerUrl('http://10.0.2.2:8787/'), 'http://10.0.2.2:8787');
  });

  it('strips a pasted API path back to the origin', () => {
    assert.equal(normaliseServerUrl('http://10.0.2.2:8787/api/health'), 'http://10.0.2.2:8787');
  });

  it('drops a pasted query string and fragment', () => {
    assert.equal(normaliseServerUrl('http://10.0.2.2:8787/api/health?x=1#y'), 'http://10.0.2.2:8787');
  });

  it('keeps an explicit https scheme', () => {
    assert.equal(normaliseServerUrl('https://edge.internal'), 'https://edge.internal:8787');
  });

  it('keeps an explicit non-default port', () => {
    assert.equal(normaliseServerUrl('https://edge.internal:8443'), 'https://edge.internal:8443');
  });

  it('refuses empty input with a readable message', () => {
    assert.throws(() => normaliseServerUrl('   '), /Enter your server address/);
  });

  it('refuses nonsense with the offending value in the message', () => {
    assert.throws(() => normaliseServerUrl('http://'), /not a valid address/);
  });
});

describe('server discovery', () => {
  it('describes a reachable server', async () => {
    const api = makeApi();
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            name: 'EdgeOne Security Test',
            version: '1.0.0',
            testCount: 12,
            addresses: ['http://192.168.1.42:8787'],
            reachedAt: 'http://192.168.1.42:8787',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const found = await api.probeServer('http://192.168.1.42:8787');
    assert.equal(found.testCount, 12);
    assert.equal(found.addresses.length, 1);
  });

  it('explains an unreachable address in terms a colleague can act on', async () => {
    const api = makeApi();
    mockFetch(() => {
      throw new Error('Network request failed');
    });

    await assert.rejects(() => api.probeServer('http://192.168.1.99:8787', 100), /same network/);
  });

  it('reports a non-OK discovery response with its status', async () => {
    const api = makeApi();
    mockFetch(() => new Response('nope', { status: 503 }));
    await assert.rejects(() => api.probeServer('http://server.test', 100), /HTTP 503/);
  });

  it('reports a non-JSON discovery body instead of returning it as data', async () => {
    const api = makeApi();
    mockFetch(() => new Response('<html>hello</html>', { status: 200 }));
    await assert.rejects(() => api.probeServer('http://server.test', 100), /non-JSON/);
  });
});
