/**
 * Local HTTP integration, NOT hosted Supabase/cloud/native acceptance.
 * Production Express middleware/controllers and the installed supabase-js client
 * talk to a minimal loopback provider fixture. Booking RPCs/read queries execute
 * on the real isolated PostgreSQL cluster as service_role. Auth and storage are
 * synthetic fixtures, not real GoTrue/PostgREST/Storage services.
 *
 * Start work/shc-retry-qa/runner.mjs first. Set SHC_RETRY_QA_ALLOW_LOCAL=yes;
 * optionally set SHC_RETRY_QA_PG_MODULE to that runner's node_modules/pg path.
 * Every run first executes testBookingRetryDatabase.mjs, retaining its new DB.
 * No dotenv/live configuration, customer data, migrations on cloud, or deletion.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.resolve(root, '../../shc-retry-qa');
const runId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const backendKey = `sb_secret_synthetic_http_${runId}`;
const report = {
  kind: 'express-supabase-js-native-postgresql-via-minimal-http-fixture',
  runId, startedAt: new Date().toISOString(), tests: [],
  limitations: [
    'Auth identities and storage readiness responses are synthetic.',
    'This fixture is not PostgREST or hosted Supabase compatibility certification.',
    'Attachment HEAD readiness is synthetic; no attachment transfer is exercised.',
    'No native Android/iOS, cloud network, email, or social OAuth test is performed.'
  ]
};
let admin;
let pool;
let providerServer;
let apiServer;
let apiUrl;
let unknownRoutes = [];
let loseCommitReply = false;
let lostCommitBookingId;
let rejectRetryLookup = false;
let verifiedCluster = false;
const tokenUsers = new Map();
const rpcCalls = [];

async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    report.tests.push({ name, passed: true, durationMs: Date.now() - started });
  } catch (error) {
    report.tests.push({ name, passed: false, durationMs: Date.now() - started,
      errorName: error?.name || 'Error', code: error?.code || 'HTTP_QA_FAILED',
      // Assertions here contain synthetic values only; omit stacks and payloads.
      message: String(error?.message || '').slice(0, 300) });
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    assert.ok(raw.length < 100_000, 'Fixture body exceeded safe size.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function serviceQuery(sql, values = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    await client.query("set local statement_timeout='8s'");
    const result = await client.query(sql, values);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

// Intentionally narrow protocol support: unexpected paths/filters fail closed.
// User supplied values are SQL parameters; table/column names are allowlisted.
async function provider(req, res) {
  try {
    assert.equal(req.socket.remoteAddress, '127.0.0.1');
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.headers.apikey, backendKey);
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const id = tokenUsers.get(req.headers.authorization);
      return id
        ? json(res, 200, { id, email: 'synthetic@example.invalid', aud: 'authenticated', role: 'authenticated' })
        : json(res, 401, { msg: 'Synthetic invalid identity', code: 'bad_jwt' });
    }
    assert.equal(req.headers.authorization, `Bearer ${backendKey}`);
    if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
      return json(res, 200, { users: [], aud: 'authenticated' });
    }
    if (url.pathname === '/storage/v1/bucket' && req.method === 'GET') {
      return json(res, 200, [
        { id: 'shc-booking-images-v1', public: false, file_size_limit: 10_000_000,
          allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] },
        { id: 'shc-booking-videos-v1', public: false, file_size_limit: 45_000_000,
          allowed_mime_types: ['video/mp4', 'video/quicktime'] }
      ]);
    }
    if (url.pathname === '/rest/v1/booking_attachments' && req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Range': '*/0' });
      return res.end();
    }
    if (url.pathname.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const input = await body(req);
      rpcCalls.push(name);
      if (name === 'booking_retry_ready') {
        const result = await serviceQuery('select public.booking_retry_ready() as value');
        return json(res, 200, result.rows[0].value);
      }
      assert.ok(['lookup_booking_submission', 'commit_booking_submission'].includes(name));
      if (name === 'lookup_booking_submission' && rejectRetryLookup) {
        return json(res, 404, { code: 'PGRST202', message: 'Synthetic missing retry RPC' });
      }
      const values = [input.p_user_id, input.p_client_request_id, input.p_key, input.p_scope, input.p_fingerprint];
      let result;
      if (name === 'lookup_booking_submission') {
        result = await serviceQuery('select public.lookup_booking_submission($1,$2::uuid,$3,$4,$5) as value', values);
      } else {
        result = await serviceQuery('select public.commit_booking_submission($1,$2::uuid,$3,$4,$5,$6::jsonb) as value',
          [...values, JSON.stringify(input.p_booking)]);
      }
      if (name === 'commit_booking_submission' && loseCommitReply) {
        // SQL transaction is durably committed before destroying the HTTP reply.
        loseCommitReply = false;
        lostCommitBookingId = result.rows[0].value.booking?.id;
        return res.destroy();
      }
      return json(res, 200, result.rows[0].value);
    }
    const table = url.pathname.replace('/rest/v1/', '');
    if (['users', 'subtypes', 'service_types', 'pricing_tiers', 'timeslots', 'bookings'].includes(table)) {
      assert.ok(['GET', 'HEAD', 'PATCH'].includes(req.method));
      const conditions = [];
      const values = [];
      for (const [column, filter] of url.searchParams) {
        if (column === 'select' || column === 'order') continue;
        if (column === 'or') {
          assert.equal(table, 'pricing_tiers');
          const match = filter.match(/^\(service_type\.eq\.([a-z_]+),service_type_id\.eq\.\1\)$/);
          assert.ok(match, 'Unsupported pricing filter.');
          values.push(match[1]);
          conditions.push(`(service_type=$${values.length} or service_type_id=$${values.length})`);
          continue;
        }
        assert.ok(['id', 'auth_user_id', 'user_id', 'subtype', 'status', 'reservation_date'].includes(column));
        if (filter.startsWith('eq.')) {
          values.push(filter.slice(3));
          conditions.push(`${column}=$${values.length}`);
        } else if (column === 'status' && filter.startsWith('in.(') && filter.endsWith(')')) {
          values.push(filter.slice(4, -1).split(','));
          conditions.push(`status=any($${values.length}::text[])`);
        } else throw new Error('Unsupported fixture filter.');
      }
      const where = conditions.length ? ` where ${conditions.join(' and ')}` : '';
      let result;
      if (req.method === 'PATCH') {
        assert.equal(table, 'bookings');
        assert.deepEqual(await body(req), { status: '취소' });
        assert.ok(url.searchParams.has('user_id') && url.searchParams.has('id'));
        result = await serviceQuery(`update public.bookings set status='취소'${where} returning *`, values);
      } else {
        const order = url.searchParams.get('order');
        assert.ok(!order || order === 'reservation_date.desc');
        result = await serviceQuery(`select * from public.${table}${where}${order ? ' order by reservation_date desc' : ''}`, values);
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Range': `*/${result.rowCount}` });
        return res.end();
      }
      if (req.headers.accept?.includes('application/vnd.pgrst.object+json')) {
        if (result.rowCount !== 1) return json(res, 406, { code: 'PGRST116', message: 'Synthetic single row mismatch' });
        return json(res, 200, result.rows[0]);
      }
      return json(res, 200, result.rows);
    }
    unknownRoutes.push(`${req.method} ${url.pathname}`);
    return json(res, 501, { code: 'QA_UNSUPPORTED_ROUTE', message: 'Unsupported fixture route' });
  } catch (error) {
    const sqlError = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
    if (!sqlError) unknownRoutes.push(`fixture-error:${error.code || error.name}`);
    if (!res.destroyed) json(res, sqlError ? 409 : 500, {
      code: sqlError ? error.code : 'QA_FIXTURE_ERROR',
      message: sqlError ? error.message : 'Fixture protocol assertion failed',
      details: sqlError ? error.detail : null
    });
  }
}

