import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { HttpError } from '../../core/errors.js';
import { LOGGER_REDACTIONS } from '../../core/logger.js';
import { purgeMediaBeforeDestructiveDelete } from '../adminCrud/adminCrud.controller.js';
import {
  BOOKING_IMAGE_BUCKET,
  BOOKING_VIDEO_BUCKET,
  BOOKING_ATTACHMENT_INTENT_RATE_LIMIT,
  BOOKING_ATTACHMENT_INTENT_RATE_WINDOW_MS,
  MAX_USER_MEDIA_RESERVATIONS,
  MAX_USER_MEDIA_RESERVED_BYTES,
  SIGNED_UPLOAD_REQUEST_TIMEOUT_MS,
  STORAGE_WRITE_EXPIRY_GRACE_SECONDS,
  STANDARD_UPLOAD_MAX_BYTES,
  TUS_CHUNK_SIZE_BYTES,
  createBookingMediaObjectPath,
  deriveTusEndpoint,
  uploadMethodForSize
} from './bookingAttachment.constants.js';
import { CreateBookingAttachmentIntentSchema } from './bookingAttachment.schema.js';
import {
  assertBookingMediaEditable,
  assertReusableAttachmentIntent,
  assertStoragePrefixResponseIsBounded,
  attachmentLimitDetails,
  buildCompletedAttachmentPatch,
  hasExpectedMediaSignature,
  isNonCacheableStoragePolicy,
  isStorageWriteWindowClosed,
  readBoundedResponseBody,
  storageWriteExpiryIso,
  toAttachmentResponse,
  type BookingAttachmentRow
} from './bookingAttachment.service.js';

const attachment = (overrides: Partial<BookingAttachmentRow> = {}): BookingAttachmentRow => ({
  id: '03b6cc48-96e8-4a68-ae9b-2ee826745c2c',
  client_attachment_id: '25bad8c5-ded7-407e-86cf-96fb656aa48d',
  booking_id: 'booking-1',
  owner_user_id: 'user-1',
  bucket_id: BOOKING_IMAGE_BUCKET,
  object_path: 'v1/03/03b6cc48-96e8-4a68-ae9b-2ee826745c2c.jpg',
  media_kind: 'image',
  mime_type: 'image/jpeg',
  declared_size_bytes: 1000,
  actual_size_bytes: null,
  status: 'pending',
  storage_etag: null,
  upload_expires_at: '2030-01-01T02:00:00.000Z',
  write_expires_at: '2030-01-01T02:05:00.000Z',
  completed_at: null,
  failure_code: null,
  created_at: '2030-01-01T00:00:00.000Z',
  updated_at: '2030-01-01T00:00:00.000Z',
  ...overrides
});

test('attachment intent accepts normalized supported media and rejects client path fields', () => {
  const parsed = CreateBookingAttachmentIntentSchema.parse({
    clientAttachmentId: '25bad8c5-ded7-407e-86cf-96fb656aa48d',
    kind: 'image',
    contentType: ' IMAGE/JPEG; charset=binary ',
    sizeBytes: 10_000_000
  });
  assert.equal(parsed.contentType, 'image/jpeg');

  assert.equal(
    CreateBookingAttachmentIntentSchema.safeParse({
      ...parsed,
      objectPath: '../../foreign-object'
    }).success,
    false
  );
});

test('attachment intent enforces kind, MIME, and decimal-byte caps', () => {
  const base = {
    clientAttachmentId: '25bad8c5-ded7-407e-86cf-96fb656aa48d',
    kind: 'image' as const,
    contentType: 'image/jpeg',
    sizeBytes: 1000
  };
  assert.equal(CreateBookingAttachmentIntentSchema.safeParse({ ...base, contentType: 'image/svg+xml' }).success, false);
  assert.equal(CreateBookingAttachmentIntentSchema.safeParse({ ...base, contentType: 'video/mp4' }).success, false);
  assert.equal(CreateBookingAttachmentIntentSchema.safeParse({ ...base, sizeBytes: 10_000_001 }).success, false);
  assert.equal(
    CreateBookingAttachmentIntentSchema.safeParse({
      ...base,
      kind: 'video',
      contentType: 'video/mp4',
      sizeBytes: 45_000_001
    }).success,
    false
  );
});

