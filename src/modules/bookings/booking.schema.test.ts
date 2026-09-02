import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBookingSchema } from './booking.schema.js';
import { isSlotInPast } from './booking.service.js';

const validBooking = {
  client_request_id: '9b1fdc28-6f51-48a0-97b3-e5316fbf749b',
  subtype_id: 'subtype-1',
  service_type_id: 'service-1',
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

test('past-slot checks use the requested timezone', () => {
  const now = new Date('2030-02-28T00:30:00.000Z');
  assert.equal(isSlotInPast('2030-02-28', '09:30', 'Asia/Seoul', now), true);
  assert.equal(isSlotInPast('2030-02-28', '09:31', 'Asia/Seoul', now), false);
  assert.equal(isSlotInPast('2030-02-27', '22:00', 'Asia/Seoul', now), true);
});
