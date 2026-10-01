import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { HttpError } from '../../core/errors.js';
import { login } from './auth.controller.js';

// Exercise the real controller and installed Auth SDK, without real accounts,
// network requests, password changes, or a shared database.
function harness(t: TestContext, payload: unknown, status = 200) {
  const requests: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    assert.ok(String(url).includes('/auth/v1/token?grant_type=password'));
    return Response.json(payload, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
  });
  let profile: any = null;
  let databaseError: any = null;
  let reads = 0;
  let writes = 0;
  t.mock.method(supabaseAdmin, 'from', () => {
    const query: any = {
      select: () => query, eq: () => query, ilike: () => query,
      maybeSingle: async () => { reads++; return { data: profile, error: databaseError }; },
      update: () => { writes++; throw new Error('Unexpected database write'); },
    };
    return query;
  });
  t.mock.method(supabaseAdmin.auth.admin, 'updateUserById', async () => {
    writes++;
    throw new Error('Unexpected password overwrite');
  });
  let body: any;
  const run = (password = ' password123 ') => login(
    { body: { email: '  Member@Example.com ', password } } as never,
    { json: (value: unknown) => { body = value; } } as never,
  );
  return { run, requests, setProfile: (value: unknown) => { profile = value; },
    setDatabaseError: () => { databaseError = { message: 'private database detail' }; },
    get body() { return body; }, get reads() { return reads; }, get writes() { return writes; } };
}

function hasError(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private upstream|private database/);
    return true;
  };
}

for (const [upstreamStatus, upstreamCode, status, code] of [
  [400, 'email_not_confirmed', 403, 'EMAIL_CONFIRMATION_REQUIRED'],
  [429, 'over_request_rate_limit', 429, 'AUTH_RATE_LIMITED'],
  [403, 'user_banned', 403, 'ACCOUNT_UNAVAILABLE'],
  [400, 'email_provider_disabled', 503, 'EMAIL_LOGIN_UNAVAILABLE'],
  [500, 'unexpected_failure', 503, 'AUTH_SERVICE_UNAVAILABLE'],
] as const) {
  test(`standard login preserves ${upstreamCode} without legacy migration`, async t => {
    const h = harness(t, { code: upstreamCode, msg: 'private upstream detail' }, upstreamStatus);
    await assert.rejects(h.run(), hasError(status, code));
    assert.equal(h.reads, 0);
    assert.equal(h.writes, 0);
    assert.equal(h.requests.length, 1);
  });
}

test('incorrect standard credentials remain a generic 401', async t => {
  const h = harness(t, { code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
  await assert.rejects(h.run(), hasError(401, 'INVALID_LOGIN'));
  assert.equal(h.writes, 0);
});

test('legacy lookup outage is not reported as an incorrect password', async t => {
  const h = harness(t, { code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
  h.setDatabaseError();
  await assert.rejects(h.run(), hasError(503, 'AUTH_SERVICE_UNAVAILABLE'));
});

test('a stale legacy hash cannot overwrite an already linked Supabase password', async t => {
  const h = harness(t, { code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
  h.setProfile({ id: 'profile-id', auth_user_id: 'linked-auth-id', password_hash: bcrypt.hashSync('old-password123', 4) });
  await assert.rejects(h.run('old-password123'), hasError(401, 'INVALID_LOGIN'));
  assert.equal(h.writes, 0);
});

test('confirmed standard login returns the existing profile and refreshable session', async t => {
  const authUser = { id: 'auth-id', email: 'member@example.com', email_confirmed_at: '2026-01-01T00:00:00Z',
    user_metadata: { is_admin: true } };
  const h = harness(t, { access_token: 'test-access-token', refresh_token: 'test-refresh-token',
    expires_in: 3600, token_type: 'bearer', user: authUser });
  h.setProfile({ id: 'profile-id', auth_user_id: 'auth-id', name: 'Member', email: authUser.email,
    provider: 'standard', is_admin: false, is_guest: false, email_verified: true });
  await h.run();
  assert.equal(h.requests[0].body.email, 'member@example.com');
  assert.equal(h.requests[0].body.password, ' password123 ');
  assert.equal(h.body.accessToken, 'test-access-token');
  assert.equal(h.body.refreshToken, 'test-refresh-token');
  assert.equal(h.body.user.id, 'profile-id');
  assert.equal(h.body.user.isAdmin, false);
  assert.equal(h.body.requiresEmailConfirmation, false);
  assert.equal(h.writes, 0);
});

test('an incomplete Auth response fails safely without legacy migration', async t => {
  const h = harness(t, { user: { id: 'auth-id' } });
  await assert.rejects(h.run(), hasError(503, 'AUTH_SERVICE_UNAVAILABLE'));
  assert.equal(h.reads, 0);
  assert.equal(h.writes, 0);
});

test('a genuine unlinked V1 password still migrates once and returns the member session', async t => {
  const legacy = { id: 'profile-id', auth_user_id: null, name: 'Legacy Member',
    email: 'member@example.com', password_hash: bcrypt.hashSync('old-password123', 4) };
  const profile = { ...legacy, auth_user_id: 'new-auth-id', provider: 'standard',
    email_verified: true, is_admin: false, is_guest: false };
  let attempts = 0;
  let created = 0;
  let linked = 0;
  let cleared = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).includes('/auth/v1/token?grant_type=password'));
    if (++attempts === 1) return Response.json({ code: 'invalid_credentials' },
      { status: 400, headers: { 'x-supabase-api-version': '2024-01-01' } });
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
      token_type: 'bearer', user: { id: 'new-auth-id', email_confirmed_at: '2026-01-01T00:00:00Z' } });
  });
  t.mock.method(supabaseAdmin, 'from', () => {
    let columns = '';
    const query: any = {
      select: (value: string) => { columns = value; return query; },
      ilike: () => query, eq: () => query,
      maybeSingle: async () => ({ data: columns.includes('password_hash') ? legacy : profile, error: null }),
      update: (value: unknown) => { assert.deepEqual(value, { password_hash: null }); cleared++; return query; },
    };
    return query;
  });
  t.mock.method(supabaseAdmin.auth.admin, 'createUser', async (input: any) => {
    assert.equal(input.password, 'old-password123');
    assert.equal(input.email, legacy.email);
    created++;
    return { data: { user: { id: 'new-auth-id' } }, error: null } as any;
  });
  t.mock.method(supabaseAdmin.auth.admin, 'updateUserById', async () => { throw new Error('Must not overwrite an existing user'); });
  t.mock.method(supabaseAdmin.auth.admin, 'deleteUser', async () => { throw new Error('Must not delete an existing user'); });
  t.mock.method(supabaseAdmin, 'rpc', (_name: string, input: any) => {
    assert.equal(input.p_auth_user_id, 'new-auth-id');
    assert.equal(input.p_provider, 'standard');
    linked++;
    return { single: async () => ({ data: { profile_id: profile.id, was_created: false }, error: null }) } as any;
  });
  let body: any;
  await login({ body: { email: legacy.email, password: 'old-password123' } } as never,
    { json: (value: unknown) => { body = value; } } as never);
  assert.equal(body.user.id, legacy.id);
  assert.equal(body.refreshToken, 'test-refresh');
  assert.deepEqual({ attempts, created, linked, cleared }, { attempts: 2, created: 1, linked: 1, cleared: 1 });
});
