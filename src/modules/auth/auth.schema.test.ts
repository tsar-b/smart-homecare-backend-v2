import assert from 'node:assert/strict';
import test from 'node:test';
import { RefreshSessionSchema } from './auth.schema.js';

test('refresh validation accepts current short opaque Supabase tokens', () => {
  assert.deepEqual(RefreshSessionSchema.parse({ refreshToken: 'abc123def456' }), {
    refresh_token: 'abc123def456'
  });
});

test('refresh validation normalizes snake-case tokens', () => {
  assert.deepEqual(RefreshSessionSchema.parse({ refresh_token: 'opaque-token' }), {
    refresh_token: 'opaque-token'
  });
});

test('refresh validation rejects missing tokens', () => {
  assert.equal(RefreshSessionSchema.safeParse({}).success, false);
});
