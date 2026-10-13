import assert from 'node:assert/strict';
import test from 'node:test';
import { createFingerprint, stableStringify } from '../lib/canonical.js';
import { requireIdempotencyKey } from './idempotencyMiddleware.js';
import { HttpError } from '../core/errors.js';

test('fingerprints ignore object key order', () => {
  assert.equal(createFingerprint({ a: 1, b: 2 }), createFingerprint({ b: 2, a: 1 }));
});

test('fingerprints preserve array order', () => {
  assert.notEqual(createFingerprint({ values: [1, 2] }), createFingerprint({ values: [2, 1] }));
});

test('stableStringify canonicalizes nested objects', () => {
  assert.equal(
    stableStringify({ z: { b: true, a: null }, a: 'first' }),
    '{"a":"first","z":{"a":null,"b":true}}'
  );
});

test('booking middleware captures identity without side effects or finish handlers', async () => {
  const req: any = {
    header: () => '  booking-key  ', user: { id: 'owner' },
    method: 'POST', baseUrl: '/api/bookings', path: '/', body: { b: 2, a: 1 }
  };
  let continued = false;
  await requireIdempotencyKey(req, {} as never, () => { continued = true; });
  assert.equal(continued, true);
  assert.deepEqual(req.bookingRetry, {
    key: 'booking-key', scope: 'owner:POST:/api/bookings/', fingerprint: createFingerprint({ a: 1, b: 2 })
  });
  req.body = { normalized: true };
  assert.equal(req.bookingRetry.fingerprint, createFingerprint({ b: 2, a: 1 }));
});

test('booking middleware rejects missing/invalid keys and unauthenticated callers', async () => {
  for (const key of [undefined, '', 'short', 'x'.repeat(201)]) {
    await assert.rejects(
      requireIdempotencyKey({ header: () => key, user: { id: 'owner' } } as never, {} as never, () => assert.fail()),
      error => error instanceof HttpError && error.status === 400
    );
  }
  await assert.rejects(
    requireIdempotencyKey({ header: () => 'valid-key' } as never, {} as never, () => assert.fail()),
    error => error instanceof HttpError && error.status === 401
  );
});
