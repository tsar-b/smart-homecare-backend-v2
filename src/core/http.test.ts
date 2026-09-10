import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';
import { createHttpServer, databaseProbeIsReady } from './http.js';

const healthyProbe = { error: null, status: 200, count: 0 };
const fulfilled = <T>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value });

const readyBuckets = [
  {
    id: 'shc-booking-images-v1',
    public: false,
    file_size_limit: 10_000_000,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
  },
  {
    id: 'shc-booking-videos-v1',
    public: false,
    file_size_limit: 45_000_000,
    allowed_mime_types: ['video/mp4', 'video/quicktime']
  }
];

test('database readiness accepts an empty table only with a successful exact count', () => {
  assert.equal(databaseProbeIsReady(fulfilled(healthyProbe)), true);
  assert.equal(databaseProbeIsReady(fulfilled({ ...healthyProbe, status: 206, count: 7 })), true);
});

test('database readiness fails closed on rejected, errored or unverified HEAD responses', () => {
  assert.equal(databaseProbeIsReady({ status: 'rejected', reason: new Error('offline') }), false);
  for (const probe of [
    { ...healthyProbe, error: { code: 'PGRST205' } },
    { ...healthyProbe, status: 404 },
    { ...healthyProbe, status: 503 },
    { ...healthyProbe, status: 204, count: null },
    { ...healthyProbe, count: null },
    { ...healthyProbe, count: Number.NaN },
    { ...healthyProbe, count: -1 },
    { ...healthyProbe, count: 0.5 }
  ]) {
    assert.equal(databaseProbeIsReady(fulfilled(probe)), false);
  }
});

test('installed Supabase SDK bodyless HEAD 404 cannot make a missing table ready', async () => {
  let requests = 0;
  const client = createClient('https://readiness-test.invalid', 'sb_secret_offline_test', {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: async (_input, init) => {
        requests += 1;
        assert.equal(init?.method, 'HEAD');
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }
    }
  });
  const result = await client.from('missing_table').select('id', { count: 'exact', head: true });
  assert.equal(requests, 1);
  // The SDK currently returns no error for this bodyless failure. Keep the
  // contract regression even if a later SDK fixes its error representation.
  assert.equal(result.count, null);
  assert.equal(databaseProbeIsReady(fulfilled(result)), false);
});

for (const missingTable of ['users', 'booking_attachments']) {
  test(`/ready returns 503 when ${missingTable} HEAD is 404 with error null`, async (t) => {
    const probedTables: string[] = [];
    t.mock.method(supabaseAdmin, 'from', (table: string) => ({
      select: (columns: string, options: { count: string; head: boolean }) => {
        probedTables.push(table);
        assert.equal(columns, 'id');
        assert.deepEqual(options, { count: 'exact', head: true });
        return Promise.resolve(table === missingTable
          ? { error: null, status: 404, count: null }
          : healthyProbe);
      }
    }) as never);
    t.mock.method(supabaseAdmin.auth.admin, 'listUsers', async () => ({
      data: { users: [] }, error: null
    }) as never);
    t.mock.method(supabaseAdmin.storage, 'listBuckets', async () => ({
      data: readyBuckets, error: null
    }) as never);

    const result = await callReadinessHandler();
    assert.deepEqual(probedTables, ['users', 'booking_attachments']);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      ok: false,
      dependencies: { supabaseAuth: true, supabaseDatabase: false, supabaseStorage: true }
    });
  });
}

test('/ready still returns 200 for existing empty tables with healthy Auth and private buckets', async (t) => {
  t.mock.method(supabaseAdmin, 'from', () => ({
    select: () => Promise.resolve(healthyProbe)
  }) as never);
  t.mock.method(supabaseAdmin.auth.admin, 'listUsers', async () => ({
    data: { users: [] }, error: null
  }) as never);
  t.mock.method(supabaseAdmin.storage, 'listBuckets', async () => ({
    data: readyBuckets, error: null
  }) as never);

  const result = await callReadinessHandler();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    dependencies: { supabaseAuth: true, supabaseDatabase: true, supabaseStorage: true }
  });
});

async function callReadinessHandler() {
  // Invoke the registered route without opening a socket. Every upstream call
  // above is mocked; no credentials, live database or network are required.
  const app = createHttpServer();
  const layers = app.router.stack as Array<{
    route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> };
  }>;
  const route = layers.find((layer) => layer.route?.path === '/ready')?.route;
  assert.ok(route);
  const result: { status: number; body: unknown } = { status: 200, body: undefined };
  const response = {
    status(code: number) { result.status = code; return response; },
    json(body: unknown) { result.body = body; return response; }
  };
  await route.stack[0].handle({}, response);
  return result;
}
