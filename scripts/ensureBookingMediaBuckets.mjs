import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = required('SUPABASE_URL');
const backendKey = firstConfigured('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
if (!backendKey) throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required');

const supabase = createClient(supabaseUrl, backendKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});
const checkOnly = process.argv.includes('--check');

const expectedBuckets = [
  {
    id: 'shc-booking-images-v1',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    fileSizeLimit: 10_000_000
  },
  {
    id: 'shc-booking-videos-v1',
    allowedMimeTypes: ['video/mp4', 'video/quicktime'],
    fileSizeLimit: 45_000_000
  }
];

for (const expected of expectedBuckets) {
  const current = await supabase.storage.getBucket(expected.id);
  if (current.error) {
    const status = Number(current.error.statusCode ?? current.error.status);
    if (status !== 400 && status !== 404) throw current.error;
    if (checkOnly) throw new Error(`Required private bucket is missing: ${expected.id}`);
    const created = await supabase.storage.createBucket(expected.id, {
      public: false,
      allowedMimeTypes: expected.allowedMimeTypes,
      fileSizeLimit: expected.fileSizeLimit
    });
    if (created.error) throw created.error;
  } else {
    const currentTypes = [...(current.data.allowed_mime_types ?? [])].sort();
    const expectedTypes = [...expected.allowedMimeTypes].sort();
    const matches =
      !current.data.public &&
      Number(current.data.file_size_limit) === expected.fileSizeLimit &&
      JSON.stringify(currentTypes) === JSON.stringify(expectedTypes);
    if (!matches && checkOnly) throw new Error(`Bucket configuration mismatch: ${expected.id}`);
    if (!matches) {
      const updated = await supabase.storage.updateBucket(expected.id, {
        public: false,
        allowedMimeTypes: expected.allowedMimeTypes,
        fileSizeLimit: expected.fileSizeLimit
      });
      if (updated.error) throw updated.error;
    }
  }

  const verified = await supabase.storage.getBucket(expected.id);
  if (verified.error || !verified.data) throw verified.error ?? new Error(`Bucket ${expected.id} was not returned`);
  if (verified.data.public) throw new Error(`Bucket ${expected.id} must remain private`);
  if (Number(verified.data.file_size_limit) !== expected.fileSizeLimit) {
    throw new Error(`Bucket ${expected.id} has an unexpected file-size limit`);
  }
  const actualTypes = [...(verified.data.allowed_mime_types ?? [])].sort();
  const wantedTypes = [...expected.allowedMimeTypes].sort();
  if (JSON.stringify(actualTypes) !== JSON.stringify(wantedTypes)) {
    throw new Error(`Bucket ${expected.id} has an unexpected MIME allowlist`);
  }
  console.log(`Verified private bucket: ${expected.id}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function firstConfigured(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
