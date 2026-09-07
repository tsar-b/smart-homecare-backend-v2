import express from 'express';
import { registerRoutes } from '../routes/index.js';
import { errorHandler } from './errors.js';
import { applySecurity } from './security.js';
import { requestLogger } from '../middleware/requestContext.js';
import { openApiDocument } from '../openapi/openapi.js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';
import { HttpError } from './errors.js';
import {
  BOOKING_IMAGE_BUCKET,
  BOOKING_VIDEO_BUCKET,
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_MIME_TYPES
} from '../modules/bookingAttachments/bookingAttachment.constants.js';

export function createHttpServer() {
  const app = express();

  applySecurity(app);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/ready', async (_req, res) => {
    const [database, attachmentDatabase, auth, storage] = await Promise.allSettled([
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('booking_attachments').select('id', { count: 'exact', head: true }),
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 }),
      supabaseAdmin.storage.listBuckets()
    ]);
    const databaseReady =
      database.status === 'fulfilled' &&
      !database.value.error &&
      attachmentDatabase.status === 'fulfilled' &&
      !attachmentDatabase.value.error;
    const authReady = auth.status === 'fulfilled' && !auth.value.error;
    const storageReady =
      storage.status === 'fulfilled' &&
      !storage.value.error &&
      bookingMediaBucketsAreReady(storage.value.data ?? []);
    const ready = databaseReady && authReady && storageReady;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      dependencies: {
        supabaseAuth: authReady,
        supabaseDatabase: databaseReady,
        supabaseStorage: storageReady
      }
    });
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  registerRoutes(app);
  app.use((req) => {
    throw new HttpError(404, `Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND');
  });
  app.use(errorHandler);

  return app;
}

type MediaBucket = {
  id: string;
  public: boolean;
  file_size_limit?: number | string | null;
  allowed_mime_types?: string[] | null;
};

export function bookingMediaBucketsAreReady(buckets: MediaBucket[]) {
  const expected = [
    { id: BOOKING_IMAGE_BUCKET, limit: MAX_IMAGE_BYTES, types: IMAGE_MIME_TYPES },
    { id: BOOKING_VIDEO_BUCKET, limit: MAX_VIDEO_BYTES, types: VIDEO_MIME_TYPES }
  ];
  return expected.every((wanted) => {
    const bucket = buckets.find((candidate) => candidate.id === wanted.id);
    return (
      bucket !== undefined &&
      bucket.public === false &&
      Number(bucket.file_size_limit) === wanted.limit &&
      sameStrings(bucket.allowed_mime_types ?? [], wanted.types)
    );
  });
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
