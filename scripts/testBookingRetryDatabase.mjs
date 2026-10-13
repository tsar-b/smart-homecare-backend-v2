/**
 * Real PostgreSQL booking retry contract tests. Never reads dotenv/live config.
 * Requires an explicitly enabled synthetic loopback cluster in work/shc-retry-qa.
 * Every invocation retains a new shc_retry_test_* database and JSON evidence.
 *
 * PowerShell example (from the backend):
 * $env:SHC_RETRY_QA_ALLOW_LOCAL='yes'
 * $env:SHC_RETRY_QA_PG_MODULE='C:/.../work/shc-retry-qa/node_modules/pg'
 * node scripts/testBookingRetryDatabase.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, '..');
const qaRoot = path.resolve(backendRoot, '../../shc-retry-qa');
const runId = `${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const database = `shc_retry_test_${runId}`;
const report = { kind: 'native-postgresql-booking-retry', runId, database, startedAt: new Date().toISOString(), tests: [], migrations: [] };
const clients = new Set();
const closed = new WeakSet();
let admin;
let service;
let firstPid;
let secondPid;
let Client;
const settings = {
  // Do not accept generic PG* or DATABASE_URL variables: they may target live data.
  host: '127.0.0.1',
  port: 55439,
  user: 'shc_qa_owner',
  password: 'shc-local-synthetic-only-20261013',
  database: 'postgres',
  connectionTimeoutMillis: 5000,
  application_name: 'shc-booking-retry-synthetic-contract',
};

function safeError(error) {
  // Intentionally omit SQL, query details, payloads, passwords and user fields.
  return { errorName: error?.name || 'Error', code: error?.code || 'QA_CHECK_FAILED' };
}

async function connect(role, target = database) {
  const client = new Client({ ...settings, database: target });
  clients.add(client);
  client.on('error', () => {}); // Disconnect fault tests deliberately close transports.
  client.once('end', () => closed.add(client));
  await client.connect();
  await client.query("set statement_timeout = '8s'");
  await client.query("set lock_timeout = '6s'");
  await client.query("set idle_in_transaction_session_timeout = '20s'");
  if (role) {
    assert.ok(['service_role', 'anon', 'authenticated'].includes(role));
    await client.query(`set role ${role}`);
  }
  return client;
}

async function test(name, action) {
  const started = Date.now();
  try {
    await action();
    report.tests.push({ name, passed: true, durationMs: Date.now() - started });
  } catch (error) {
    report.tests.push({ name, passed: false, durationMs: Date.now() - started, ...safeError(error) });
  }
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => error?.code === code);
}

function identity(request) {
  return [request.user, request.clientId, request.key, request.scope, request.fingerprint];
}

async function commit(client, request) {
  const result = await client.query('select public.commit_booking_submission($1,$2::uuid,$3,$4,$5,$6::jsonb) as result', [...identity(request), JSON.stringify(request.body)]);
  return result.rows[0].result;
}

async function lookup(client, request) {
  const result = await client.query('select public.lookup_booking_submission($1,$2::uuid,$3,$4,$5) as result', identity(request));
  return result.rows[0].result;
}

async function counts(request) {
  return (await admin.query(`select
    (select count(*)::int from public.bookings where user_id=$1 and client_request_id=$2::uuid) as bookings,
    (select count(*)::int from public.booking_submission_receipts where user_id=$1 and client_request_id=$2::uuid) as receipts`, [request.user, request.clientId])).rows[0];
}

async function awaitBlocked(waitingPid, blockingPid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await admin.query('select $2::integer = any(pg_blocking_pids($1::integer)) as blocked', [waitingPid, blockingPid]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected independent PostgreSQL session to block on an uncommitted request.');
}

async function disconnect(client) {
  if (closed.has(client)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Transport disconnect timed out.')), 3000);
    client.once('end', () => { clearTimeout(timer); resolve(); });
    client.connection.stream.destroy();
  });
}

async function seedHistoricalBooking(request) {
  const b = request.body;
  const result = await admin.query(`insert into public.bookings (
    user_id, client_request_id, service_type_id, subtype_id, pricing_tier_id,
    name, reservation_date, reservation_time, options, status, total_price,
    timezone, price_source, is_guest
  ) values ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,false)
  returning to_jsonb(bookings.*) as booking`, [
    request.user, request.clientId, b.service_type_id, b.subtype_id, b.pricing_tier_id,
    b.name, b.reservation_date, b.reservation_time, JSON.stringify(b.options),
    b.status, b.total_price, b.timezone, b.price_source,
  ]);
  return result.rows[0].booking;
}

async function seedLegacyKey(request, state, body = null, status = null) {
  await admin.query(`insert into public.idempotency_keys (
    scope,idempotency_key,fingerprint,state,response_status,response_body,expires_at
  ) values ($1,$2,$3,$4,$5,$6::jsonb,now()+interval '1 day')`, [
    request.scope, request.key, request.fingerprint, state, status, JSON.stringify(body),
  ]);
}

async function main() {
  if (process.env.SHC_RETRY_QA_ALLOW_LOCAL !== 'yes') throw new Error('Explicit synthetic-only opt-in is required.');
  assert.match(database, /^shc_retry_test_[0-9]+_[a-f0-9]+$/);
  const require = createRequire(import.meta.url);
  ({ Client } = require(process.env.SHC_RETRY_QA_PG_MODULE || 'pg'));
  const cluster = await connect(undefined, 'postgres');
  const info = (await cluster.query(`select version(), current_setting('data_directory') as data_directory,
    current_setting('listen_addresses') as listen_addresses, current_setting('port') as port,
    current_user as owner, host(inet_server_addr()) as server_address`)).rows[0];
  const actualData = await realpath(info.data_directory);
  const expectedData = await realpath(path.join(qaRoot, 'data'));
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(normalize(actualData), normalize(expectedData), 'Refusing a database outside the exact isolated QA cluster.');
  assert.equal(info.listen_addresses, '127.0.0.1');
  assert.equal(info.server_address, '127.0.0.1');
  assert.equal(Number(info.port), settings.port);
  assert.equal(info.owner, settings.user);
  report.serverVersion = info.version;
  report.isolation = { loopbackOnly: true, syntheticDataOnly: true, separateDatabase: true, clusterPathVerified: true };

  // Roles are cluster-wide, but this exact synthetic cluster is verified above.
  // No role credentials are installed, and no existing role is altered.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const row = (await cluster.query('select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname=$1', [role])).rows[0];
    if (!row) {
      await cluster.query(`create role ${role} nologin nosuperuser ${role === 'service_role' ? 'bypassrls' : 'nobypassrls'}`);
    } else {
      assert.equal(row.rolcanlogin, false);
      assert.equal(row.rolsuper, false);
      assert.equal(row.rolbypassrls, role === 'service_role');
    }
  }
  await cluster.query(`create database ${database}`);
  admin = await connect();
  await admin.query(`
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create table auth.users (id uuid primary key);
    create function auth.role() returns text language sql stable as 'select current_user::text';
    grant execute on function auth.role() to anon, authenticated, service_role;
  `);
  for (const filename of [
    '001_initial_schema.sql', '002_enable_rls.sql', '003_database_border.sql',
    '004_supabase_auth_and_booking_core.sql', '005_booking_integrity.sql',
    '20261013042516_atomic_booking_retry.sql',
  ]) {
    const sql = await readFile(path.join(backendRoot, 'database/migrations', filename), 'utf8');
    await admin.query(sql);
    report.migrations.push({ filename, sha256: createHash('sha256').update(sql).digest('hex') });
  }

  const users = [randomUUID(), randomUUID()];
  for (const user of users) {
    await admin.query('insert into auth.users (id) values ($1::uuid)', [user]);
    await admin.query("insert into public.users (id,auth_user_id,name,provider) values ($1::text,$1::uuid,'Synthetic QA','standard')", [user]);
  }
  await admin.query(`
    insert into public.service_types (id,key,label) values ('qa_service','qa_service','Synthetic QA service');
    insert into public.subtypes (id,key,label) values ('qa_subtype','qa_subtype','Synthetic QA subtype');
    insert into public.pricing_tiers (id,service_type_id,key,label,base_price) values ('qa_tier','qa_service','qa_tier','Synthetic QA tier',12500);
  `);
  const futureBase = (await admin.query("select to_char((clock_timestamp() at time zone 'Asia/Seoul')::date + 30, 'YYYY-MM-DD') as date")).rows[0].date;
  let slot = 0;
  function request(overrides = {}) {
    const user = overrides.user || users[0];
    const clientId = overrides.clientId || randomUUID();
    const date = new Date(`${futureBase}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + slot++);
    const body = {
      user_id: user, client_request_id: clientId, service_type_id: 'qa_service',
      subtype_id: 'qa_subtype', pricing_tier_id: 'qa_tier', service_type: 'Synthetic QA service',
      subtype: 'Synthetic QA subtype', tier: 'Synthetic QA tier', options: [],
      name: 'Synthetic QA', phone: null, address: 'Synthetic non-dispatchable QA address',
      detail_address: null, reservation_date: date.toISOString().slice(0,10),
      reservation_time: '10:00', timezone: 'Asia/Seoul', memo: 'DO_NOT_DISPATCH',
      total_price: 12500, price_source: 'catalog', legacy_user_id: null,
      is_guest: false, status: '대기', ...overrides.body,
    };
    return { user, clientId, key: overrides.key || `qa-${randomUUID()}`,
      scope: `${user}:POST:/api/bookings`, body,
      fingerprint: overrides.fingerprint || createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  }
  service = await connect('service_role');
  const peer = await connect('service_role');
  firstPid = (await service.query('select pg_backend_pid() as pid')).rows[0].pid;
  secondPid = (await peer.query('select pg_backend_pid() as pid')).rows[0].pid;
  report.independentBackendPids = [firstPid, secondPid];

  await test('independent_postgresql_sessions', async () => assert.notEqual(firstPid, secondPid));
  await test('initial_service_role_readiness', async () => assert.equal((await service.query('select public.booking_retry_ready() as ready')).rows[0].ready, true));

  let original;
  let created;
  await test('created_and_replayed_response_identity', async () => {
    original = request();
    created = await commit(service, original);
    assert.equal(created.outcome, 'created');
    const replay = await commit(service, original);
    assert.equal(replay.outcome, 'replay');
    assert.deepEqual(replay.booking, created.booking);
    assert.deepEqual(await counts(original), { bookings: 1, receipts: 1 });
  });
  await test('same_key_different_body_conflict', async () => {
    const changed = { ...original, body: { ...original.body, total_price: 99000 }, fingerprint: 'f'.repeat(64) };
    assert.equal((await commit(service, changed)).outcome, 'conflict');
    assert.deepEqual(await counts(original), { bookings: 1, receipts: 1 });
  });
  await test('same_client_id_different_key_conflict', async () => {
    assert.equal((await commit(service, { ...original, key: `qa-${randomUUID()}` })).outcome, 'conflict');
  });
  await test('owner_identity_namespaces_and_no_foreign_replay', async () => {
    const other = request({ user: users[1], clientId: original.clientId, key: original.key });
    assert.equal((await lookup(service, other)).outcome, 'missing');
    const result = await commit(service, other);
    assert.equal(result.outcome, 'created');
    assert.notEqual(result.booking.id, created.booking.id);
    assert.equal(result.booking.user_id, users[1]);
    assert.deepEqual((await commit(service, original)).booking, created.booking);
  });
  await test('server_payload_owner_injection_rejected', async () => {
    const invalid = request({ body: { user_id: users[1] } });
    await rejectsCode(() => commit(service, invalid), '22023');
    assert.deepEqual(await counts(invalid), { bookings: 0, receipts: 0 });
  });
  await test('past_new_booking_rejected_without_writes', async () => {
    const past = request({ body: { reservation_date: '2000-01-01' } });
    assert.equal((await commit(service, past)).outcome, 'past');
    assert.deepEqual(await counts(past), { bookings: 0, receipts: 0 });
  });
  await test('historical_receipt_replays_past_appointment', async () => {
    const historical = request({ body: { reservation_date: '2000-01-02' } });
    const booking = await seedHistoricalBooking(historical);
    await admin.query(`insert into public.booking_submission_receipts
      (user_id,client_request_id,idempotency_key,request_scope,fingerprint,booking_id,response_body)
      values ($1,$2::uuid,$3,$4,$5,$6,$7::jsonb)`, [...identity(historical), booking.id, JSON.stringify(booking)]);
    const replay = await commit(service, historical);
    assert.equal(replay.outcome, 'replay');
    assert.deepEqual(replay.booking, booking);
  });
  await test('overlapping_identical_requests_create_once_then_replay', async () => {
    const same = request();
    await service.query('begin');
    const winner = await commit(service, same);
    const waiting = commit(peer, same).then(value => ({ value }), error => ({ error }));
    try {
      await awaitBlocked(secondPid, firstPid);
      await service.query('commit');
      const result = await waiting;
      if (result.error) throw result.error;
      assert.equal(winner.outcome, 'created');
      assert.equal(result.value.outcome, 'replay');
      assert.deepEqual(result.value.booking, winner.booking);
      assert.deepEqual(await counts(same), { bookings: 1, receipts: 1 });
    } finally { await service.query('rollback'); await waiting; }
  });
  await test('competing_slot_transactions_exactly_one_winner', async () => {
    const first = request();
    const second = request({ user: users[1], body: { reservation_date: first.body.reservation_date } });
    await service.query('begin');
    const winner = await commit(service, first);
    const waiting = commit(peer, second).then(value => ({ value }), error => ({ error }));
    try {
      await awaitBlocked(secondPid, firstPid);
      await service.query('commit');
      const loser = await waiting;
      assert.equal(winner.outcome, 'created');
      assert.equal(loser.error?.code, '23505');
      assert.deepEqual(await counts(first), { bookings: 1, receipts: 1 });
      assert.deepEqual(await counts(second), { bookings: 0, receipts: 0 });
    } finally { await service.query('rollback'); await waiting; }
  });
  await test('cancellation_rebooking_and_old_replay_does_not_reinstate', async () => {
    const first = request();
    const winner = await commit(service, first);
    await admin.query("update public.bookings set status='취소' where id=$1", [winner.booking.id]);
    const replacement = request({ body: { reservation_date: first.body.reservation_date } });
    const rebooked = await commit(service, replacement);
    assert.equal(rebooked.outcome, 'created');
    assert.notEqual(rebooked.booking.id, winner.booking.id);
    const replay = await commit(service, first);
    assert.equal(replay.outcome, 'replay');
    assert.deepEqual(replay.booking, winner.booking);
    assert.equal((await admin.query('select status from public.bookings where id=$1', [winner.booking.id])).rows[0].status, '취소');
    assert.deepEqual(await counts(first), { bookings: 1, receipts: 1 });
    assert.deepEqual(await counts(replacement), { bookings: 1, receipts: 1 });
  });
  await test('injected_receipt_failure_rolls_back_booking_and_receipt', async () => {
    await admin.query(`create function public.qa_fail_receipt() returns trigger language plpgsql as $$
      begin if current_setting('shc.qa_receipt_fail',true)='on' then
        raise exception using errcode='P0001', message='Synthetic receipt insert failure';
      end if; return new; end $$;
      create trigger qa_fail_receipt before insert on public.booking_submission_receipts
      for each row execute function public.qa_fail_receipt();`);
    const attempt = request();
    await service.query("set shc.qa_receipt_fail='on'");
    try {
      await rejectsCode(() => commit(service, attempt), 'P0001');
      assert.deepEqual(await counts(attempt), { bookings: 0, receipts: 0 });
    } finally { await service.query("set shc.qa_receipt_fail='off'"); }
    assert.equal((await commit(service, attempt)).outcome, 'created');
    assert.deepEqual(await counts(attempt), { bookings: 1, receipts: 1 });
  });
  await test('transport_disconnect_before_commit_rolls_back_both_then_retry_works', async () => {
    const lost = await connect('service_role');
    const attempt = request();
    await lost.query('begin');
    assert.equal((await commit(lost, attempt)).outcome, 'created');
    assert.deepEqual(await counts(attempt), { bookings: 0, receipts: 0 });
    await disconnect(lost);
    assert.equal((await commit(service, attempt)).outcome, 'created');
    assert.deepEqual(await counts(attempt), { bookings: 1, receipts: 1 });
  });
  await test('transport_disconnect_after_confirmed_commit_replays', async () => {
    const lost = await connect('service_role');
    const attempt = request();
    await lost.query('begin');
    const result = await commit(lost, attempt);
    await lost.query('commit');
    await disconnect(lost);
    const replay = await commit(service, attempt);
    assert.equal(replay.outcome, 'replay');
    assert.deepEqual(replay.booking, result.booking);
    assert.deepEqual(await counts(attempt), { bookings: 1, receipts: 1 });
  });

  for (const role of ['anon', 'authenticated']) {
    const unprivileged = await connect(role);
    await test(`${role}_cannot_read_receipts_despite_permissive_defaults`, () => rejectsCode(() => unprivileged.query('select * from public.booking_submission_receipts limit 1'), '42501'));
    await test(`${role}_cannot_lookup_rpc`, () => rejectsCode(() => lookup(unprivileged, original), '42501'));
    await test(`${role}_cannot_commit_rpc`, () => rejectsCode(() => commit(unprivileged, original), '42501'));
    await test(`${role}_cannot_readiness_rpc`, () => rejectsCode(() => unprivileged.query('select public.booking_retry_ready()'), '42501'));
  }
  await test('service_role_cannot_update_immutable_receipt', () => rejectsCode(() => service.query('update public.booking_submission_receipts set fingerprint=$1 where user_id=$2 and client_request_id=$3::uuid', ['e'.repeat(64), original.user, original.clientId]), '42501'));
  await test('service_role_cannot_delete_immutable_receipt', () => rejectsCode(() => service.query('delete from public.booking_submission_receipts where user_id=$1 and client_request_id=$2::uuid', [original.user, original.clientId]), '42501'));
  await test('readiness_detects_revoked_insert_and_recovers_after_rollback', async () => {
    await admin.query('begin');
    try {
      await admin.query('revoke insert on public.booking_submission_receipts from service_role');
      await admin.query('set local role service_role');
      assert.equal((await admin.query('select public.booking_retry_ready() as ready')).rows[0].ready, false);
    } finally { await admin.query('rollback'); }
    assert.equal((await service.query('select public.booking_retry_ready() as ready')).rows[0].ready, true);
  });
  await test('uppercase_uuid_payload_is_normalized_and_replayed', async () => {
    const attempt = request({ clientId: randomUUID().toUpperCase() });
    const result = await commit(service, attempt);
    assert.equal(result.outcome, 'created');
    assert.equal(result.booking.client_request_id, attempt.clientId.toLowerCase());
    assert.deepEqual((await commit(service, attempt)).booking, result.booking);
  });
  await test('legacy_completed_verified_receipt_replays_without_new_booking', async () => {
    const historical = request({ body: { reservation_date: '2000-01-03' } });
    const booking = await seedHistoricalBooking(historical);
    await seedLegacyKey(historical, 'completed', booking, 201);
    const replay = await commit(service, historical);
    assert.equal(replay.outcome, 'replay');
    assert.deepEqual(replay.booking, booking);
    assert.deepEqual(await counts(historical), { bookings: 1, receipts: 0 });
  });
  await test('legacy_completed_wrong_owner_requires_review', async () => {
    const historical = request();
    await seedLegacyKey(historical, 'completed', { user_id: users[1], client_request_id: historical.clientId }, 201);
    assert.equal((await commit(service, historical)).outcome, 'review_required');
    assert.deepEqual(await counts(historical), { bookings: 0, receipts: 0 });
  });
  await test('legacy_processing_with_existing_booking_requires_review', async () => {
    const historical = request();
    await seedHistoricalBooking(historical);
    await seedLegacyKey(historical, 'processing');
    assert.equal((await commit(service, historical)).outcome, 'review_required');
    assert.deepEqual(await counts(historical), { bookings: 1, receipts: 0 });
  });
  await test('legacy_processing_without_booking_can_retry_safely', async () => {
    const historical = request();
    await seedLegacyKey(historical, 'processing');
    assert.equal((await commit(service, historical)).outcome, 'created');
    assert.equal((await commit(service, historical)).outcome, 'replay');
    assert.deepEqual(await counts(historical), { bookings: 1, receipts: 1 });
  });
  await test('legacy_processing_different_fingerprint_conflicts', async () => {
    const historical = request();
    await seedLegacyKey(historical, 'processing');
    assert.equal((await commit(service, { ...historical, fingerprint: 'a'.repeat(64) })).outcome, 'conflict');
    assert.deepEqual(await counts(historical), { bookings: 0, receipts: 0 });
  });
  await test('durable_database_settings_enabled', async () => {
    const row = (await admin.query("select current_setting('fsync') as fsync, current_setting('synchronous_commit') as synchronous_commit")).rows[0];
    assert.equal(row.fsync, 'on');
    assert.equal(row.synchronous_commit, 'on');
  });
}

try {
  await main();
} catch (error) {
  report.fatal = safeError(error);
} finally {
  await Promise.all([...clients].map(async client => {
    if (!closed.has(client)) await client.end().catch(() => {});
  }));
  report.finishedAt = new Date().toISOString();
  report.passed = report.tests.filter(test => test.passed).length;
  report.failed = report.tests.filter(test => !test.passed).length;
  report.ok = !report.fatal && report.failed === 0 && report.passed > 0;
  // Only write evidence after this exact QA cluster was successfully verified.
  if (report.isolation?.clusterPathVerified) {
    const evidencePath = path.join(qaRoot, `booking-retry-evidence-${runId}.json`);
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    report.evidencePath = evidencePath;
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
