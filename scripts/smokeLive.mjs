import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const apiUrl = String(process.env.SMOKE_API_URL ?? process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:5050').replace(/\/$/, '');
const supabaseUrl = required('SUPABASE_URL');
const adminKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
if (!adminKey) throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required');
if (!publicKey) throw new Error('SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY is required');

const supabase = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});
const publicSupabase = createClient(supabaseUrl, publicKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});
const runId = randomUUID();
const email = `shc-smoke-${runId}@example.com`;
const phone = `010${randomInt(10_000_000, 99_999_999)}`;
const guestPhone = `011${randomInt(10_000_000, 99_999_999)}`;
const password = `Smoke-${randomUUID()}-Aa1!`;
const testDate = futureDate(3_650 + randomInt(1, 1_000));
const primaryClientRequestId = randomUUID();
const concurrentClientRequestIds = Array.from({ length: 8 }, () => randomUUID());
const invalidSlotClientRequestId = randomUUID();
const pastSlotClientRequestId = randomUUID();
const cleanupProfileIds = new Set();
const cleanupAuthUserIds = new Set();

try {
  const health = await api('/health');
  expectStatus(health, 200, 'health');
  assert.equal(health.body.ok, true);
  pass('process health');

  const ready = await api('/ready');
  expectStatus(ready, 200, 'readiness');
  assert.equal(ready.body.dependencies.supabaseAuth, true);
  assert.equal(ready.body.dependencies.supabaseDatabase, true);
  pass('Supabase Auth and database readiness');

  const [publicUsers, publicBookings] = await Promise.all([
    publicSupabase.from('users').select('id'),
    publicSupabase.from('bookings').select('id')
  ]);
  assert.equal(publicUsers.error, null);
  assert.equal(publicBookings.error, null);
  assert.deepEqual(publicUsers.data, []);
  assert.deepEqual(publicBookings.data, []);
  pass('RLS blocks public profile and booking reads');

  const initialize = await api('/api/app/initialize');
  expectStatus(initialize, 200, 'app initialization');
  assert.ok(initialize.body.catalog.serviceTypes.length >= 4);
  assert.ok(initialize.body.catalog.subtypes.length >= 6);
  assert.ok(initialize.body.timeSlots[0].slots.length >= 30);
  pass('migrated catalog initialization');

  const anonymousHistory = await api('/api/bookings/history');
  expectStatus(anonymousHistory, 401, 'anonymous booking history');
  assert.equal(anonymousHistory.body.code, 'NO_TOKEN');
  pass('protected route rejection');

  const registration = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'SHC Smoke User',
      phone,
      email,
      password,
      address: 'Seoul smoke-test address',
      addressDetail: 'Unit 2'
    }
  });
  expectStatus(registration, 201, 'registration');
  assert.ok(registration.body.accessToken, 'Registration returned no session. Use AUTH_EMAIL_AUTO_CONFIRM=true in a test environment.');
  assert.ok(registration.body.refreshToken);
  let accessToken = registration.body.accessToken;
  const profileId = registration.body.user.id;
  cleanupProfileIds.add(profileId);
  const authUser = await authUserForToken(accessToken);
  cleanupAuthUserIds.add(authUser.id);
  pass('Supabase Auth registration and profile linkage');

  const me = await api('/api/users/me', { token: accessToken });
  expectStatus(me, 200, 'current profile');
  assert.equal(me.body.email, email);
  assert.equal(me.body.id, profileId);
  pass('authenticated profile lookup');

  const emailLogin = await api('/api/login', {
    method: 'POST',
    body: { email, password }
  });
  expectStatus(emailLogin, 200, 'legacy-compatible email login');
  assert.equal(emailLogin.body.user.id, profileId);
  accessToken = emailLogin.body.accessToken;
  pass('email login and legacy route alias');

  const forbiddenAdmin = await api('/api/admin/users', { token: accessToken });
  expectStatus(forbiddenAdmin, 403, 'non-admin access');
  pass('admin authorization boundary');

  const refresh = await api('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: emailLogin.body.refreshToken }
  });
  expectStatus(refresh, 200, 'token refresh');
  accessToken = refresh.body.accessToken;
  assert.ok(accessToken);
  pass('refresh-token rotation');

  const profileUpdate = await api('/api/users/me', {
    method: 'PATCH',
    token: accessToken,
    body: { addressDetail: 'Unit 2, updated' }
  });
  expectStatus(profileUpdate, 200, 'profile update');
  assert.equal(profileUpdate.body.addressDetail, 'Unit 2, updated');
  pass('profile update');

  const availability = await api(`/api/bookings/availability?date=${testDate}`);
  expectStatus(availability, 200, 'availability');
  assert.ok(availability.body.some((slot) => slot.time === '21:30' && slot.available));
  pass('availability calculation');

  const invalidSlot = await api('/api/bookings', {
    method: 'POST',
    token: accessToken,
    headers: { 'Idempotency-Key': invalidSlotClientRequestId },
    body: bookingPayload(invalidSlotClientRequestId, testDate, '23:59', false)
  });
  expectStatus(invalidSlot, 400, 'unconfigured slot rejection');
  assert.equal(invalidSlot.body.code, 'BOOKING_SLOT_NOT_CONFIGURED');

  const pastDate = futureDate(-1);
  const pastSlot = await api('/api/bookings', {
    method: 'POST',
    token: accessToken,
    headers: { 'Idempotency-Key': pastSlotClientRequestId },
    body: bookingPayload(pastSlotClientRequestId, pastDate, '06:00', false)
  });
  expectStatus(pastSlot, 409, 'past slot rejection');
  assert.equal(pastSlot.body.code, 'BOOKING_SLOT_IN_PAST');
  pass('invalid and past slot rejection');

  const primaryBookingPayload = bookingPayload(primaryClientRequestId, testDate, '21:30', true);
  const firstBooking = await api('/api/bookings', {
    method: 'POST',
    token: accessToken,
    headers: { 'Idempotency-Key': primaryClientRequestId },
    body: primaryBookingPayload
  });
  expectStatus(firstBooking, 201, 'booking creation');
  assert.equal(firstBooking.body.totalPrice, 60_000);
  assert.equal(firstBooking.body.price_source, 'catalog');
  assert.equal(firstBooking.body.options[0].extraCost, 20_000);
  pass('server-priced booking creation');

  await delay(150);
  const replay = await api('/api/bookings', {
    method: 'POST',
    token: accessToken,
    headers: { 'Idempotency-Key': primaryClientRequestId },
    body: primaryBookingPayload
  });
  expectStatus(replay, 201, 'booking replay');
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.body.id, firstBooking.body.id);
  pass('idempotent response replay');

  const contenders = await Promise.all(
    concurrentClientRequestIds.map((clientRequestId) =>
      api('/api/bookings', {
        method: 'POST',
        token: accessToken,
        headers: { 'Idempotency-Key': clientRequestId },
        body: bookingPayload(clientRequestId, testDate, '22:00', false)
      })
    )
  );
  const winners = contenders.filter((response) => response.status === 201);
  const rejected = contenders.filter(
    (response) => response.status === 409 && response.body.code === 'BOOKING_SLOT_UNAVAILABLE'
  );
  assert.equal(winners.length, 1, `Expected one booking winner, received ${winners.length}`);
  assert.equal(rejected.length, contenders.length - 1, 'Every losing concurrent booking must be rejected as unavailable');
  pass('concurrent duplicate-slot rejection');

  const history = await api('/api/bookings/history', { token: accessToken });
  expectStatus(history, 200, 'booking history');
  assert.equal(history.body.length, 2);
  pass('booking history');

  const detail = await api(`/api/bookings/${firstBooking.body.id}`, { token: accessToken });
  expectStatus(detail, 200, 'booking detail');
  assert.equal(detail.body.serviceLabel, '세척');
  pass('booking ownership and detail');

  const { error: elevationError } = await supabase.from('users').update({ is_admin: true }).eq('id', profileId);
  if (elevationError) throw elevationError;

  const adminUsers = await api('/api/admin/users', { token: accessToken });
  expectStatus(adminUsers, 200, 'admin users');
  assert.ok(adminUsers.body.some((user) => user.id === profileId && user.isAdmin));

  const adminBookings = await api('/api/admin/bookings/filter', {
    method: 'POST',
    token: accessToken,
    body: { start: testDate, end: testDate }
  });
  expectStatus(adminBookings, 200, 'admin booking filter');
  assert.equal(adminBookings.body.filter((booking) => booking.user_id === profileId).length, 2);

  const adminUpdate = await api(`/api/admin/bookings/${winners[0].body.id}/status`, {
    method: 'PATCH',
    token: accessToken,
    body: { status: '확정' }
  });
  expectStatus(adminUpdate, 200, 'admin booking update');
  assert.equal(adminUpdate.body.status, '확정');
  pass('admin user, filter, and booking operations');

  const categoryKey = `smoke-${runId}`;
  const adminCreate = await api('/api/admin/data/categories', {
    method: 'POST',
    token: accessToken,
    body: { key: categoryKey, label: 'Smoke category', sort_order: 9_999, metadata: { smoke: true } }
  });
  expectStatus(adminCreate, 201, 'generic admin create');

  const adminCatalogList = await api('/api/admin/data/categories?page=1&pageSize=100&sort=sort_order&direction=desc', {
    token: accessToken
  });
  expectStatus(adminCatalogList, 200, 'generic admin list');
  assert.ok(adminCatalogList.body.data.some((row) => row.id === adminCreate.body.id));

  const adminPatch = await api(`/api/admin/data/categories/${adminCreate.body.id}`, {
    method: 'PATCH',
    token: accessToken,
    body: { label: 'Smoke category updated' }
  });
  expectStatus(adminPatch, 200, 'generic admin update');
  assert.equal(adminPatch.body.label, 'Smoke category updated');

  const adminDelete = await api(`/api/admin/data/categories/${adminCreate.body.id}`, {
    method: 'DELETE',
    token: accessToken
  });
  expectStatus(adminDelete, 200, 'generic admin delete');
  pass('allowlisted admin catalog CRUD');

  const cancellation = await api(`/api/bookings/${firstBooking.body.id}/cancel`, {
    method: 'PATCH',
    token: accessToken
  });
  expectStatus(cancellation, 200, 'booking cancellation');
  assert.equal(cancellation.body.status, '취소');
  pass('user booking cancellation');

  const guest = await api('/api/auth/guest', {
    method: 'POST',
    body: {
      name: 'SHC Smoke Guest',
      phone: guestPhone,
      address: 'Seoul guest smoke-test address'
    }
  });
  expectStatus(guest, 201, 'guest registration');
  assert.ok(guest.body.accessToken);
  assert.equal(guest.body.reused, false);
  cleanupProfileIds.add(guest.body.user.id);
  const guestAuthUser = await authUserForToken(guest.body.accessToken);
  cleanupAuthUserIds.add(guestAuthUser.id);

  const guestMe = await api('/api/users/me', { token: guest.body.accessToken });
  expectStatus(guestMe, 200, 'guest profile');
  assert.equal(guestMe.body.isGuest, true);

  const guestPhoneChange = await api('/api/users/me', {
    method: 'PATCH',
    token: guest.body.accessToken,
    body: { phone: `012${randomInt(10_000_000, 99_999_999)}` }
  });
  expectStatus(guestPhoneChange, 409, 'unverified guest phone change');
  assert.equal(guestPhoneChange.body.code, 'GUEST_PHONE_VERIFICATION_REQUIRED');

  const duplicateGuest = await api('/api/auth/guest', {
    method: 'POST',
    body: {
      name: 'SHC Smoke Guest',
      phone: guestPhone,
      address: 'Seoul guest smoke-test address'
    }
  });
  expectStatus(duplicateGuest, 409, 'duplicate guest rejection');
  assert.equal(duplicateGuest.body.code, 'GUEST_ALREADY_REGISTERED');

  const guestDelete = await api('/api/users/me', { method: 'DELETE', token: guest.body.accessToken });
  expectStatus(guestDelete, 200, 'guest deletion');
  cleanupAuthUserIds.delete(guestAuthUser.id);
  cleanupProfileIds.delete(guest.body.user.id);
  pass('guest uniqueness, authorization, and cascading deletion');

  const logout = await api('/api/auth/logout', { method: 'POST', token: accessToken });
  expectStatus(logout, 204, 'logout');
  const loggedOutRequest = await api('/api/users/me', { token: accessToken });
  expectStatus(loggedOutRequest, 401, 'revoked session');
  pass('global session logout');

  console.log(`\nLive smoke test passed (${runId}).`);
} finally {
  await cleanup();
}

