import assert from 'node:assert/strict';
import test from 'node:test';
import type { User } from '@supabase/supabase-js';
import { env } from '../../core/env.js';
import { callbackUrl, enabledProviders, OAuthStartSchema, RecoveryFinishSchema,
  verifiedSocialIdentity, startRecovery, finishRecovery } from './browserAuth.js';

const redirectUri = 'smarthomecareapplication://auth/callback';
const state = 'a'.repeat(64);
const codeChallenge = 'b'.repeat(43);
function responseRecorder() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
}

test('OAuth opts in only to supported providers and validates PKCE inputs', () => {
  assert.deepEqual(enabledProviders(''), []);
  assert.deepEqual(enabledProviders('kakao,apple,google,google,other'), ['kakao', 'apple', 'google']);
  assert.equal(OAuthStartSchema.safeParse({ provider: 'google', redirectUri, state, codeChallenge }).success, true);
  assert.equal(OAuthStartSchema.safeParse({ provider: 'google', redirectUri, state, codeChallenge, email: 'forged@example.invalid' }).success, false);
  assert.equal(OAuthStartSchema.safeParse({ provider: 'google', redirectUri, state: 'short', codeChallenge }).success, false);
});

test('callbacks require an exact allowlisted return address and valid state', () => {
  assert.equal(new URL(callbackUrl(redirectUri, state, redirectUri)).searchParams.get('state'), state);
  for (const uri of [redirectUri + '/other', redirectUri + '?next=elsewhere', 'https://evil.invalid/auth/callback', 'javascript:alert(1)']) {
    assert.throws(() => callbackUrl(uri, state, redirectUri));
  }
  assert.throws(() => callbackUrl(redirectUri, 'invalid', redirectUri));
});

test('provider subjects come from Auth identities, not user metadata', () => {
  const user = { id: 'auth-user', user_metadata: { provider: 'google', sub: 'forged' }, identities: [] } as unknown as User;
  assert.throws(() => verifiedSocialIdentity(user, 'google'));
  user.identities = [{ id: 'identity', identity_id: 'identity', user_id: 'somebody-else', provider: 'google', identity_data: { sub: 'real' } }];
  assert.throws(() => verifiedSocialIdentity(user, 'google'));
  user.identities![0].user_id = user.id;
  assert.deepEqual(verifiedSocialIdentity(user, 'google'), { subject: 'real', email: null, emailVerified: false });
  assert.throws(() => verifiedSocialIdentity(user, 'apple'));
});

test('recovery does not disclose account absence or upstream details', async () => {
  const originalFetch = globalThis.fetch;
  const originalAllowlist = env.AUTH_REDIRECT_URLS;
  env.AUTH_REDIRECT_URLS = redirectUri;
  try {
    for (const status of [200, 400, 404]) {
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, 'POST');
        assert.equal(JSON.parse(init?.body as string).code_challenge_method, 's256');
        assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
        return new Response(JSON.stringify({ private_detail: 'must not be returned' }), { status });
      };
      const res = responseRecorder();
      await startRecovery({ body: { redirectUri, state, codeChallenge, email: 'person@example.invalid' } } as never, res as never);
      assert.equal(res.statusCode, 202);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    for (const status of [429, 500, 401, 403]) {
      globalThis.fetch = async () => new Response('{}', { status });
      await assert.rejects(() => startRecovery({ body: { redirectUri, state, codeChallenge, email: 'person@example.invalid' } } as never, responseRecorder() as never));
    }
  } finally { globalThis.fetch = originalFetch; env.AUTH_REDIRECT_URLS = originalAllowlist; }
});

test('password reset exchanges PKCE and uses the resulting user token, never admin reset', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) {
        assert.ok(String(url).endsWith('/auth/v1/token?grant_type=pkce'));
        assert.deepEqual(JSON.parse(init?.body as string), { auth_code: 'one-time-code', code_verifier: 'v'.repeat(64) });
        return Response.json({ access_token: 'test-user-token', refresh_token: 'test-refresh', expires_in: 3600, user: { id: 'test-user' } });
      }
      assert.ok(String(url).endsWith('/auth/v1/user'));
      assert.equal(init?.method, 'PUT');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-user-token');
      assert.deepEqual(JSON.parse(init?.body as string), { password: ' password123 ' });
      return Response.json({ id: 'test-user' });
    };
    const res = responseRecorder();
    await finishRecovery({ body: { code: 'one-time-code', codeVerifier: 'v'.repeat(64), password: ' password123 ' } } as never, res as never);
    assert.equal(calls.length, 2);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(RecoveryFinishSchema.safeParse({ code: 'code', codeVerifier: 'v'.repeat(64), password: 'weak' }).success, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('an invalid PKCE exchange never attempts a password update', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 400 }); };
    await assert.rejects(() => finishRecovery({ body: { code: 'expired', codeVerifier: 'v'.repeat(64), password: 'password123' } } as never, responseRecorder() as never));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
