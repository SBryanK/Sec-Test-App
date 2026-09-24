import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { API_URL, apiReachable } from './helpers/fixture.ts';

/**
 * Operator access control ("the golden gate").
 *
 * Access is invitation-only: request → admin approves → sign in. These tests
 * exist because an earlier version enforced status and revocation inside a
 * helper that some routes never called, so the whole feature was cosmetic.
 * Enforcement now lives in the authentication hook, and this suite proves it
 * applies to every protected route rather than just the one that was tested.
 */

const ADMIN_EMAIL = process.env.SEED_USER_EMAIL ?? 'operator@example.com';
const ADMIN_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'edgeone';

const APPLICANT_EMAIL = `applicant-${Date.now()}@edgeone.internal`;
const APPLICANT_PASSWORD = 'an-applicant-passphrase-2026';

let up = false;
let adminToken = '';

interface Result<T> {
  status: number;
  body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  // Only declare a content type when there is actually a body to describe.
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? adminToken}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

async function signIn(email: string, password: string): Promise<{ status: number; token: string; body: Record<string, unknown> }> {
  const res = await call<{ token?: string; message?: string; error?: string }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    token: null,
  });
  return { status: res.status, token: res.body?.token ?? '', body: res.body };
}

/** Every route that must honour status and revocation. */
const PROTECTED_ROUTES = [
  '/api/auth/me',
  '/api/catalog',
  '/api/history',
  '/api/credits',
  '/api/runs/00000000-0000-4000-8000-000000000000',
];

before(async () => {
  up = await apiReachable();
  if (!up) {
    console.warn('\n  ⚠ API not reachable — skipping access-control tests.\n    Start with: ./ops/stack.sh\n');
    return;
  }
  const login = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  adminToken = login.token;
});