test('server object paths contain only the generated UUID and allowlisted extension', () => {
  const id = '03b6cc48-96e8-4a68-ae9b-2ee826745c2c';
  assert.equal(createBookingMediaObjectPath(id, 'image/jpeg'), `v1/03/${id}.jpg`);
  assert.equal(createBookingMediaObjectPath(id, 'video/quicktime'), `v1/03/${id}.mov`);
});

test('upload transport switches above the fixed 6 MiB threshold', () => {
  assert.equal(STANDARD_UPLOAD_MAX_BYTES, 6_291_456);
  assert.equal(TUS_CHUNK_SIZE_BYTES, 6_291_456);
  assert.equal(uploadMethodForSize(STANDARD_UPLOAD_MAX_BYTES), 'signed_put');
  assert.equal(uploadMethodForSize(STANDARD_UPLOAD_MAX_BYTES + 1), 'tus');
});

test('TUS endpoint prefers the direct Supabase Storage hostname', () => {
  assert.equal(
    deriveTusEndpoint('https://project-ref.supabase.co'),
    'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign'
  );
  assert.equal(
    deriveTusEndpoint('https://storage.example.test/base'),
    'https://storage.example.test/storage/v1/upload/resumable/sign'
  );
});

test('media signatures reject HTML disguised with an allowlisted MIME type', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');

  assert.equal(hasExpectedMediaSignature('image/jpeg', jpeg), true);
  assert.equal(hasExpectedMediaSignature('image/png', png), true);
  assert.equal(hasExpectedMediaSignature('image/webp', Buffer.from('RIFF0000WEBPVP8 ')), true);
  assert.equal(hasExpectedMediaSignature('video/mp4', ftypBox('isom')), true);
  assert.equal(hasExpectedMediaSignature('video/quicktime', ftypBox('qt  ')), true);
  assert.equal(hasExpectedMediaSignature('image/jpeg', Buffer.from('<html>not an image</html>')), false);
  assert.equal(hasExpectedMediaSignature('video/mp4', ftypBox('qt  ')), false);
});

