import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvSchema } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { deleteMe } from '../users/user.controller.js';
import { deleteKakaoAccount } from '../integrations/kakao/kakao.controller.js';
import { registerGuest, registrationProfileMetadata } from './auth.controller.js';
import { confirmationRequiredResponse } from './auth.service.js';

test('pending registration response contains no SHC profile or token', () => {
  assert.deepEqual(confirmationRequiredResponse(), {
    token: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    expiresIn: null,
    user: null,
    requiresEmailConfirmation: true
  });
});

test('confirmed-login profile metadata uses only allowlisted bounded strings', () => {
  assert.deepEqual(
    registrationProfileMetadata({
      name: '  Confirmed User  ',
      phone: '01012345678',
      address: 'Seoul',
      address_detail: 'Unit 3',
      is_admin: true,
      password: 'must-not-propagate'
    }),
    {
      name: 'Confirmed User',
      phone: '01012345678',
      address: 'Seoul',
      addressDetail: 'Unit 3'
    }
  );

  assert.equal(registrationProfileMetadata({ name: 'x'.repeat(121) }).name, undefined);
});

test('guest registration fails closed before issuing or linking a session', async () => {
  await assert.rejects(
    () => registerGuest({} as never, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'GUEST_VERIFICATION_REQUIRED');
      return true;
    }
  );
});

test('account deletion fails closed until complete erasure is available', async () => {
  await assert.rejects(
    () => deleteMe({} as never, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ACCOUNT_DELETION_UNAVAILABLE');
      return true;
    }
  );
});

test('Kakao account deletion fails closed before provider or storage side effects', async () => {
  await assert.rejects(
    () => deleteKakaoAccount({} as never, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ACCOUNT_DELETION_UNAVAILABLE');
      return true;
    }
  );
});

test('production environment rejects automatic email confirmation', () => {
  const parsed = EnvSchema.safeParse({
    NODE_ENV: 'production',
    AUTH_EMAIL_AUTO_CONFIRM: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test'
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.match(JSON.stringify(parsed.error.flatten()), /AUTH_EMAIL_AUTO_CONFIRM/);
  }
});

test('blank optional alternative keys normalize to undefined', () => {
  const parsed = EnvSchema.parse({
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: '  sb_publishable_test  ',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    SUPABASE_SERVICE_ROLE_KEY: '   ',
    KAKAO_REST_API_KEY: '',
    KAKAO_ADMIN_KEY: '  ',
    APPLE_CLIENT_IDS: ''
  });

  assert.equal(parsed.SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_test');
  assert.equal(parsed.SUPABASE_ANON_KEY, undefined);
  assert.equal(parsed.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(parsed.KAKAO_REST_API_KEY, undefined);
  assert.equal(parsed.KAKAO_ADMIN_KEY, undefined);
  assert.equal(parsed.APPLE_CLIENT_IDS, undefined);
  assert.equal(parsed.ENABLE_BOOKING_MEDIA_PILOT_UPLOADS, false);
});

test('booking media pilot uploads require an explicit environment opt-in', () => {
  const parsed = EnvSchema.parse({
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ENABLE_BOOKING_MEDIA_PILOT_UPLOADS: 'true'
  });

  assert.equal(parsed.ENABLE_BOOKING_MEDIA_PILOT_UPLOADS, true);
});

test('blank Supabase alternatives still fail required one-of validation', () => {
  const parsed = EnvSchema.safeParse({
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_ANON_KEY: ' ',
    SUPABASE_SECRET_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: ' '
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const error = JSON.stringify(parsed.error.flatten());
    assert.match(error, /SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required/);
    assert.match(error, /SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required/);
  }
});

test('public Supabase variables reject backend secrets and service-role JWTs', () => {
  const serviceRoleJwt = testJwt({ role: 'service_role' });
  const base = {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_backend_test'
  };

  for (const field of ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'] as const) {
    for (const publicKey of ['sb_secret_backend_test', serviceRoleJwt, 'not-a-publishable-key']) {
      const parsed = EnvSchema.safeParse({ ...base, [field]: publicKey });
      assert.equal(parsed.success, false, `${field}:${publicKey.slice(0, 16)}`);
      if (!parsed.success) {
        assert.match(JSON.stringify(parsed.error.flatten()), /never a backend key/);
      }
    }
  }
});

test('legacy anon-role JWT remains a valid public Supabase key', () => {
  const parsed = EnvSchema.parse({
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: testJwt({ role: 'anon' }),
    SUPABASE_SERVICE_ROLE_KEY: testJwt({ role: 'service_role' })
  });
  assert.equal(parsed.SUPABASE_PUBLISHABLE_KEY, undefined);
  assert.ok(parsed.SUPABASE_ANON_KEY);
});

test('public Supabase key cannot equal either configured backend key', () => {
  const duplicated = 'sb_publishable_accidentally_duplicated';
  for (const backendField of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
    const parsed = EnvSchema.safeParse({
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: duplicated,
      [backendField]: duplicated
    });
    assert.equal(parsed.success, false, backendField);
  }
});

function testJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.test-signature`;
}