function bookingPayload(clientRequestId, date, time, withPaidOption) {
  return {
    client_request_id: clientRequestId,
    subtype_id: '686783ebfe52f458209f1770',
    service_type_id: '680885c2de9a24d4ea636564',
    pricing_tier_id: '686de56539f55b47077f1178',
    options: withPaidOption
      ? [{ option_id: '68088bfcd6d322e030c71622', value: 'no' }]
      : [],
    reservation_date: date,
    reservation_time: time,
    timezone: 'Asia/Seoul',
    memo: `automated smoke test ${runId}`
  };
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: 'Non-JSON response received' };
    }
  }
  return { status: response.status, headers: response.headers, body };
}

function expectStatus(response, expected, step) {
  assert.equal(
    response.status,
    expected,
    `${step} returned ${response.status}: ${response.body?.code ?? response.body?.message ?? 'unknown error'}`
  );
}

async function authUserForToken(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw error ?? new Error('Unable to resolve smoke-test Auth user');
  return data.user;
}

async function cleanup() {
  for (const profileId of cleanupProfileIds) {
    await supabase.from('audit_logs').delete().eq('actor_id', profileId);
    await supabase.from('idempotency_keys').delete().like('scope', `${profileId}:%`);
  }

  for (const authUserId of cleanupAuthUserIds) {
    await supabase.auth.admin.deleteUser(authUserId);
  }

  const { data: leftoverProfile } = await supabase
    .from('users')
    .select('id, auth_user_id')
    .eq('email', email)
    .maybeSingle();
  if (leftoverProfile?.auth_user_id) await supabase.auth.admin.deleteUser(leftoverProfile.auth_user_id);
  else if (leftoverProfile?.id) await supabase.from('users').delete().eq('id', leftoverProfile.id);

  const allClientRequestIds = [
    primaryClientRequestId,
    invalidSlotClientRequestId,
    pastSlotClientRequestId,
    ...concurrentClientRequestIds
  ];
  const { count } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .in('client_request_id', allClientRequestIds);
  assert.equal(count, 0, 'Smoke-test cleanup left booking rows behind');
  pass('smoke-test cleanup');
}

function futureDate(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pass(label) {
  console.log(`PASS ${label}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
