import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (String(process.env.RUN_MEDIA_SMOKE ?? '').trim().toLowerCase() !== 'true') {
  throw new Error(
    'Refusing to mutate Storage. Set RUN_MEDIA_SMOKE=true only for a disposable staging booking.'
  );
}

const apiUrl = required('SMOKE_API_URL').replace(/\/$/, '');
const supabaseUrl = required('SUPABASE_URL');
const ownerToken = required('MEDIA_SMOKE_OWNER_ACCESS_TOKEN');
const nonownerToken = required('MEDIA_SMOKE_NONOWNER_ACCESS_TOKEN');
const bookingId = required('MEDIA_SMOKE_BOOKING_ID');
const adminKey = firstRequired('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
const publicKey = firstRequired('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');

const supabaseAdmin = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});
const ownerStorage = createClient(supabaseUrl, publicKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${ownerToken}` } }
});

const runId = randomUUID();
const clientAttachmentIds = [randomUUID(), randomUUID()];
const createdAttachments = [];

const imageBytes = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1
]);
const videoBytes = new Uint8Array(6 * 1024 * 1024 + 64);
videoBytes.set(
  [
    0, 0, 0, 20,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0, 0, 0, 0,
    0x69, 0x73, 0x6f, 0x6d
  ],
  0
);

try {
  const ready = await api('/ready');
  expectStatus(ready, 200, 'readiness');
  assert.equal(ready.body.dependencies.supabaseStorage, true);

  const ownerInitial = await api(`/api/bookings/${bookingId}/attachments`, { token: ownerToken });
  expectStatus(ownerInitial, 200, 'owner attachment list');

  const nonownerInitial = await api(`/api/bookings/${bookingId}/attachments`, { token: nonownerToken });
  expectStatus(nonownerInitial, 404, 'non-owner booking denial');
  pass('owner/non-owner booking boundary');

  const imageIntent = await createIntent({
    clientAttachmentId: clientAttachmentIds[0],
    kind: 'image',
    contentType: 'image/jpeg',
    bytes: imageBytes
  });
  assert.equal(imageIntent.uploadMethod, 'signed_put');
  assert.ok(imageIntent.signedUrl);
  assert.equal(imageIntent.tusEndpoint, null);
  assert.equal(imageIntent.storageApiKey, null);
  remember(imageIntent);

  const imageUpload = await ownerStorage.storage
    .from(imageIntent.bucketId)
    .uploadToSignedUrl(imageIntent.objectPath, imageIntent.uploadToken, imageBytes, {
      contentType: 'image/jpeg',
      cacheControl: '0',
      upsert: false
    });
  if (imageUpload.error) throw imageUpload.error;
  await assertStoredCacheControlZero(imageIntent);

  const imageComplete = await complete(imageIntent.attachment.id);
  assert.equal(imageComplete.status, 'ready');
  const imageCompleteReplay = await complete(imageIntent.attachment.id);
  assert.equal(imageCompleteReplay.status, 'ready');
  pass('signed PUT upload and idempotent completion');

  const imageDownload = await api(
    `/api/bookings/${bookingId}/attachments/${imageIntent.attachment.id}/download-url`,
    { token: ownerToken }
  );
  expectStatus(imageDownload, 200, 'owner image download URL');
  const downloadedImage = await fetch(imageDownload.body.downloadUrl);
  assert.equal(downloadedImage.status, 200);
  assert.deepEqual(new Uint8Array(await downloadedImage.arrayBuffer()), imageBytes);

  await assertNonownerAttachmentDenial(imageIntent.attachment.id);
  pass('owner download and non-owner attachment denial');

  const videoIntent = await createIntent({
    clientAttachmentId: clientAttachmentIds[1],
    kind: 'video',
    contentType: 'video/mp4',
    bytes: videoBytes
  });
  assert.equal(videoIntent.uploadMethod, 'tus');
  assert.equal(videoIntent.signedUrl, null);
  assert.ok(videoIntent.tusEndpoint);
  assert.equal(videoIntent.storageApiKey, publicKey);
  assert.equal(videoIntent.chunkSizeBytes, 6 * 1024 * 1024);
  remember(videoIntent);

  await uploadTus(videoIntent, videoBytes, 'video/mp4');
  await assertStoredCacheControlZero(videoIntent);
  const videoComplete = await complete(videoIntent.attachment.id);
  assert.equal(videoComplete.status, 'ready');

  const videoDownload = await api(
    `/api/bookings/${bookingId}/attachments/${videoIntent.attachment.id}/download-url`,
    { token: ownerToken }
  );
  expectStatus(videoDownload, 200, 'owner video download URL');
  const downloadedPrefix = await fetch(videoDownload.body.downloadUrl, { headers: { Range: 'bytes=0-11' } });
  assert.ok(downloadedPrefix.status === 200 || downloadedPrefix.status === 206);
  assert.deepEqual(new Uint8Array(await downloadedPrefix.arrayBuffer()).slice(0, 12), videoBytes.slice(0, 12));
  pass('signed-token TUS upload, completion, and bounded download');

  const ownerList = await api(`/api/bookings/${bookingId}/attachments`, { token: ownerToken });
  expectStatus(ownerList, 200, 'owner completed attachment list');
  for (const intent of [imageIntent, videoIntent]) {
    const row = ownerList.body.find((candidate) => candidate.id === intent.attachment.id);
    assert.equal(row?.status, 'ready');
    assert.equal('downloadUrl' in row, false, 'Attachment list must remain metadata-only');
    assert.equal('downloadUrlExpiresAt' in row, false, 'Attachment list must not mint signed URLs');
  }

  for (const intent of [imageIntent, videoIntent]) {
    const deleted = await api(`/api/bookings/${bookingId}/attachments/${intent.attachment.id}`, {
      method: 'DELETE',
      token: ownerToken
    });
    expectStatus(deleted, 204, `delete ${intent.attachment.kind}`);

    const hidden = await api(
      `/api/bookings/${bookingId}/attachments/${intent.attachment.id}/download-url`,
      { token: ownerToken }
    );
    expectStatus(hidden, 404, `deleted ${intent.attachment.kind} visibility`);

    const storageInfo = await supabaseAdmin.storage.from(intent.bucketId).info(intent.objectPath);
    assert.ok(storageInfo.error, `Deleted ${intent.attachment.kind} object still exists in Storage`);
  }
  pass('owner delete hides metadata and removes Storage objects');

  console.log(`\nLive booking-media smoke test passed (${runId}).`);
} finally {
  await cleanup();
}

async function createIntent({ clientAttachmentId, kind, contentType, bytes }) {
  const response = await api(`/api/bookings/${bookingId}/attachments/upload-intents`, {
    method: 'POST',
    token: ownerToken,
    body: { clientAttachmentId, kind, contentType, sizeBytes: bytes.byteLength }
  });
  expectStatus(response, 201, `${kind} upload intent`);
  assert.equal(response.body.attachment.clientAttachmentId, clientAttachmentId);
  assert.equal(response.body.attachment.status, 'pending');
  assert.equal(response.body.attachment.sizeBytes, bytes.byteLength);
  assert.ok(response.body.uploadToken);
  return response.body;
}

async function complete(attachmentId) {
  const response = await api(`/api/bookings/${bookingId}/attachments/${attachmentId}/complete`, {
    method: 'POST',
    token: ownerToken
  });
  expectStatus(response, 200, 'attachment completion');
  return response.body;
}

async function assertNonownerAttachmentDenial(attachmentId) {
  const download = await api(`/api/bookings/${bookingId}/attachments/${attachmentId}/download-url`, {
    token: nonownerToken
  });
  expectStatus(download, 404, 'non-owner attachment download denial');

  const deleted = await api(`/api/bookings/${bookingId}/attachments/${attachmentId}`, {
    method: 'DELETE',
    token: nonownerToken
  });
  expectStatus(deleted, 404, 'non-owner attachment delete denial');
}

async function uploadTus(intent, bytes, contentType) {
  const headers = {
    apikey: intent.storageApiKey,
    'Tus-Resumable': '1.0.0',
    'Upload-Length': String(bytes.byteLength),
    'Upload-Metadata': [
      tusMetadata('bucketName', intent.bucketId),
      tusMetadata('objectName', intent.objectPath),
      tusMetadata('contentType', contentType),
      tusMetadata('cacheControl', '0')
    ].join(','),
    'x-signature': intent.uploadToken,
    'x-upsert': 'false'
  };
  const created = await fetch(intent.tusEndpoint, { method: 'POST', headers });
  await expectTusStatus(created, 201, 'TUS creation');
  const location = created.headers.get('location');
  assert.ok(location, 'TUS creation returned no Location header');
  const uploadUrl = new URL(location, intent.tusEndpoint).toString();

  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + intent.chunkSizeBytes, bytes.byteLength);
    const chunk = bytes.slice(offset, end);
    const patched = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        apikey: intent.storageApiKey,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
        'x-signature': intent.uploadToken,
        'x-upsert': 'false'
      },
      body: chunk
    });
    await expectTusStatus(patched, 204, 'TUS chunk');
    offset = end;
    assert.equal(Number(patched.headers.get('upload-offset')), offset, 'TUS server returned an unexpected offset');
  }
}

async function assertStoredCacheControlZero(intent) {
  const info = await supabaseAdmin.storage.from(intent.bucketId).info(intent.objectPath);
  if (info.error || !info.data) throw info.error ?? new Error('Storage returned no object info');
  const normalized = String(info.data.cacheControl ?? '').trim().toLowerCase().replace(/\s+/g, '');
  assert.ok(
    normalized === '0' || normalized === 'max-age=0',
    `Storage returned non-zero cache control for ${intent.attachment.kind}: ${normalized || 'missing'}`
  );
}

async function expectTusStatus(response, expected, step) {
  if (response.status === expected) return;
  const detail = (await response.text()).slice(0, 500);
  assert.fail(`${step} returned ${response.status}: ${detail || 'no response body'}`);
}

function tusMetadata(key, value) {
  return `${key} ${Buffer.from(value, 'utf8').toString('base64')}`;
}

function remember(intent) {
  createdAttachments.push({
    id: intent.attachment.id,
    clientAttachmentId: intent.attachment.clientAttachmentId,
    bucketId: intent.bucketId,
    objectPath: intent.objectPath
  });
}

async function cleanup() {
  const cleanupErrors = [];
  const byBucket = new Map();
  for (const attachment of createdAttachments) {
    const paths = byBucket.get(attachment.bucketId) ?? [];
    paths.push(attachment.objectPath);
    byBucket.set(attachment.bucketId, paths);
  }
  for (const [bucketId, paths] of byBucket) {
    const removal = await supabaseAdmin.storage.from(bucketId).remove(paths);
    if (removal.error) cleanupErrors.push(`${bucketId} Storage cleanup: ${removal.error.message}`);
  }

  const deleted = await supabaseAdmin
    .from('booking_attachments')
    .delete()
    .in('client_attachment_id', clientAttachmentIds);
  if (deleted.error) cleanupErrors.push(`metadata cleanup: ${deleted.error.message}`);

  const leftovers = await supabaseAdmin
    .from('booking_attachments')
    .select('id', { count: 'exact', head: true })
    .in('client_attachment_id', clientAttachmentIds);
  if (leftovers.error) cleanupErrors.push(`metadata cleanup verification: ${leftovers.error.message}`);
  else if (leftovers.count !== 0) cleanupErrors.push(`metadata cleanup left ${leftovers.count} row(s)`);

  if (cleanupErrors.length) throw new Error(`Media smoke cleanup failed: ${cleanupErrors.join('; ')}`);
  pass('privileged staging fixture cleanup');
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

function firstRequired(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is required`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pass(label) {
  console.log(`PASS ${label}`);
}