async function request(method, endpoint, payload, token = 'qa-user-one', key) {
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function main() {
  assert.equal(process.env.SHC_RETRY_QA_ALLOW_LOCAL, 'yes', 'Explicit local synthetic-only opt-in required.');
  const sqlOutput = execFileSync(process.execPath, [path.join(root, 'scripts/testBookingRetryDatabase.mjs')], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000
  });
  const sqlReport = JSON.parse(sqlOutput);
  assert.equal(sqlReport.ok, true, 'The prerequisite real SQL suite must pass.');
  report.prerequisite = { database: sqlReport.database, passed: sqlReport.passed, evidencePath: sqlReport.evidencePath };
  assert.match(sqlReport.database, /^shc_retry_test_[0-9]+_[a-f0-9]+$/);
  const require = createRequire(import.meta.url);
  const { Client, Pool } = require(process.env.SHC_RETRY_QA_PG_MODULE || 'pg');
  const settings = { host: '127.0.0.1', port: 55439, user: 'shc_qa_owner',
    password: 'shc-local-synthetic-only-20261013', database: sqlReport.database,
    connectionTimeoutMillis: 5_000, application_name: 'shc-isolated-http-retry-qa' };
  admin = new Client(settings);
  await admin.connect();
  const info = (await admin.query(`select current_setting('data_directory') as directory,
    current_setting('listen_addresses') as listener, host(inet_server_addr()) as host`)).rows[0];
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(normalize(await realpath(info.directory)), normalize(await realpath(path.join(qaRoot, 'data'))));
  assert.equal(info.listener, '127.0.0.1');
  assert.equal(info.host, '127.0.0.1');
  verifiedCluster = true;
  pool = new Pool({ ...settings, max: 3, idleTimeoutMillis: 1_000 });
  const users = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, user] of users.entries()) {
    await admin.query('insert into auth.users(id) values($1)', [user]);
    await admin.query(`insert into public.users(id,auth_user_id,name,provider,is_guest)
      values($1::text,$1::uuid,'Synthetic HTTP QA',$2,$3)`, [user, index === 2 ? 'guest' : 'standard', index === 2]);
  }
  tokenUsers.set('Bearer qa-user-one', users[0]);
  tokenUsers.set('Bearer qa-user-two', users[1]);
  tokenUsers.set('Bearer qa-guest', users[2]);
  await admin.query(`insert into public.service_types(id,key,label) values('http_service','http_service','Synthetic HTTP service');
    insert into public.subtypes(id,key,label) values('http_subtype','http_subtype','Synthetic HTTP subtype');
    insert into public.pricing_tiers(id,service_type_id,subtype,key,label,base_price)
      values('http_tier','http_service','http_subtype','http_tier','Synthetic HTTP tier',23000);
    insert into public.timeslots(id,date,type,slots) values('http_slots',null,'generic','["10:00"]');`);
  providerServer = http.createServer(provider);
  const providerUrl = await listen(providerServer);
  // Override every Supabase credential source and disable dotenv reads before
  // loading production modules. The process never imports or reads local .env.
  for (const key of Object.keys(process.env)) {
    if (/^(SUPABASE_|KAKAO_|APPLE_|DOTENV_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: path.join(qaRoot, `nonexistent-dotenv-${runId}`),
    NODE_ENV: 'test', LOG_LEVEL: 'silent', SUPABASE_URL: providerUrl,
    SUPABASE_SECRET_KEY: backendKey, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_http_qa',
    RATE_LIMIT_MAX: '1000', AUTH_RATE_LIMIT_MAX: '1000', ENABLE_BOOKING_MEDIA_PILOT_UPLOADS: 'false',
    SUPABASE_OAUTH_PROVIDERS: '', AUTH_EMAIL_AUTO_CONFIRM: 'false', TRUST_PROXY: 'false'
  });
  const { createHttpServer } = await tsImport('../src/core/http.ts', import.meta.url);
  const { createFingerprint } = await tsImport('../src/lib/canonical.ts', import.meta.url);
  apiServer = http.createServer(createHttpServer());
  apiUrl = await listen(apiServer);
  let slot = 0;
  function booking(changes = {}) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 150 + slot++);
    return { client_request_id: randomUUID(), subtype_id: 'http_subtype', service_type_id: 'http_service',
      pricing_tier_id: 'http_tier', reservation_date: date.toISOString().slice(0, 10), reservation_time: '10:00',
      timezone: 'Asia/Seoul', memo: 'SYNTHETIC_DO_NOT_DISPATCH', ...changes };
  }
  const post = (value, token = 'qa-user-one', key = value.client_request_id) => request('POST', '/api/bookings', value, token, key);
  const postLegacy = (value, token = 'qa-user-one', key = value.client_request_id) => request('POST', '/api/booking', value, token, key);
  const counts = async value => (await admin.query(`select
    (select count(*)::int from public.bookings where client_request_id=$1) as bookings,
    (select count(*)::int from public.booking_submission_receipts where client_request_id=$1) as receipts`, [value.client_request_id])).rows[0];

  await check('health_and_real_retry_readiness', async () => {
    assert.equal((await request('GET', '/health')).status, 200);
    const ready = await request('GET', '/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.dependencies.supabaseDatabase, true);
  });
  await check('missing_invalid_and_guest_auth_rejected', async () => {
    const value = booking();
    assert.equal((await post(value, '')).status, 401);
    assert.equal((await post(value, 'unknown-token')).status, 401);
    const guest = await post(value, 'qa-guest');
    assert.equal(guest.status, 403);
    assert.equal(guest.body.code, 'MEMBER_ACCOUNT_REQUIRED');
    assert.deepEqual(await counts(value), { bookings: 0, receipts: 0 });
  });
  await check('idempotency_header_and_body_validation_run_before_rpc', async () => {
    const value = booking();
    const before = rpcCalls.length;
    assert.equal((await post(value, 'qa-user-one', '')).status, 400);
    assert.equal((await post({ ...value, client_request_id: 'bad-uuid' })).status, 400);
    assert.equal((await post({ ...value, total_price: 1 })).status, 400);
    assert.equal(rpcCalls.length, before);
    assert.deepEqual(await counts(value), { bookings: 0, receipts: 0 });
  });
  await check('legacy_booking_cannot_bypass_member_only_creation', async () => {
    const value = booking();
    const before = rpcCalls.length;
    for (const key of [value.client_request_id, '']) {
      const guest = await postLegacy(value, 'qa-guest', key);
      assert.equal(guest.status, 403);
      assert.equal(guest.body.code, 'MEMBER_ACCOUNT_REQUIRED');
    }
    assert.equal(rpcCalls.length, before);
    assert.deepEqual(await counts(value), { bookings: 0, receipts: 0 });
  });
  await check('legacy_member_creation_replay_preserves_route_scope_and_raw_fingerprint', async () => {
    // Unknown fields are stripped and timezone is normalized by schema, but the
    // retry identity must still fingerprint the exact pre-validation payload.
    const value = booking({ timezone: 'America/New_York', legacy_client_note: 'SYNTHETIC_RAW_FIELD' });
    const created = await postLegacy(value);
    assert.equal(created.status, 201);
    assert.equal(created.body.user_id, users[0]);
    assert.equal(created.body.total_price, 23000);
    assert.equal(created.body.timezone, 'Asia/Seoul');
    const receipt = (await admin.query(`select request_scope,fingerprint from public.booking_submission_receipts
      where user_id=$1 and client_request_id=$2`, [users[0], value.client_request_id])).rows[0];
    assert.equal(receipt.request_scope, `${users[0]}:POST:/api/booking`);
    assert.equal(receipt.fingerprint, createFingerprint(value));
    const replay = await postLegacy(value);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(replay.body, created.body);
    const changed = await postLegacy({ ...value, legacy_client_note: 'CHANGED_RAW_FIELD' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
    // Moving the same body/key to the canonical route must not silently change
    // the original route scope or create a second booking.
    const differentRoute = await post(value);
    assert.equal(differentRoute.status, 409);
    assert.equal(differentRoute.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(await counts(value), { bookings: 1, receipts: 1 });
  });
  let original;
  let originalResponse;
  await check('creation_uses_server_price_and_authenticated_owner', async () => {
    original = booking({ user_id: users[1], timezone: 'America/New_York' });
    originalResponse = await post(original);
    assert.equal(originalResponse.status, 201);
    assert.equal(originalResponse.body.total_price, 23000);
    assert.equal(originalResponse.body.user_id, users[0]);
    assert.equal(originalResponse.body.timezone, 'Asia/Seoul');
    assert.deepEqual(await counts(original), { bookings: 1, receipts: 1 });
  });
  await check('retry_replays_original_price_before_catalog_revalidation', async () => {
    await admin.query("update public.pricing_tiers set base_price=49000 where id='http_tier'");
    const replay = await post(original);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(replay.body, originalResponse.body);
  });
  await check('same_key_changed_body_returns_conflict_without_duplicate', async () => {
    const changed = await post({ ...original, memo: 'CHANGED_SYNTHETIC_MEMO' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(await counts(original), { bookings: 1, receipts: 1 });
  });
  await check('foreign_detail_and_cancellation_are_rejected', async () => {
    const id = originalResponse.body.id;
    assert.equal((await request('GET', `/api/bookings/${id}`, undefined, 'qa-user-two')).status, 404);
    assert.equal((await request('PATCH', `/api/bookings/${id}/cancel`, undefined, 'qa-user-two')).status, 409);
    assert.equal((await admin.query('select status from public.bookings where id=$1', [id])).rows[0].status, '대기');
  });
  await check('lost_committed_rpc_reply_returns_503_then_recovers_original_id', async () => {
    const value = booking();
    loseCommitReply = true;
    const lost = await post(value);
    assert.equal(lost.status, 503);
    assert.equal(lost.body.code, 'IDEMPOTENCY_STORE_UNAVAILABLE');
    assert.ok(lostCommitBookingId);
    assert.deepEqual(await counts(value), { bookings: 1, receipts: 1 });
    const recovered = await post(value);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.get('idempotency-replayed'), 'true');
    assert.equal(recovered.body.id, lostCommitBookingId);
    assert.deepEqual(await counts(value), { bookings: 1, receipts: 1 });
  });
  await check('parallel_duplicate_http_submissions_create_one_booking', async () => {
    const value = booking();
    const results = await Promise.all([post(value), post(value)]);
    assert.deepEqual(results.map(value => value.status), [201, 201]);
    assert.equal(results[0].body.id, results[1].body.id);
    assert.equal(results.filter(value => value.headers.get('idempotency-replayed') === 'true').length, 1);
    assert.deepEqual(await counts(value), { bookings: 1, receipts: 1 });
  });
  await check('competing_customer_http_submissions_have_one_slot_winner', async () => {
    const first = booking();
    const second = { ...first, client_request_id: randomUUID() };
    const results = await Promise.all([post(first), post(second, 'qa-user-two')]);
    assert.deepEqual(results.map(value => value.status).sort(), [201, 409]);
    assert.equal(results.find(value => value.status === 409).body.code, 'BOOKING_SLOT_UNAVAILABLE');
  });
  await check('owner_cancellation_releases_slot_and_retry_does_not_restore_it', async () => {
    assert.equal((await request('PATCH', `/api/bookings/${originalResponse.body.id}/cancel`)).status, 200);
    const replacement = { ...original, client_request_id: randomUUID() };
    assert.equal((await post(replacement)).status, 201);
    const replay = await post(original);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, originalResponse.body);
    assert.equal((await admin.query('select status from public.bookings where id=$1', [originalResponse.body.id])).rows[0].status, '취소');
  });
  await check('missing_retry_rpc_fails_closed_without_direct_insert', async () => {
    const value = booking();
    rejectRetryLookup = true;
    try {
      const result = await post(value);
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'IDEMPOTENCY_STORE_UNAVAILABLE');
      assert.deepEqual(await counts(value), { bookings: 0, receipts: 0 });
    } finally { rejectRetryLookup = false; }
  });
  await check('ready_fails_when_real_receipt_insert_privilege_is_revoked', async () => {
    await admin.query('revoke insert on public.booking_submission_receipts from service_role');
    try {
      const result = await request('GET', '/ready');
      assert.equal(result.status, 503);
      assert.equal(result.body.dependencies.supabaseDatabase, false);
    } finally { await admin.query('grant insert on public.booking_submission_receipts to service_role'); }
    assert.equal((await request('GET', '/ready')).status, 200);
  });
  await check('fixture_recognized_all_requests_without_fallback', async () => assert.deepEqual(unknownRoutes, []));
  report.rpcCalls = rpcCalls.reduce((counts, name) => ({ ...counts, [name]: (counts[name] || 0) + 1 }), {});
  report.versions = {
    node: process.version,
    supabaseJs: JSON.parse(await readFile(path.join(root, 'node_modules/@supabase/supabase-js/package.json'), 'utf8')).version,
    express: JSON.parse(await readFile(path.join(root, 'node_modules/express/package.json'), 'utf8')).version
  };
}

try { await main(); }
catch (error) { report.fatal = { errorName: error?.name || 'Error', code: error?.code || 'HTTP_QA_SETUP_FAILED', message: String(error?.message || '').slice(0, 300) }; }
finally {
  for (const server of [apiServer, providerServer]) {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  await pool?.end();
  await admin?.end();
  report.finishedAt = new Date().toISOString();
  report.passed = report.tests.filter(value => value.passed).length;
  report.failed = report.tests.filter(value => !value.passed).length;
  report.ok = !report.fatal && report.failed === 0 && report.passed > 0;
  if (verifiedCluster) {
    report.evidencePath = path.join(qaRoot, `booking-retry-http-evidence-${runId}.json`);
    await writeFile(report.evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
