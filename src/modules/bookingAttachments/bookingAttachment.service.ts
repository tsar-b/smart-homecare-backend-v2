import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/errors.js';
import { env } from '../../core/env.js';
import { logger } from '../../core/logger.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import {
  MAX_BOOKING_ATTACHMENTS,
  MAX_BOOKING_ATTACHMENT_BYTES,
  MAX_BOOKING_VIDEOS,
  MAX_USER_MEDIA_RESERVATIONS,
  MAX_USER_MEDIA_RESERVED_BYTES,
  SIGNED_DOWNLOAD_TTL_SECONDS,
  SIGNED_UPLOAD_REQUEST_TIMEOUT_MS,
  SIGNED_UPLOAD_TTL_SECONDS,
  STORAGE_WRITE_EXPIRY_GRACE_SECONDS,
  TUS_CHUNK_SIZE_BYTES,
  TUS_WRITE_TTL_SECONDS,
  createBookingMediaObjectPath,
  deriveTusEndpoint,
  mediaBucketForKind,
  mediaKindForContentType,
  normalizeMediaContentType,
  uploadMethodForSize,
  type BookingAttachmentStatus,
  type BookingMediaKind
} from './bookingAttachment.constants.js';

const EDITABLE_BOOKING_STATUSES = ['대기', '확정', 'pending', 'confirmed', 'approved'];
const ATTACHMENT_COLUMNS =
  'id, client_attachment_id, booking_id, owner_user_id, bucket_id, object_path, media_kind, mime_type, declared_size_bytes, actual_size_bytes, status, storage_etag, upload_expires_at, write_expires_at, completed_at, failure_code, created_at, updated_at';

