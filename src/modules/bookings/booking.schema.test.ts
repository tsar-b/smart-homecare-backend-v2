import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AvailabilityQuerySchema, CreateBookingSchema, LegacyCreateBookingSchema } from './booking.schema.js';
import { bookingQuoteInput, createBooking, createLegacyBooking, getAvailableTimeSlots } from './booking.controller.js';
import { isSlotInPast } from './booking.service.js';
import { BOOKING_TIMEZONE, bookingDateTime } from './booking.time.js';
import { HttpError } from '../../core/errors.js';

const validBooking = {
  client_request_id: '9b1fdc28-6f51-48a0-97b3-e5316fbf749b',
  subtype_id: 'subtype-1',
  service_type_id: 'service-1',
  pricing_tier_id: 'pricing-1',
  reservation_date: '2030-02-28',
  reservation_time: '09:30'
};

test('booking validation accepts a canonical request', () => {
  const parsed = CreateBookingSchema.parse(validBooking);
  assert.equal(parsed.timezone, 'Asia/Seoul');
  assert.deepEqual(parsed.options, []);
});

test('booking validation rejects impossible calendar dates', () => {
  const parsed = CreateBookingSchema.safeParse({
    ...validBooking,
    reservation_date: '2030-02-31'
  });
  assert.equal(parsed.success, false);
});

test('booking validation rejects malformed times', () => {
  const parsed = CreateBookingSchema.safeParse({
    ...validBooking,
    reservation_time: '24:00'
  });
  assert.equal(parsed.success, false);
});

test('booking options require both an option ID and selected value', () => {
  const missingId = CreateBookingSchema.safeParse({
    ...validBooking,
    options: [{ value: 'yes' }]
  });
  const missingValue = CreateBookingSchema.safeParse({
    ...validBooking,
    options: [{ option_id: 'option-1' }]
  });

  assert.equal(missingId.success, false);
  assert.equal(missingValue.success, false);
});

test('booking validation rejects unknown timezones', () => {
  const parsed = CreateBookingSchema.safeParse({
    ...validBooking,
    timezone: 'Mars/Olympus_Mons'
  });
  assert.equal(parsed.success, false);
});

test('canonical booking validation requires every catalog ID', () => {
  for (const key of ['subtype_id', 'service_type_id', 'pricing_tier_id'] as const) {
    const input: Record<string, unknown> = { ...validBooking };
    delete input[key];
    assert.equal(CreateBookingSchema.safeParse(input).success, false, `${key} should be required`);
  }
});

test('canonical booking validation rejects client-controlled totals', () => {
  assert.equal(CreateBookingSchema.safeParse({ ...validBooking, total_price: 0 }).success, false);
});

test('legacy booking validation keeps isolated client-price compatibility', () => {
  const parsed = LegacyCreateBookingSchema.parse({
    client_request_id: validBooking.client_request_id,
    asset_id: validBooking.subtype_id,
    service_type: validBooking.service_type_id,
    reservation_date: validBooking.reservation_date,
    reservation_time: validBooking.reservation_time,
    total_price: 0
  });
  assert.equal(parsed.total_price, 0);
});

test('canonical quote input cannot forward legacy price or tier aliases', () => {
  const input = bookingQuoteInput(
    {
      ...validBooking,
      asset_id: 'legacy-subtype',
      service_type: 'legacy-service',
      tier: 'legacy-tier',
      total_price: 0
    },
    false
  );

  assert.equal(input.subtypeReference, validBooking.subtype_id);
  assert.equal(input.serviceTypeReference, validBooking.service_type_id);
  assert.equal(input.pricingTierId, validBooking.pricing_tier_id);
  assert.equal(input.tier, undefined);
  assert.equal(input.legacyTotalPrice, undefined);
});

