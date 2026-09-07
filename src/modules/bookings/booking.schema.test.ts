import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBookingSchema, LegacyCreateBookingSchema } from './booking.schema.js';
import { bookingQuoteInput } from './booking.controller.js';
import { isSlotInPast } from './booking.service.js';

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

test('past-slot checks use the requested timezone', () => {
  const now = new Date('2030-02-28T00:30:00.000Z');
  assert.equal(isSlotInPast('2030-02-28', '09:30', 'Asia/Seoul', now), true);
  assert.equal(isSlotInPast('2030-02-28', '09:31', 'Asia/Seoul', now), false);
  assert.equal(isSlotInPast('2030-02-27', '22:00', 'Asia/Seoul', now), true);
});