export type BookingAttachmentRow = {
  id: string;
  client_attachment_id: string;
  booking_id: string;
  owner_user_id: string;
  bucket_id: string;
  object_path: string;
  media_kind: BookingMediaKind;
  mime_type: string;
  declared_size_bytes: number;
  actual_size_bytes: number | null;
  status: BookingAttachmentStatus;
  storage_etag: string | null;
  upload_expires_at: string;
  write_expires_at: string;
  completed_at: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

type BookingAccess = { type: 'owner'; userId: string } | { type: 'admin' };

type CreateAttachmentIntentInput = {
  bookingId: string;
  ownerUserId: string;
  clientAttachmentId: string;
  kind: BookingMediaKind;
  contentType: string;
  sizeBytes: number;
};

type BookingRow = { id: string; user_id: string; status: string };

export async function createAttachmentIntent(input: CreateAttachmentIntentInput) {
  const booking = await loadBooking(input.bookingId, { type: 'owner', userId: input.ownerUserId });
  assertBookingMediaEditable(booking.status, 'added to');

  const contentType = normalizeMediaContentType(input.contentType);
  if (mediaKindForContentType(contentType) !== input.kind) {
    throw new HttpError(400, 'Media kind does not match content type', 'MEDIA_TYPE_INVALID');
  }
  const uploadMethod = uploadMethodForSize(input.sizeBytes);
  if (
    !env.ENABLE_BOOKING_MEDIA_PILOT_UPLOADS &&
    (input.kind === 'video' || uploadMethod === 'tus')
  ) {
    throw new HttpError(
      503,
      'Video and resumable media uploads are limited to the trusted booking-media pilot',
      'BOOKING_MEDIA_PILOT_DISABLED'
    );
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('booking_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('booking_id', booking.id)
    .eq('client_attachment_id', input.clientAttachmentId)
    .maybeSingle();
  if (existingError) throw storageDatabaseError('Unable to inspect attachment retry', existingError);

  let row = existing as BookingAttachmentRow | null;
  let created = false;

  if (row) {
    assertReusableAttachmentIntent(row, {
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      contentType,
      sizeBytes: input.sizeBytes
    });
  } else {
    const id = randomUUID();
    const bucketId = mediaBucketForKind(input.kind);
    const objectPath = createBookingMediaObjectPath(id, contentType);
    const uploadExpiresAt = uploadExpiryIso();
    const writeExpiresAt = storageWriteExpiryIso();
    const { data, error } = await supabaseAdmin
      .from('booking_attachments')
      .insert({
        id,
        client_attachment_id: input.clientAttachmentId,
        booking_id: booking.id,
        owner_user_id: input.ownerUserId,
        bucket_id: bucketId,
        object_path: objectPath,
        media_kind: input.kind,
        mime_type: contentType,
        declared_size_bytes: input.sizeBytes,
        upload_expires_at: uploadExpiresAt,
        write_expires_at: writeExpiresAt,
        status: 'pending'
      })
      .select(ATTACHMENT_COLUMNS)
      .single();

    if (error?.code === '23505') {
      return createAttachmentIntent(input);
    }
    if (isBookingMediaLockedDatabaseError(error)) {
      throw new HttpError(409, 'Media cannot be added to this booking', 'BOOKING_MEDIA_LOCKED');
    }
    if (isProjectMediaLimitDatabaseError(error)) {
      throw await projectMediaLimitError();
    }
    if (isUserMediaLimitDatabaseError(error)) {
      throw new HttpError(
        409,
        'User media reservation limits were reached',
        'USER_MEDIA_LIMIT_REACHED',
        { maxReservedRows: MAX_USER_MEDIA_RESERVATIONS, maxReservedBytes: MAX_USER_MEDIA_RESERVED_BYTES }
      );
    }
    if (error?.code === '23514') {
      throw await bookingAttachmentLimitError(booking.id, input.kind, input.sizeBytes);
    }
    if (error || !data) throw storageDatabaseError('Unable to create attachment intent', error);
    row = data as BookingAttachmentRow;
    created = true;
  }

  if (!created && row.status === 'pending') {
    const { data, error } = await supabaseAdmin
      .rpc('refresh_booking_attachment_capability', { p_attachment_id: row.id })
      .maybeSingle();
    if (isBookingMediaLockedDatabaseError(error)) {
      throw new HttpError(409, 'Media cannot be added to this booking', 'BOOKING_MEDIA_LOCKED');
    }
    if (error) throw storageDatabaseError('Unable to refresh attachment intent', error);
    if (!data) {
      const latest = await loadAttachment(booking.id, row.id);
      if (!latest) {
        throw new HttpError(409, 'Attachment is no longer uploadable', 'ATTACHMENT_NOT_UPLOADABLE');
      }
      assertReusableAttachmentIntent(latest, {
        ownerUserId: input.ownerUserId,
        kind: input.kind,
        contentType,
        sizeBytes: input.sizeBytes
      });
      throw new HttpError(409, 'Attachment state changed during retry', 'ATTACHMENT_STATE_CONFLICT');
    }
    row = data as BookingAttachmentRow;
  }

  let signed: Awaited<ReturnType<ReturnType<typeof supabaseAdmin.storage.from>['createSignedUploadUrl']>>;
  try {
    signed = await withDeadline(
      supabaseAdmin.storage.from(row.bucket_id).createSignedUploadUrl(row.object_path, { upsert: false }),
      SIGNED_UPLOAD_REQUEST_TIMEOUT_MS
    );
  } catch (error) {
    await markUploadSigningFailure(row.id);
    logger.error({ attachmentId: row.id, error }, 'Booking media upload signing timed out or failed');
    throw new HttpError(503, 'Media storage is unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
  }
  if (signed.error || !signed.data) {
    // Keep the reservation until its write window expires. A duplicate request
    // may have refreshed and signed this same stable row while this Storage
    // request failed; deleting metadata here would orphan that live capability.
    await markUploadSigningFailure(row.id);
    logger.error({ attachmentId: row.id, error: signed.error }, 'Unable to sign booking media upload');
    throw new HttpError(503, 'Media storage is unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
  }

  // Register the capability using database time only after Storage has minted
  // it. If completion/deletion/cancellation won while the network call was in
  // flight, this returns no row (or BOOKING_MEDIA_LOCKED) and the token is
  // deliberately withheld from the caller. A successful registration makes
  // the tombstone horizon conservative from actual sign completion time.
  const { data: registered, error: registerError } = await supabaseAdmin
    .rpc('refresh_booking_attachment_capability', { p_attachment_id: row.id })
    .maybeSingle();
  if (isBookingMediaLockedDatabaseError(registerError)) {
    throw new HttpError(409, 'Media cannot be added to this booking', 'BOOKING_MEDIA_LOCKED');
  }
  if (registerError) throw storageDatabaseError('Unable to register attachment capability', registerError);
  if (!registered) {
    const latest = await loadAttachment(booking.id, row.id);
    if (!latest) throw new HttpError(409, 'Attachment is no longer uploadable', 'ATTACHMENT_NOT_UPLOADABLE');
    assertReusableAttachmentIntent(latest, {
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      contentType,
      sizeBytes: input.sizeBytes
    });
    throw new HttpError(409, 'Attachment state changed while signing', 'ATTACHMENT_STATE_CONFLICT');
  }
  row = registered as BookingAttachmentRow;

  return {
    created,
    body: {
      attachment: toAttachmentResponse(row),
      uploadMethod,
      signedUrl: uploadMethod === 'signed_put' ? signed.data.signedUrl : null,
      tusEndpoint: uploadMethod === 'tus' ? deriveTusEndpoint(env.SUPABASE_URL) : null,
      uploadToken: signed.data.token,
      storageApiKey:
        uploadMethod === 'tus'
          ? (env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY)
          : null,
      chunkSizeBytes: TUS_CHUNK_SIZE_BYTES,
      expiresAt: row.upload_expires_at,
      bucketId: row.bucket_id,
      objectPath: row.object_path
    }
  };
}

export async function completeAttachment(bookingId: string, attachmentId: string, access: BookingAccess) {
  const booking = await loadBooking(bookingId, access);
  const row = await loadAttachment(bookingId, attachmentId);
  if (!row) throw new HttpError(404, 'Attachment not found', 'ATTACHMENT_NOT_FOUND');
  if (row.status === 'ready') return toAttachmentResponse(row);
  if (row.status !== 'pending') {
    throw new HttpError(409, 'Attachment cannot be completed in its current state', 'ATTACHMENT_NOT_COMPLETABLE');
  }
  if (access.type === 'owner') assertBookingMediaEditable(booking.status, 'completed for');

  return completePendingRow(
    row,
    undefined,
    access.type === 'owner'
      ? async () => {
          const latestBooking = await loadBooking(bookingId, access);
          assertBookingMediaEditable(latestBooking.status, 'completed for');
        }
      : undefined
  );
}

export async function listBookingAttachments(bookingId: string, access: BookingAccess) {
  await loadBooking(bookingId, access);
  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('booking_id', bookingId)
    .in('status', ['pending', 'ready'])
    .order('created_at', { ascending: true });
  if (error) throw storageDatabaseError('Unable to load booking attachments', error);

  return ((data ?? []) as BookingAttachmentRow[]).map((row) => toAttachmentResponse(row));
}

export async function getAttachmentDownloadUrl(bookingId: string, attachmentId: string, access: BookingAccess) {
  await loadBooking(bookingId, access);
  const row = await loadAttachment(bookingId, attachmentId);
  if (!row || row.status !== 'ready') {
    throw new HttpError(404, 'Ready attachment not found', 'ATTACHMENT_NOT_FOUND');
  }
  return signAttachmentDownload(row);
}

export async function deleteBookingAttachment(bookingId: string, attachmentId: string, access: BookingAccess) {
  const booking = await loadBooking(bookingId, access);
  if (access.type === 'owner') assertBookingMediaEditable(booking.status, 'deleted from');
  const row = await loadAttachment(bookingId, attachmentId);
  if (!row) return;
  if (access.type === 'owner') {
    const latestBooking = await loadBooking(bookingId, access);
    assertBookingMediaEditable(latestBooking.status, 'deleted from');
  }
  await deleteAttachmentRow(row, access.type === 'owner' ? access.userId : undefined);
}

export async function purgeAttachmentsForBooking(bookingId: string) {
  const rows = await loadAttachmentsForPurge('booking_id', bookingId);
  await purgeAttachmentRows(rows);
}

export async function purgeAttachmentsForUser(ownerUserId: string) {
  const rows = await loadAttachmentsForPurge('owner_user_id', ownerUserId);
  await purgeAttachmentRows(rows);
}

export async function reconcileBookingAttachments(limit = 100) {
  const now = new Date().toISOString();
  const [{ data: expired, error: expiredError }, { data: cleanup, error: cleanupError }] = await Promise.all([
    supabaseAdmin
      .from('booking_attachments')
      .select(ATTACHMENT_COLUMNS)
      .eq('status', 'pending')
      .lt('write_expires_at', now)
      .order('write_expires_at', { ascending: true })
      .limit(limit),
    supabaseAdmin
      .from('booking_attachments')
      .select(ATTACHMENT_COLUMNS)
      .in('status', ['deleting', 'rejected'])
      .order('updated_at', { ascending: true })
      .limit(limit)
  ]);
  if (expiredError || cleanupError) {
    throw storageDatabaseError('Unable to load attachment reconciliation queue', expiredError ?? cleanupError);
  }

  const result = { removed: 0, retained: 0, skipped: 0, failed: 0 };
  for (const observed of (expired ?? []) as BookingAttachmentRow[]) {
    try {
      const claimed = await claimExpiredPendingAttachment(observed);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }
      const removed = await deleteClaimedAttachment(claimed);
      result[removed ? 'removed' : 'retained'] += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn({ attachmentId: observed.id, error }, 'Expired booking attachment reconciliation failed');
    }
  }

  for (const row of (cleanup ?? []) as BookingAttachmentRow[]) {
    try {
      const removed = await deleteAttachmentRow(row);
      result[removed ? 'removed' : 'retained'] += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn({ attachmentId: row.id, error }, 'Booking attachment cleanup retry failed');
    }
  }
  return result;
}

export function toAttachmentResponse(row: BookingAttachmentRow) {
  return {
    id: row.id,
    clientAttachmentId: row.client_attachment_id,
    bookingId: row.booking_id,
    kind: row.media_kind,
    contentType: row.mime_type,
    sizeBytes: Number(row.actual_size_bytes ?? row.declared_size_bytes),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export function hasExpectedMediaSignature(contentType: string, bytes: Uint8Array) {
  const mime = normalizeMediaContentType(contentType);
  if (mime === 'image/jpeg') {
    if (bytes.length < 12 || !startsWith(bytes, [0xff, 0xd8, 0xff])) return false;
    const marker = bytes[3];
    const segmentLength = readUint16(bytes, 4);
    const allowedFirstMarker =
      marker === 0xdb ||
      marker === 0xfe ||
      (marker >= 0xe0 && marker <= 0xef) ||
      (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
    return allowedFirstMarker && segmentLength >= 2;
  }
  if (mime === 'image/png') {
    return (
      bytes.length >= 24 &&
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      readUint32(bytes, 8) === 13 &&
      ascii(bytes, 12, 4) === 'IHDR'
    );
  }
  if (mime === 'image/webp') {
    return (
      bytes.length >= 16 &&
      ascii(bytes, 0, 4) === 'RIFF' &&
      ascii(bytes, 8, 4) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4))
    );
  }
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return false;
    const boxSize = readUint32(bytes, 0);
    if (boxSize < 16 || boxSize > bytes.length || (boxSize - 16) % 4 !== 0) return false;
    const brand = ascii(bytes, 8, 4);
    const allowedBrands = mime === 'video/quicktime' ? QUICKTIME_BRANDS : MP4_MAJOR_BRANDS;
    if (!allowedBrands.has(brand)) return false;
    for (let offset = 16; offset < boxSize; offset += 4) {
      if (!allowedBrands.has(ascii(bytes, offset, 4))) return false;
    }
    return true;
  }
  return false;
}

export function isNonCacheableStoragePolicy(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '0') return true;
  const directives = normalized.split(',').map((directive) => directive.trim()).filter(Boolean);
  if (!directives.length) return false;
  const allowed = new Set(['max-age=0', 's-maxage=0', 'no-store']);
  return directives.every((directive) => allowed.has(directive)) &&
    directives.some((directive) => directive === 'max-age=0' || directive === 'no-store');
}

export function assertBookingMediaEditable(status: string, action = 'added to') {
  if (!EDITABLE_BOOKING_STATUSES.includes(status)) {
    throw new HttpError(409, `Media cannot be ${action} this booking`, 'BOOKING_MEDIA_LOCKED');
  }
}

export function assertReusableAttachmentIntent(
  row: Pick<
    BookingAttachmentRow,
    'owner_user_id' | 'media_kind' | 'mime_type' | 'declared_size_bytes' | 'status'
  >,
  input: { ownerUserId: string; kind: BookingMediaKind; contentType: string; sizeBytes: number }
) {
  if (
    row.owner_user_id !== input.ownerUserId ||
    row.media_kind !== input.kind ||
    row.mime_type !== input.contentType ||
    Number(row.declared_size_bytes) !== input.sizeBytes
  ) {
    throw new HttpError(
      409,
      'clientAttachmentId was already used for different media',
      'ATTACHMENT_IDEMPOTENCY_CONFLICT'
    );
  }
  if (row.status === 'deleting' || row.status === 'rejected') {
    throw new HttpError(409, 'Attachment cannot be uploaded in its current state', 'ATTACHMENT_NOT_UPLOADABLE');
  }
  if (row.status === 'ready') {
    throw new HttpError(409, 'Attachment is already complete', 'ATTACHMENT_ALREADY_COMPLETE');
  }
}

export async function writeBookingAttachmentAudit(
  actorId: string,
  rowId: string,
  action: 'media_list' | 'media_download_signed' | 'media_delete',
  patch?: { bookingId: string; attachmentCount?: number }
) {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    actor_id: actorId,
    table_name: 'booking_attachments',
    row_id: rowId,
    action,
    patch: patch ?? null
  });
  if (error) logger.warn({ actorId, rowId, action, error }, 'Booking media audit write failed');
}

async function completePendingRow(
  row: BookingAttachmentRow,
  existingInfo?: StorageInfo,
  beforePublish?: () => Promise<void>
) {
  const info = existingInfo ?? (await getStorageInfo(row));
  if (!info) {
    throw new HttpError(409, 'Uploaded media object is not available yet', 'ATTACHMENT_UPLOAD_INCOMPLETE');
  }

  const storedContentType = normalizeMediaContentType(info.contentType ?? '');
  const metadataMatches =
    Number(info.size) === Number(row.declared_size_bytes) &&
    storedContentType === row.mime_type &&
    isNonCacheableStoragePolicy(info.cacheControl);
  let signatureMatches = false;
  if (metadataMatches) {
    try {
      signatureMatches = hasExpectedMediaSignature(row.mime_type, await readStoragePrefix(row));
    } catch (error) {
      logger.warn({ attachmentId: row.id, error }, 'Unable to verify booking media signature');
      throw new HttpError(503, 'Media validation is temporarily unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  if (!metadataMatches || !signatureMatches) {
    await rejectAttachment(row, metadataMatches ? 'SIGNATURE_MISMATCH' : 'METADATA_MISMATCH');
    throw new HttpError(422, 'Uploaded media did not pass validation', 'ATTACHMENT_VALIDATION_FAILED');
  }

  await beforePublish?.();
  const completedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .update(buildCompletedAttachmentPatch(info, completedAt))
    .eq('id', row.id)
    .eq('status', 'pending')
    .select(ATTACHMENT_COLUMNS)
    .maybeSingle();
  if (isBookingMediaLockedDatabaseError(error)) {
    throw new HttpError(409, 'Media cannot be completed for this booking', 'BOOKING_MEDIA_LOCKED');
  }
  if (error) throw storageDatabaseError('Unable to complete attachment', error);
  if (!data) {
    const latest = await loadAttachment(row.booking_id, row.id);
    if (latest?.status === 'ready') return toAttachmentResponse(latest);
    throw new HttpError(409, 'Attachment state changed during completion', 'ATTACHMENT_STATE_CONFLICT');
  }
  return toAttachmentResponse(data as BookingAttachmentRow);
}

type StorageInfo = { size?: number; contentType?: string; cacheControl?: string; etag?: string };
const STORAGE_SIGNATURE_PREFIX_BYTES = 4096;

async function getStorageInfo(row: BookingAttachmentRow): Promise<StorageInfo | null> {
  const { data, error } = await supabaseAdmin.storage.from(row.bucket_id).info(row.object_path);
  if (error) {
    const status = storageErrorStatus(error);
    if (status === 400 || status === 404) return null;
    logger.error({ attachmentId: row.id, error }, 'Unable to inspect booking media object');
    throw new HttpError(503, 'Media storage is unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
  }
  return data as StorageInfo;
}

async function readStoragePrefix(row: BookingAttachmentRow) {
  const { data, error } = await supabaseAdmin.storage.from(row.bucket_id).createSignedUrl(row.object_path, 60);
  if (error || !data) throw new Error('Unable to create validation URL');
  const response = await fetch(data.signedUrl, { headers: { Range: 'bytes=0-4095' } });
  if (!response.ok) throw new Error(`Storage prefix request failed with ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  try {
    assertStoragePrefixResponseIsBounded(response.status, contentLength, row.declared_size_bytes);
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  return readBoundedResponseBody(response, STORAGE_SIGNATURE_PREFIX_BYTES);
}

export function assertStoragePrefixResponseIsBounded(
  responseStatus: number,
  contentLength: number,
  declaredSizeBytes: number
) {
  if (
    contentLength > STORAGE_SIGNATURE_PREFIX_BYTES ||
    (responseStatus !== 206 && declaredSizeBytes > STORAGE_SIGNATURE_PREFIX_BYTES)
  ) {
    throw new Error('Storage did not honor bounded range request');
  }
}

export async function readBoundedResponseBody(response: globalThis.Response, limit: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Storage prefix exceeded validation limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function rejectAttachment(row: BookingAttachmentRow, failureCode: string) {
  const removal = await supabaseAdmin.storage.from(row.bucket_id).remove([row.object_path]);
  const persistedFailure = removal.error ? `${failureCode}_DELETE_PENDING` : failureCode;
  const { error } = await supabaseAdmin
    .from('booking_attachments')
    .update({ status: 'rejected', failure_code: persistedFailure })
    .eq('id', row.id)
    .eq('status', 'pending');
  if (error) logger.error({ attachmentId: row.id, error }, 'Unable to persist rejected attachment state');
  if (removal.error) logger.error({ attachmentId: row.id, error: removal.error }, 'Unable to remove rejected media');
}

async function signAttachmentDownload(row: BookingAttachmentRow) {
  const { data, error } = await supabaseAdmin.storage
    .from(row.bucket_id)
    .createSignedUrl(row.object_path, SIGNED_DOWNLOAD_TTL_SECONDS);
  if (error || !data) {
    logger.error({ attachmentId: row.id, error }, 'Unable to sign booking media download');
    throw new HttpError(503, 'Media storage is unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
  }
  return {
    downloadUrl: data.signedUrl,
    downloadUrlExpiresAt: new Date(Date.now() + SIGNED_DOWNLOAD_TTL_SECONDS * 1000).toISOString()
  };
}

async function deleteAttachmentRow(row: BookingAttachmentRow, ownerUserId?: string) {
  const claimed = await claimAttachmentForDeletion(row.id, ownerUserId);
  if (!claimed) return true;
  return deleteClaimedAttachment(claimed);
}

async function claimAttachmentForDeletion(attachmentId: string, ownerUserId?: string) {
  if (ownerUserId) {
    const { data, error } = await supabaseAdmin
      .rpc('claim_owned_booking_attachment_deletion', {
        p_attachment_id: attachmentId,
        p_owner_user_id: ownerUserId
      })
      .maybeSingle();
    if (isBookingMediaLockedDatabaseError(error)) {
      throw new HttpError(409, 'Media cannot be deleted from this booking', 'BOOKING_MEDIA_LOCKED');
    }
    if (error) throw storageDatabaseError('Unable to begin owned attachment deletion', error);
    return data as BookingAttachmentRow | null;
  }

  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .update({ status: 'deleting', failure_code: null })
    .eq('id', attachmentId)
    .in('status', ['pending', 'ready', 'rejected', 'deleting'])
    .select(ATTACHMENT_COLUMNS)
    .maybeSingle();
  if (error) throw storageDatabaseError('Unable to begin attachment deletion', error);
  return data as BookingAttachmentRow | null;
}

async function claimExpiredPendingAttachment(observed: BookingAttachmentRow) {
  const { data, error } = await supabaseAdmin
    .rpc('claim_expired_booking_attachment', {
      p_attachment_id: observed.id,
      p_observed_write_expires_at: observed.write_expires_at
    })
    .maybeSingle();
  if (error) throw storageDatabaseError('Unable to claim expired attachment', error);
  return data as BookingAttachmentRow | null;
}

async function deleteClaimedAttachment(claimed: BookingAttachmentRow) {
  const { error: storageError } = await supabaseAdmin.storage
    .from(claimed.bucket_id)
    .remove([claimed.object_path]);
  if (storageError) {
    const { error: stateError } = await supabaseAdmin
      .from('booking_attachments')
      .update({ failure_code: 'STORAGE_DELETE_FAILED' })
      .eq('id', claimed.id)
      .eq('status', 'deleting')
      .eq('write_expires_at', claimed.write_expires_at);
    if (stateError) {
      logger.error({ attachmentId: claimed.id, error: stateError }, 'Unable to persist media delete failure');
    }
    logger.error({ attachmentId: claimed.id, error: storageError }, 'Unable to remove booking media object');
    throw new HttpError(503, 'Media deletion is pending', 'ATTACHMENT_DELETE_PENDING');
  }
  return finalizeClaimedAttachmentDeletion(claimed);
}

async function finalizeClaimedAttachmentDeletion(claimed: BookingAttachmentRow) {
  const { data: removed, error: deleteError } = await supabaseAdmin.rpc('delete_expired_booking_attachment', {
    p_attachment_id: claimed.id,
    p_observed_write_expires_at: claimed.write_expires_at
  });
  if (deleteError) throw storageDatabaseError('Unable to finalize attachment deletion', deleteError);
  if (removed) return true;

  const current = await loadAttachmentById(claimed.id);
  if (!current) return true;
  if (current.status !== 'deleting' || current.write_expires_at !== claimed.write_expires_at) {
    throw new HttpError(503, 'Attachment deletion state changed', 'ATTACHMENT_DELETE_PENDING');
  }
  const { error } = await supabaseAdmin
    .from('booking_attachments')
    .update({ failure_code: 'AWAITING_UPLOAD_CAPABILITY_EXPIRY' })
    .eq('id', current.id)
    .eq('status', 'deleting')
    .eq('write_expires_at', current.write_expires_at);
  if (error) throw storageDatabaseError('Unable to retain attachment deletion tombstone', error);
  return false;
}

async function purgeAttachmentRows(rows: BookingAttachmentRow[]) {
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  const { data: claimedData, error: markError } = await supabaseAdmin
    .from('booking_attachments')
    .update({ status: 'deleting', failure_code: null })
    .in('id', ids)
    .in('status', ['pending', 'ready', 'rejected', 'deleting'])
    .select(ATTACHMENT_COLUMNS);
  if (markError) throw storageDatabaseError('Unable to begin media purge', markError);
  const claimed = (claimedData ?? []) as BookingAttachmentRow[];
  if (!claimed.length) return;

  for (const bucketId of [...new Set(claimed.map((row) => row.bucket_id))]) {
    const bucketRows = claimed.filter((row) => row.bucket_id === bucketId);
    const paths = bucketRows.map((row) => row.object_path);
    const { error } = await supabaseAdmin.storage.from(bucketId).remove(paths);
    if (error) {
      const { error: stateError } = await supabaseAdmin
        .from('booking_attachments')
        .update({ failure_code: 'STORAGE_DELETE_FAILED' })
        .in('id', bucketRows.map((row) => row.id))
        .eq('status', 'deleting');
      if (stateError) logger.error({ bucketId, error: stateError }, 'Unable to persist media purge failure');
      logger.error(
        { bucketId, attachmentIds: claimed.map((row) => row.id), error },
        'Unable to purge booking media objects'
      );
      throw new HttpError(503, 'Media deletion is pending', 'ATTACHMENT_DELETE_PENDING');
    }
  }

  const waiting: BookingAttachmentRow[] = [];
  for (const row of claimed) {
    if (!(await finalizeClaimedAttachmentDeletion(row))) waiting.push(row);
  }
  if (waiting.length) {
    const retryAfter = Math.max(...waiting.map((row) => Date.parse(row.write_expires_at)));
    throw new HttpError(
      503,
      'Media deletion is waiting for upload capabilities to expire',
      'ATTACHMENT_PURGE_PENDING',
      { retryAfter: new Date(retryAfter).toISOString() }
    );
  }
}

async function loadAttachmentsForPurge(field: 'booking_id' | 'owner_user_id', value: string) {
  const { data, error } = await supabaseAdmin.from('booking_attachments').select(ATTACHMENT_COLUMNS).eq(field, value);
  if (error) throw storageDatabaseError('Unable to load media purge records', error);
  return (data ?? []) as BookingAttachmentRow[];
}

async function loadBooking(bookingId: string, access: BookingAccess) {
  let query = supabaseAdmin.from('bookings').select('id, user_id, status').eq('id', bookingId);
  if (access.type === 'owner') query = query.eq('user_id', access.userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw storageDatabaseError('Unable to load booking media ownership', error);
  if (!data) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
  return data as BookingRow;
}

async function loadAttachment(bookingId: string, attachmentId: string) {
  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('booking_id', bookingId)
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) throw storageDatabaseError('Unable to load attachment', error);
  return data as BookingAttachmentRow | null;
}

async function loadAttachmentById(attachmentId: string) {
  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) throw storageDatabaseError('Unable to reload attachment deletion state', error);
  return data as BookingAttachmentRow | null;
}

function uploadExpiryIso() {
  return new Date(Date.now() + SIGNED_UPLOAD_TTL_SECONDS * 1000).toISOString();
}

export function storageWriteExpiryIso(now = Date.now()) {
  // A path-bound signed upload token can initiate a TUS session even when the
  // intended client transport is signed PUT. It can be used near the end of
  // its two-hour life to start a TUS session that remains writable for another
  // 24 hours, so preserve that worst-case chain plus clock-skew grace.
  return new Date(
    now + (SIGNED_UPLOAD_TTL_SECONDS + TUS_WRITE_TTL_SECONDS + STORAGE_WRITE_EXPIRY_GRACE_SECONDS) * 1000
  ).toISOString();
}

export function buildCompletedAttachmentPatch(
  info: StorageInfo,
  completedAt: string
) {
  return {
    actual_size_bytes: Number(info.size),
    storage_etag: info.etag ?? null,
    status: 'ready' as const,
    completed_at: completedAt,
    failure_code: null
  };
}

export function isStorageWriteWindowClosed(writeExpiresAt: string, now = Date.now()) {
  return now >= Date.parse(writeExpiresAt);
}

type LimitRow = Pick<BookingAttachmentRow, 'status' | 'media_kind' | 'declared_size_bytes' | 'write_expires_at'>;

export function attachmentLimitDetails(
  rows: LimitRow[],
  input: { kind: BookingMediaKind; sizeBytes: number }
) {
  const active = rows.filter((row) => row.status === 'pending' || row.status === 'ready');
  const tombstones = rows.filter((row) => row.status === 'deleting' || row.status === 'rejected');
  const activeWouldFit =
    active.length + 1 <= MAX_BOOKING_ATTACHMENTS &&
    active.filter((row) => row.media_kind === 'video').length + (input.kind === 'video' ? 1 : 0) <=
      MAX_BOOKING_VIDEOS &&
    active.reduce((total, row) => total + Number(row.declared_size_bytes), 0) + input.sizeBytes <=
      MAX_BOOKING_ATTACHMENT_BYTES;
  if (!activeWouldFit || !tombstones.length) return undefined;

  const retryAfterMs = Math.max(...tombstones.map((row) => Date.parse(row.write_expires_at)));
  return {
    reason: 'write_capability_tombstones',
    retryAfter: new Date(retryAfterMs).toISOString(),
    reconcileRequired: true
  };
}

async function bookingAttachmentLimitError(bookingId: string, kind: BookingMediaKind, sizeBytes: number) {
  const { data, error } = await supabaseAdmin
    .from('booking_attachments')
    .select('status, media_kind, declared_size_bytes, write_expires_at')
    .eq('booking_id', bookingId);
  if (error) {
    logger.warn({ bookingId, error }, 'Unable to describe booking attachment limit');
  }
  const details = error ? undefined : attachmentLimitDetails((data ?? []) as LimitRow[], { kind, sizeBytes });
  return new HttpError(
    409,
    details
      ? 'Attachment capacity is temporarily reserved by recently deleted media'
      : 'Booking attachment limits were reached',
    'ATTACHMENT_LIMIT_REACHED',
    details
  );
}

async function projectMediaLimitError() {
  const { data, error } = await supabaseAdmin
    .from('booking_media_limits')
    .select('max_reserved_rows, max_reserved_bytes')
    .eq('singleton_key', 'default')
    .maybeSingle();
  if (error) logger.warn({ error }, 'Unable to describe project media limit');
  return new HttpError(
    503,
    'Project media capacity is temporarily unavailable',
    'PROJECT_MEDIA_LIMIT_REACHED',
    data
      ? {
          maxReservedRows: Number(data.max_reserved_rows),
          maxReservedBytes: Number(data.max_reserved_bytes)
        }
      : undefined
  );
}

async function markUploadSigningFailure(attachmentId: string) {
  const { error } = await supabaseAdmin
    .from('booking_attachments')
    .update({ failure_code: 'UPLOAD_SIGNING_FAILED' })
    .eq('id', attachmentId)
    .eq('status', 'pending');
  if (error) {
    logger.error({ attachmentId, error }, 'Unable to mark booking media signing failure');
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Storage signing deadline exceeded')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startsWith(bytes: Uint8Array, expected: number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

const MP4_MAJOR_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', '3gp4', '3gp5', '3gp6', '3g2a', '3g2b'
]);
const QUICKTIME_BRANDS = new Set(['qt  ']);

function readUint16(bytes: Uint8Array, offset: number) {
  if (bytes.length < offset + 2) return -1;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number) {
  if (bytes.length < offset + 4) return -1;
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function storageDatabaseError(message: string, error: unknown) {
  logger.error({ error }, message);
  return new HttpError(503, message, 'BOOKING_MEDIA_DATABASE_UNAVAILABLE');
}

function isBookingMediaLockedDatabaseError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  return (
    candidate.code === '23514' &&
    `${candidate.message ?? ''} ${candidate.details ?? ''}`.includes('BOOKING_MEDIA_LOCKED')
  );
}

function isUserMediaLimitDatabaseError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  return (
    candidate.code === '23514' &&
    `${candidate.message ?? ''} ${candidate.details ?? ''}`.includes('USER_MEDIA_LIMIT_REACHED')
  );
}

function isProjectMediaLimitDatabaseError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  return (
    candidate.code === '23514' &&
    `${candidate.message ?? ''} ${candidate.details ?? ''}`.includes('PROJECT_MEDIA_LIMIT_REACHED')
  );
}

function storageErrorStatus(error: unknown) {
  const candidate = error as {
    statusCode?: number | string;
    status?: number | string;
    originalError?: { statusCode?: number | string; status?: number | string };
  };
  return Number(
    candidate.statusCode ??
      candidate.status ??
      candidate.originalError?.statusCode ??
      candidate.originalError?.status
  );
}

export const bookingAttachmentLimits = {
  maxAttachments: MAX_BOOKING_ATTACHMENTS,
  maxVideos: MAX_BOOKING_VIDEOS,
  maxTotalBytes: MAX_BOOKING_ATTACHMENT_BYTES
};