test('legacy quote input alone can forward client price compatibility', () => {
  const input = bookingQuoteInput(
    {
      asset_id: 'legacy-subtype',
      service_type: 'legacy-service',
      tier: 'legacy-tier',
      total_price: 0,
      options: []
    },
    true
  );

  assert.equal(input.subtypeReference, 'legacy-subtype');
  assert.equal(input.serviceTypeReference, 'legacy-service');
  assert.equal(input.tier, 'legacy-tier');
  assert.equal(input.legacyTotalPrice, 0);
});

test('past-slot checks use the server business timezone', () => {
  const now = new Date('2030-02-28T00:30:00.000Z');
  assert.equal(isSlotInPast('2030-02-28', '09:30', now), true);
  assert.equal(isSlotInPast('2030-02-28', '09:31', now), false);
  assert.equal(isSlotInPast('2030-02-27', '22:00', now), true);
});

test('canonical and legacy timezone fields normalize without converting slot values', () => {
  for (const schema of [CreateBookingSchema, LegacyCreateBookingSchema]) {
    for (const timezone of [undefined, 'Asia/Seoul', 'UTC', 'America/New_York', 'Pacific/Honolulu']) {
      const parsed = schema.parse({ ...validBooking, timezone });
      assert.equal(parsed.timezone, BOOKING_TIMEZONE);
      assert.equal(parsed.reservation_date, validBooking.reservation_date);
      assert.equal(parsed.reservation_time, validBooking.reservation_time);
    }
  }
});

test('timezone normalization does not hide malformed canonical or legacy input', () => {
  for (const schema of [CreateBookingSchema, LegacyCreateBookingSchema]) {
    for (const timezone of [null, '', 'Mars/Olympus_Mons', 9, {}, 'x'.repeat(81)]) {
      assert.equal(schema.safeParse({ ...validBooking, timezone }).success, false);
    }
  }
});

test('the reported UTC bypass is past under the server-owned booking clock', () => {
  const now = new Date('2026-10-09T06:00:00.000Z');
  const parsed = CreateBookingSchema.parse({
    ...validBooking, reservation_date: '2026-10-09', reservation_time: '10:00', timezone: 'UTC'
  });
  assert.equal(parsed.timezone, BOOKING_TIMEZONE);
  assert.equal(isSlotInPast(parsed.reservation_date, parsed.reservation_time, now), true);
});

test('business clock handles Seoul midnight, leap day and year boundaries', () => {
  const cases = [
    ['2026-10-08T14:59:59.999Z', '2026-10-08', '23:59'],
    ['2026-10-08T15:00:00.000Z', '2026-10-09', '00:00'],
    ['2028-02-28T15:00:00.000Z', '2028-02-29', '00:00'],
    ['2026-12-31T15:00:00.000Z', '2027-01-01', '00:00']
  ];
  for (const [instant, date, time] of cases) {
    const now = new Date(instant);
    assert.deepEqual(bookingDateTime(now), { date, time });
    assert.equal(isSlotInPast(date, time, now), true, 'the current business minute is not bookable');
  }
  const midnight = new Date('2026-10-08T15:00:00.000Z');
  assert.equal(isSlotInPast('2026-10-08', '23:59', midnight), true);
  assert.equal(isSlotInPast('2026-10-09', '00:01', midnight), false);
});

test('foreign daylight-saving changes do not move Seoul booking times', () => {
  for (const [instant, time] of [
    ['2026-03-08T06:59:00Z', '15:59'], ['2026-03-08T07:00:00Z', '16:00'],
    ['2026-11-01T05:59:00Z', '14:59'], ['2026-11-01T06:00:00Z', '15:00']
  ]) {
    assert.equal(bookingDateTime(new Date(instant)).time, time);
  }
});

test('availability defaults to the same business date across UTC midnight offset', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T15:00:00Z') });
  assert.equal(AvailabilityQuerySchema.parse({}).date, '2027-01-01');
  assert.equal(AvailabilityQuerySchema.parse({ date: '2027-01-02' }).date, '2027-01-02');
});

