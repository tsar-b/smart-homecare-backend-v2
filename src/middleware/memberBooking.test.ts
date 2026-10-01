import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBookingMember } from './memberBooking.js';
test('member guard rejects unauthenticated requests and both legacy guest markers', () => {
  for (const user of [undefined, {isGuest:true,provider:'standard'}, {isGuest:false,provider:'guest'}]) {
    let called = false;
    assert.throws(() => requireBookingMember({user} as never, {} as never, () => { called = true; }));
    assert.equal(called, false);
  }
});
test('member guard permits all supported authenticated member providers', () => {
  for (const provider of ['standard','kakao','apple','google']) {
    let called = false;
    requireBookingMember({user:{isGuest:false,provider}} as never, {} as never, () => { called = true; });
    assert.equal(called, true);
  }
});