describe('registration', () => {
  it('accepts a request and reports it as pending', async () => {
    if (!up) return;
    const res = await call<{ status: string; message: string }>('/api/auth/register', {
      method: 'POST',
      token: null,
      body: {
        email: APPLICANT_EMAIL,
        displayName: 'Test Applicant',
        password: APPLICANT_PASSWORD,
        note: 'integration test',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'pending');
  });

  it('refuses a duplicate request without revealing account details', async () => {
    if (!up) return;
    const res = await call('/api/auth/register', {
      method: 'POST',
      token: null,
      body: { email: APPLICANT_EMAIL, displayName: 'Test Applicant', password: APPLICANT_PASSWORD },
    });
    assert.equal(res.status, 409);
  });

  it('rejects a weak password', async () => {
    if (!up) return;
    const res = await call<{ error: string }>('/api/auth/register', {
      method: 'POST',
      token: null,
      body: { email: `weak-${Date.now()}@x.test`, displayName: 'Weak', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'weak_password');
  });

  it('rejects a malformed email', async () => {
    if (!up) return;
    const res = await call('/api/auth/register', {
      method: 'POST',
      token: null,
      body: { email: 'not-an-email', displayName: 'X', password: APPLICANT_PASSWORD },
    });
    assert.equal(res.status, 400);
  });

  it('requires name, email and password', async () => {
    if (!up) return;
    const res = await call('/api/auth/register', { method: 'POST', token: null, body: {} });
    assert.equal(res.status, 400);
  });
});

describe('pending applicants cannot sign in', () => {
  it('refuses the sign-in and says why', async () => {
    if (!up) return;
    const res = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'pending_approval');
  });

  it('does not confirm the account exists to a wrong password', async () => {
    if (!up) return;
    // Status is only revealed after the password checks out, so an
    // unauthenticated caller cannot enumerate addresses.
    const res = await signIn(APPLICANT_EMAIL, 'definitely-the-wrong-password');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_credentials');
  });
});

describe('administration', () => {
  let applicantId = '';

  it('lists the pending request for an admin', async () => {
    if (!up) return;
    const res = await call<{ requests: Array<{ id: string; email: string; status: string }> }>(
      '/api/admin/requests',
    );
    assert.equal(res.status, 200, `admin/requests returned ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body.requests), 'response should carry a requests array');
    const found = res.body.requests.find((r) => r.email === APPLICANT_EMAIL);
    assert.ok(found, 'the pending request should be listed');
    assert.equal(found.status, 'pending');
    applicantId = found.id;
  });

  it('refuses admin routes to a non-admin', async () => {
    if (!up) return;
    // Create a second, approved, non-admin operator to test the boundary.
    const other = `operator-${Date.now()}@edgeone.internal`;
    await call('/api/auth/register', {
      method: 'POST',
      token: null,
      body: { email: other, displayName: 'Ordinary Operator', password: APPLICANT_PASSWORD },
    });
    const list = await call<{ requests: Array<{ id: string; email: string }> }>('/api/admin/requests');
    assert.equal(list.status, 200, `admin/requests returned ${list.status}: ${JSON.stringify(list.body)}`);
    const target = list.body.requests.find((r) => r.email === other);
    assert.ok(target, `expected a pending request for ${other}`);
    const approved = await call(`/api/admin/requests/${target.id}/approve`, { method: 'POST' });
    assert.equal(
      approved.status,
      200,
      `approve returned ${approved.status}: ${JSON.stringify(approved.body)}`,
    );

    const login = await signIn(other, APPLICANT_PASSWORD);
    assert.equal(
      login.status,
      200,
      `sign-in returned ${login.status}: ${JSON.stringify(login.body)}`,
    );

    const denied = await call('/api/admin/requests', { token: login.token });
    assert.equal(denied.status, 403, 'a non-admin must not reach admin routes');
  });

  it('approves the request', async () => {
    if (!up || !applicantId) return;
    const res = await call<{ approved: boolean }>(`/api/admin/requests/${applicantId}/approve`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.approved, true);
  });

  it('is idempotent-hostile: a second approval of the same id is a 404', async () => {
    if (!up || !applicantId) return;
    const res = await call(`/api/admin/requests/${applicantId}/approve`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('approved operators', () => {
  let applicantToken = '';

  it('can sign in, and receives a non-expiring token', async () => {
    if (!up) return;
    const res = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    assert.equal(res.status, 200);
    assert.ok(res.body.token, 'a token should be issued');
    assert.equal(res.body.expiresAt, 'never', 'JWT_EXPIRY defaults to never');
    applicantToken = res.token;
  });

  it('can use every protected route', async () => {
    if (!up) return;
    for (const route of PROTECTED_ROUTES) {
      const res = await call(route, { token: applicantToken });
      assert.notEqual(res.status, 401, `${route} rejected a valid token`);
      assert.notEqual(res.status, 403, `${route} refused an active operator`);
    }
  });

  it('loses access the moment tokens are revoked', async () => {
    if (!up) return;
    const me = await call<{ id: string }>('/api/auth/me', { token: applicantToken });
    const id = me.body.id;

    const revoked = await call<{ tokenVersion: number }>(`/api/admin/users/${id}/revoke`, {
      method: 'POST',
    });
    assert.equal(revoked.status, 200);

    // The important assertion: EVERY protected route must reject the old token,
    // not just the one that happens to call the user lookup.
    for (const route of PROTECTED_ROUTES) {
      const res = await call(route, { token: applicantToken });
      assert.equal(res.status, 401, `${route} still accepted a revoked token`);
    }
  });

  it('can sign in again after revocation', async () => {
    if (!up) return;
    const res = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    assert.equal(res.status, 200, 'revocation ends sessions, it does not lock the account');
  });
});

describe('suspension', () => {
  it('blocks an active token immediately and prevents re-login', async () => {
    if (!up) return;
    const login = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    const me = await call<{ id: string }>('/api/auth/me', { token: login.token });

    const suspended = await call(`/api/admin/users/${me.body.id}/suspend`, { method: 'POST' });
    assert.equal(suspended.status, 200);

    for (const route of PROTECTED_ROUTES) {
      const res = await call(route, { token: login.token });
      assert.equal(res.status, 403, `${route} still accepted a suspended operator`);
    }

    const blocked = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'account_suspended');

    // Restore for repeat runs.
    await call(`/api/admin/users/${me.body.id}/activate`, { method: 'POST' });
    const restored = await signIn(APPLICANT_EMAIL, APPLICANT_PASSWORD);
    assert.equal(restored.status, 200);
  });

  it('refuses to let an admin suspend themselves', async () => {
    if (!up) return;
    const me = await call<{ id: string }>('/api/auth/me');
    const res = await call(`/api/admin/users/${me.body.id}/suspend`, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  it('refuses to let an admin revoke their own tokens', async () => {
    if (!up) return;
    const me = await call<{ id: string }>('/api/auth/me');
    const res = await call(`/api/admin/users/${me.body.id}/revoke`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});

describe('unauthenticated access', () => {
  it('is refused everywhere', async () => {
    if (!up) return;
    for (const route of [...PROTECTED_ROUTES, '/api/admin/requests', '/api/admin/users']) {
      const res = await call(route, { token: null });
      assert.equal(res.status, 401, `${route} answered an unauthenticated caller`);
    }
  });

  it('rejects a garbage token', async () => {
    if (!up) return;
    const res = await call('/api/catalog', { token: 'not.a.real.token' });
    assert.equal(res.status, 401);
  });
});