for (const [name, create] of [['canonical', createBooking], ['legacy', createLegacyBooking]] as const) {
  test(`${name} controller rejects the UTC past-slot bypass before inserting`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:00:00Z') });
    const inserted = mockBookingDatabase(t);
    await assert.rejects(
      () => create(bookingRequest('10:00') as never, responseRecorder() as never),
      error => error instanceof HttpError && error.status === 409 && error.code === 'BOOKING_SLOT_IN_PAST'
    );
    assert.equal(inserted.length, 0);
  });

  test(`${name} controller stores business timezone even without schema normalization`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:00:00Z') });
    const inserted = mockBookingDatabase(t);
    const res = responseRecorder();
    await create(bookingRequest('15:01') as never, res as never);
    assert.equal(res.statusCode, 201);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].timezone, BOOKING_TIMEZONE);
    assert.equal(inserted[0].reservation_date, '2026-10-09');
    assert.equal(inserted[0].reservation_time, '15:01');
    assert.equal(inserted[0].total_price, 50000);
    assert.equal((res.body as Record<string, unknown>).timezone, BOOKING_TIMEZONE);
  });
}

test('availability and creation agree at past, current and next business minute', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:00:00Z') });
  const inserted = mockBookingDatabase(t);
  const res = responseRecorder();
  await getAvailableTimeSlots({ query: { date: '2026-10-09' } } as never, res as never);
  assert.deepEqual(res.body, [
    { time: '10:00', available: false }, { time: '15:00', available: false }, { time: '15:01', available: true }
  ]);
  for (const slot of res.body as Array<{ time: string; available: boolean }>) {
    if (slot.available) {
      await createBooking(bookingRequest(slot.time) as never, responseRecorder() as never);
    } else {
      await assert.rejects(
        () => createBooking(bookingRequest(slot.time) as never, responseRecorder() as never),
        error => error instanceof HttpError && error.code === 'BOOKING_SLOT_IN_PAST'
      );
    }
  }
  assert.equal(inserted.length, 1);
});

function bookingRequest(time: string) {
  return {
    body: { ...validBooking, reservation_date: '2026-10-09', reservation_time: time, timezone: 'UTC', options: [] },
    user: { id: 'test-owner' },
    bookingRetry: { key: validBooking.client_request_id, scope: 'test-owner:POST:/api/bookings/', fingerprint: 'a'.repeat(64) }
  };
}

function responseRecorder() {
  return {
    statusCode: 200, body: undefined as unknown,
    status(value: number) { this.statusCode = value; return this; },
    json(value: unknown) { this.body = value; return this; }
  };
}

// Exercise the actual controller and installed SDK with in-memory HTTP replies.
// No server is started, and every unexpected outbound request fails the test.
function mockBookingDatabase(t: TestContext) {
  const inserted: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(url.pathname.startsWith('/rest/v1/'));
    const table = url.pathname.split('/').at(-1);
    if (table === 'users') return Response.json({ name: 'QA', is_guest: false });
    if (table === 'subtypes') return Response.json([{ id: 'subtype-1', key: 'subtype', label: 'Subtype' }]);
    if (table === 'service_types') return Response.json([{ id: 'service-1', key: 'service', label: 'Service' }]);
    if (table === 'pricing_tiers') return Response.json([{ id: 'pricing-1', key: 'standard', label: 'Standard', base_price: 50000 }]);
    if (table === 'timeslots') return Response.json([{ date: null, type: 'generic', slots: ['10:00', '15:00', '15:01'] }]);
    if (table === 'lookup_booking_submission') return Response.json({ outcome: 'missing' });
    if (table === 'commit_booking_submission') {
      const payload = JSON.parse(String(init?.body)).p_booking as Record<string, unknown>;
      inserted.push(payload);
      return Response.json({ outcome: 'created', booking: { id: 'test-booking', ...payload } });
    }
    if (table === 'bookings') return Response.json([]);
    assert.fail(`Unexpected mocked database resource: ${table}`);
  });
  return inserted;
}