test('media signature checks reject truncated and polyglot-like header stubs', () => {
  assert.equal(hasExpectedMediaSignature('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff])), false);
  assert.equal(
    hasExpectedMediaSignature(
      'image/jpeg',
      Uint8Array.from([0xff, 0xd8, 0xff, 0x3c, 0, 16, 0x68, 0x74, 0x6d, 0x6c, 0, 0])
    ),
    false
  );
  assert.equal(hasExpectedMediaSignature('image/png', Buffer.from('\x89PNG\r\n\x1a\n<html>')), false);
  assert.equal(hasExpectedMediaSignature('image/webp', Buffer.from('RIFF0000WEBPHTML')), false);
  assert.equal(hasExpectedMediaSignature('video/mp4', Buffer.from('0000ftyp')), false);
  assert.equal(hasExpectedMediaSignature('video/mp4', ftypBox('evil')), false);
  assert.equal(hasExpectedMediaSignature('video/mp4', ftypBox('isom', 'HTML')), false);
  const truncatedBox = ftypBox('isom');
  truncatedBox.writeUInt32BE(truncatedBox.length + 4, 0);
  assert.equal(hasExpectedMediaSignature('video/mp4', truncatedBox), false);
});

test('completion accepts only explicit zero or no-store object cache policies', () => {
  for (const policy of ['0', 'max-age=0', 'no-store', 'max-age=0, s-maxage=0', 'no-store, max-age=0']) {
    assert.equal(isNonCacheableStoragePolicy(policy), true, policy);
  }
  for (const policy of [undefined, '', '3600', 'max-age=3600', 's-maxage=60', 'private', 'max-age=0, immutable']) {
    assert.equal(isNonCacheableStoragePolicy(policy), false, String(policy));
  }
});

test('signature inspection refuses unbounded responses and caps streamed bytes', async () => {
  assert.doesNotThrow(() => assertStoragePrefixResponseIsBounded(206, 4096, 45_000_000));
  assert.doesNotThrow(() => assertStoragePrefixResponseIsBounded(200, 1000, 1000));
  assert.throws(() => assertStoragePrefixResponseIsBounded(200, 0, 4097), /bounded range/);
  assert.throws(() => assertStoragePrefixResponseIsBounded(206, 4097, 45_000_000), /bounded range/);

  const small = await readBoundedResponseBody(new Response(Uint8Array.from([1, 2, 3])), 3);
  assert.deepEqual([...small], [1, 2, 3]);
  await assert.rejects(
    () => readBoundedResponseBody(new Response(new Uint8Array(4097)), 4096),
    /validation limit/
  );
});

test('stable client attachment IDs reject metadata changes and ready retries', () => {
  assert.doesNotThrow(() =>
    assertReusableAttachmentIntent(attachment(), {
      ownerUserId: 'user-1',
      kind: 'image',
      contentType: 'image/jpeg',
      sizeBytes: 1000
    })
  );

  for (const row of [attachment({ declared_size_bytes: 999 }), attachment({ status: 'ready' })]) {
    assert.throws(
      () =>
        assertReusableAttachmentIntent(row, {
          ownerUserId: 'user-1',
          kind: 'image',
          contentType: 'image/jpeg',
          sizeBytes: 1000
        }),
      (error: unknown) => error instanceof HttpError && error.status === 409
    );
  }
});

test('customer completion is locked after cancellation or completion', () => {
  assert.doesNotThrow(() => assertBookingMediaEditable('pending', 'completed for'));
  for (const status of ['취소', 'cancelled', '완료', 'completed']) {
    assert.throws(
      () => assertBookingMediaEditable(status, 'completed for'),
      (error: unknown) => error instanceof HttpError && error.code === 'BOOKING_MEDIA_LOCKED'
    );
  }
});

test('attachment responses never expose bucket names, object paths, or Storage tokens', () => {
  const response = toAttachmentResponse(attachment({ status: 'ready', actual_size_bytes: 1000 }));
  assert.equal('bucketId' in response, false);
  assert.equal('objectPath' in response, false);
  assert.equal('uploadToken' in response, false);
  assert.equal('downloadUrl' in response, false);
  assert.equal('downloadUrlExpiresAt' in response, false);
  assert.equal(response.bookingId, 'booking-1');
  assert.equal(response.clientAttachmentId, '25bad8c5-ded7-407e-86cf-96fb656aa48d');
});

test('deletion tombstones remain until the Storage write window closes', () => {
  assert.equal(
    Date.parse(storageWriteExpiryIso(Date.parse('2030-01-01T00:00:00Z'))),
    Date.parse('2030-01-02T02:05:00Z')
  );
  assert.equal(isStorageWriteWindowClosed('2030-01-01T02:05:00.000Z', Date.parse('2030-01-01T02:04:59Z')), false);
  assert.equal(isStorageWriteWindowClosed('2030-01-01T02:05:00.000Z', Date.parse('2030-01-01T02:05:00Z')), true);
});

test('a hidden tombstone reports temporary quota capacity with a conservative retry time', () => {
  const details = attachmentLimitDetails(
    [
      ...Array.from({ length: 5 }, () =>
        attachment({ status: 'ready', write_expires_at: '2030-01-01T01:00:00Z' })
      ),
      attachment({ status: 'deleting', write_expires_at: '2030-01-02T02:05:00Z' })
    ],
    { kind: 'image', sizeBytes: 1000 }
  );
  assert.deepEqual(details, {
    reason: 'write_capability_tombstones',
    retryAfter: '2030-01-02T02:05:00.000Z',
    reconcileRequired: true
  });
});

test('completion cannot overwrite a concurrently extended write reservation', () => {
  const extendedWriteExpiry = '2030-01-03T02:05:00.000Z';
  const patch = buildCompletedAttachmentPatch(
    { size: 1000, contentType: 'image/jpeg', cacheControl: 'max-age=0', etag: 'etag-1' },
    '2030-01-01T00:01:00Z'
  );
  assert.equal('write_expires_at' in patch, false);
  const completedAfterRetry = { ...attachment({ write_expires_at: extendedWriteExpiry }), ...patch };
  assert.equal(completedAfterRetry.write_expires_at, extendedWriteExpiry);
});

test('destructive deletion never runs when media purge fails', async () => {
  let deleted = false;
  await assert.rejects(() =>
    purgeMediaBeforeDestructiveDelete(
      async () => {
        throw new Error('storage unavailable');
      },
      async () => {
        deleted = true;
      }
    )
  );
  assert.equal(deleted, false);
});

test('Kakao account erasure fails closed before purge, unlink, or Auth deletion', () => {
  const source = fs.readFileSync('src/modules/integrations/kakao/kakao.controller.ts', 'utf8');
  const start = source.indexOf('export async function deleteKakaoAccount');
  const end = source.indexOf('async function kakaoFetch', start);
  const deletion = source.slice(start, end);
  assert.match(deletion, /ACCOUNT_DELETION_UNAVAILABLE/);
  assert.doesNotMatch(deletion, /purgeAttachmentsForUser|user\/unlink|auth\.admin\.deleteUser/);
  assert.doesNotMatch(source, /bookingAttachment\.service|purgeAttachmentsForUser/);
});

test('logger redacts every media capability field', () => {
  for (const path of [
    '*.signedUrl',
    '*.*.signedUrl',
    '*.uploadToken',
    '*.*.upload_token',
    '*.storageApiKey',
    '*.*.storage_api_key',
    '*.downloadUrl',
    '*.*.download_url',
    '*.xSignature',
    'req.headers["x-signature"]'
  ]) {
    assert.ok(LOGGER_REDACTIONS.includes(path));
  }
});

test('migration serializes media lifecycle races and closes direct Storage access', () => {
  const sql = fs.readFileSync('database/migrations/007_booking_attachments.sql', 'utf8');
  assert.match(sql, /on delete restrict/i);
  assert.match(sql, /at most 6 attachments/i);
  assert.match(sql, /at most 2 video attachments/i);
  assert.match(sql, /100000000 bytes/i);
  assert.match(sql, /revoke all on table public\.booking_attachments from anon, authenticated/i);
  assert.match(sql, /grant all on table public\.booking_attachments to service_role/i);
  assert.match(sql, /grant execute on function public\.enforce_booking_attachment_limits\(\) to service_role/i);
  assert.match(sql, /owner_reserved_count\s*>=\s*12/i);
  assert.match(sql, /owner_reserved_bytes\s*\+\s*new\.declared_size_bytes\s*>\s*100000000/i);
  assert.match(sql, /pg_advisory_xact_lock\([\s\S]*booking-media-owner:/i);
  assert.match(sql, /create table if not exists public\.booking_media_limits/i);
  assert.match(sql, /values \('default', 100, 500000000\)/i);
  const projectLock = sql.indexOf("hashtextextended('booking-media-project'");
  const ownerLock = sql.indexOf("hashtextextended('booking-media-owner:");
  assert.ok(projectLock >= 0 && ownerLock > projectLock);
  assert.match(sql, /PROJECT_MEDIA_LIMIT_REACHED/);
  assert.match(sql, /revoke all on table public\.booking_media_limits from anon, authenticated/i);
  assert.match(sql, /refresh_booking_attachment_capability[\s\S]*greatest\([\s\S]*clock_timestamp\(\)[\s\S]*status = 'pending'/i);
  assert.match(sql, /claim_expired_booking_attachment[\s\S]*write_expires_at = p_observed_write_expires_at[\s\S]*write_expires_at <= clock_timestamp\(\)/i);
  assert.match(sql, /delete_expired_booking_attachment[\s\S]*status = 'deleting'[\s\S]*write_expires_at = p_observed_write_expires_at[\s\S]*write_expires_at <= clock_timestamp\(\)/i);
  assert.match(sql, /enforce_booking_attachment_editable_state[\s\S]*for update/i);
  assert.match(sql, /claim_owned_booking_attachment_deletion[\s\S]*for update/i);
  assert.match(sql, /create policy shc_booking_media_deny_direct_client_access[\s\S]*as restrictive[\s\S]*to anon, authenticated/i);
  assert.match(sql, /using \(bucket_id not in \('shc-booking-images-v1', 'shc-booking-videos-v1'\)\)/i);
  assert.ok(sql.includes(BOOKING_IMAGE_BUCKET));
  assert.ok(sql.includes(BOOKING_VIDEO_BUCKET));
});

test('service preserves reservations on signing failure and uses claimed current rows for cleanup', () => {
  const source = fs.readFileSync('src/modules/bookingAttachments/bookingAttachment.service.ts', 'utf8');
  const signFailureStart = source.indexOf('if (signed.error || !signed.data)');
  const signFailureEnd = source.indexOf('\n  return {', signFailureStart);
  const signFailureBlock = source.slice(signFailureStart, signFailureEnd);
  assert.match(signFailureBlock, /markUploadSigningFailure\(row\.id\)/);
  assert.match(source, /markUploadSigningFailure[\s\S]*failure_code: 'UPLOAD_SIGNING_FAILED'/);
  assert.doesNotMatch(signFailureBlock, /\.delete\(/);
  assert.match(source, /\.update\(buildCompletedAttachmentPatch\(info, completedAt\)\)/);
  assert.match(source, /const claimed = \(claimedData \?\? \[\]\)/);
  assert.match(source, /deleteClaimedAttachment\(claimed\)/);
  assert.match(source, /p_observed_write_expires_at: observed\.write_expires_at/);
  assert.match(source, /PROJECT_MEDIA_LIMIT_REACHED/);
  const signCall = source.indexOf('createSignedUploadUrl(row.object_path');
  const postSignRegistration = source.indexOf(".rpc('refresh_booking_attachment_capability'", signCall);
  const capabilityReturn = source.indexOf('uploadToken: signed.data.token', signCall);
  assert.ok(signCall >= 0 && postSignRegistration > signCall && capabilityReturn > postSignRegistration);
  assert.match(source.slice(postSignRegistration, capabilityReturn), /if \(!registered\)/);
  const responseStart = source.indexOf('storageApiKey:');
  const responseEnd = source.indexOf('chunkSizeBytes:', responseStart);
  const publicKeyBlock = source.slice(responseStart, responseEnd);
  assert.match(publicKeyBlock, /SUPABASE_PUBLISHABLE_KEY/);
  assert.match(publicKeyBlock, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(publicKeyBlock, /SECRET|SERVICE_ROLE/);
});

test('post-sign registration uses a deadline below grace and extends from database time', () => {
  assert.equal(SIGNED_UPLOAD_REQUEST_TIMEOUT_MS, 30_000);
  assert.ok(SIGNED_UPLOAD_REQUEST_TIMEOUT_MS < STORAGE_WRITE_EXPIRY_GRACE_SECONDS * 1000);
  const sql = fs.readFileSync('database/migrations/007_booking_attachments.sql', 'utf8');
  const refreshStart = sql.indexOf('create or replace function public.refresh_booking_attachment_capability');
  const refreshEnd = sql.indexOf('$$;', refreshStart);
  const refresh = sql.slice(refreshStart, refreshEnd);
  assert.match(refresh, /upload_expires_at = greatest\([\s\S]*clock_timestamp\(\) \+ interval '2 hours'/);
  assert.match(refresh, /write_expires_at = greatest\([\s\S]*clock_timestamp\(\) \+ interval '26 hours 5 minutes'/);
  assert.match(refresh, /attachments\.status = 'pending'/);
});

test('upload-intent limiter runs after authentication and is user-keyed', () => {
  assert.equal(BOOKING_ATTACHMENT_INTENT_RATE_LIMIT, 12);
  assert.equal(BOOKING_ATTACHMENT_INTENT_RATE_WINDOW_MS, 60_000);
  assert.equal(MAX_USER_MEDIA_RESERVATIONS, 12);
  assert.equal(MAX_USER_MEDIA_RESERVED_BYTES, 100_000_000);
  const route = fs.readFileSync('src/modules/bookings/booking.routes.ts', 'utf8');
  const intent = route.slice(route.indexOf("'/:bookingId/attachments/upload-intents'"), route.indexOf(');', route.indexOf("'/:bookingId/attachments/upload-intents'")));
  assert.ok(intent.indexOf('requireAuth') < intent.indexOf('bookingAttachmentIntentLimiter'));
  const limiter = fs.readFileSync('src/modules/bookingAttachments/bookingAttachment.middleware.ts', 'utf8');
  assert.match(limiter, /keyGenerator: \(req\) => req\.user!\.id/);
});

test('video and resumable upload intents are default-off pilot features', () => {
  const source = fs.readFileSync('src/modules/bookingAttachments/bookingAttachment.service.ts', 'utf8');
  const gate = source.indexOf('!env.ENABLE_BOOKING_MEDIA_PILOT_UPLOADS');
  const databaseLookup = source.indexOf(".from('booking_attachments')");
  assert.ok(gate >= 0 && gate < databaseLookup);
  assert.match(source.slice(gate, databaseLookup), /input\.kind === 'video'/);
  assert.match(source.slice(gate, databaseLookup), /uploadMethod === 'tus'/);
  assert.match(source.slice(gate, databaseLookup), /BOOKING_MEDIA_PILOT_DISABLED/);
});

test('database border verifier checks media triggers and function grants', () => {
  const verifier = fs.readFileSync('scripts/verifyDatabaseBorder.mjs', 'utf8');
  assert.match(verifier, /booking_attachments_enforce_limits/);
  assert.match(verifier, /booking_attachments_enforce_editable_state/);
  assert.match(verifier, /triggers\.tgenabled <> 'D'/);
  assert.match(verifier, /has_function_privilege\('anon'/);
  assert.match(verifier, /has_function_privilege\('authenticated'/);
  assert.match(verifier, /not has_function_privilege\('service_role'/);
  assert.match(verifier, /has_table_privilege\('anon', 'public\.booking_media_limits', 'SELECT'\)/);
});

test('attachment lists remain metadata-only and admin audit does not claim signing', () => {
  const service = fs.readFileSync('src/modules/bookingAttachments/bookingAttachment.service.ts', 'utf8');
  const listStart = service.indexOf('export async function listBookingAttachments');
  const listEnd = service.indexOf('export async function getAttachmentDownloadUrl', listStart);
  assert.doesNotMatch(service.slice(listStart, listEnd), /signAttachmentDownload/);
  const controller = fs.readFileSync('src/modules/bookingAttachments/bookingAttachment.controller.ts', 'utf8');
  assert.match(controller, /'media_list'/);
  assert.doesNotMatch(controller, /media_list_signed/);
});

function ftypBox(majorBrand: string, compatibleBrand = majorBrand) {
  const box = Buffer.alloc(20);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(majorBrand, 8, 'ascii');
  box.writeUInt32BE(0, 12);
  box.write(compatibleBrand, 16, 'ascii');
  return box;
}
