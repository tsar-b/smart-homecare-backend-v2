import assert from 'node:assert/strict';
import test from 'node:test';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { HttpError } from '../../core/errors.js';
import { createBooking, createLegacyBooking } from './booking.controller.js';
import { readBookingReplay, commitBooking } from './booking.retry.js';

const request: any = {
  user: { id: 'owner' }, body: { client_request_id: 'ce3e08c6-4719-4a89-aa06-a72c00c2f546', reservation_date: '2000-01-01' },
  bookingRetry: { key: 'retry-key', scope: 'owner:POST:/api/bookings/', fingerprint: 'a'.repeat(64) }
};
const saved = { id: 'saved-booking', user_id: 'owner', client_request_id: request.body.client_request_id,
  reservation_date: '2000-01-01', total_price: 50000, status: '대기', options: [] };
function response() {
  return { code: 200, body: undefined as any, headers: {} as Record<string, string>,
    status(value: number) { this.code = value; return this; },
    json(value: unknown) { this.body = value; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; } };
}

for (const [name, controller] of [['canonical', createBooking], ['legacy', createLegacyBooking]] as const) {
  test(`${name} replays before past-slot/catalog checks, without inserting or finalizing again`, async t => {
    t.mock.method(supabaseAdmin, 'from', () => assert.fail('replay must not query changing profile/catalog/slots'));
    t.mock.method(supabaseAdmin, 'rpc', async (name: string, args: any) => {
      assert.equal(name, 'lookup_booking_submission');
      assert.equal(args.p_user_id, 'owner');
      assert.equal(args.p_fingerprint, request.bookingRetry.fingerprint);
      return { data: { outcome: 'replay', booking: saved }, error: null } as never;
    });
    const res = response();
    await controller(request, res as never);
    assert.equal(res.code, 201);
    assert.equal(res.body.id, saved.id);
    assert.equal(res.body.totalPrice, 50000);
    assert.equal(res.headers['Idempotency-Replayed'], 'true');
  });
}

test('missing migration/unavailable lookup fails closed, never falling back to INSERT', async t => {
  t.mock.method(supabaseAdmin, 'from', () => assert.fail('must fail closed'));
  t.mock.method(supabaseAdmin, 'rpc', async () => ({ data: null, error: { code: 'PGRST202' } }) as never);
  await assert.rejects(createBooking(request, response() as never),
    error => error instanceof HttpError && error.status === 503 && error.code === 'IDEMPOTENCY_STORE_UNAVAILABLE');
});

test('a lost commit response is recovered by the identical later lookup', async t => {
  let committed = false;
  t.mock.method(supabaseAdmin, 'rpc', async (name: string) => {
    if (name === 'commit_booking_submission') {
      committed = true;
      return { data: null, error: { message: 'simulated transport lost after commit' } } as never;
    }
    assert.equal(committed, true);
    return { data: { outcome: 'replay', booking: saved }, error: null } as never;
  });
  await assert.rejects(commitBooking(request, response() as never, {}),
    error => error instanceof HttpError && error.status === 503);
  assert.deepEqual(await readBookingReplay(request), saved);
});

test('atomic commit race returns replay header and original result', async t => {
  t.mock.method(supabaseAdmin, 'rpc', async (name: string, args: any) => {
    assert.equal(name, 'commit_booking_submission');
    assert.equal(args.p_booking.total_price, 70000);
    return { data: { outcome: 'replay', booking: saved }, error: null } as never;
  });
  const res = response();
  assert.deepEqual(await commitBooking(request, res as never, { total_price: 70000 }), saved);
  assert.equal(res.headers['Idempotency-Replayed'], 'true');
});

for (const [outcome, code] of [['conflict', 'IDEMPOTENCY_CONFLICT'], ['review_required', 'BOOKING_RETRY_REVIEW_REQUIRED'], ['past', 'BOOKING_SLOT_IN_PAST']]) {
  test(`atomic commit maps ${outcome} without inventing success`, async t => {
    t.mock.method(supabaseAdmin, 'rpc', async () => ({ data: { outcome }, error: null }) as never);
    await assert.rejects(commitBooking(request, response() as never, {}),
      error => error instanceof HttpError && error.status === 409 && error.code === code);
  });
}

test('slot uniqueness and unproven pre-upgrade duplicates remain distinct failures', async t => {
  for (const [message, expected] of [['bookings_unique_active_slot_idx', 'BOOKING_SLOT_UNAVAILABLE'],
    ['bookings_user_client_request_unique_idx', 'BOOKING_RETRY_REVIEW_REQUIRED']]) {
    const rpc = t.mock.method(supabaseAdmin, 'rpc', async () => ({ data: null, error: { code: '23505', message } }) as never);
    await assert.rejects(commitBooking(request, response() as never, {}),
      error => error instanceof HttpError && error.code === expected);
    rpc.mock.restore();
  }
});

test('malformed RPC successes cannot be treated as committed bookings', async t => {
  for (const data of [null, [], {}, { outcome: 'replay' }, { outcome: 'created', booking: {} }]) {
    const rpc = t.mock.method(supabaseAdmin, 'rpc', async () => ({ data, error: null }) as never);
    await assert.rejects(commitBooking(request, response() as never, {}),
      error => error instanceof HttpError && error.status === 503);
    rpc.mock.restore();
  }
});
