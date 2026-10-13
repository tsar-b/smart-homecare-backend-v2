import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../core/errors.js';
import { createFingerprint } from '../lib/canonical.js';

declare global {
  namespace Express {
    interface Request {
      bookingRetry?: { key: string; scope: string; fingerprint: string };
    }
  }
}

// Capture the original payload before schema normalization for compatibility
// with existing clients/keys. Persistence belongs to the atomic booking RPC,
// never an asynchronous response-finish callback.
export async function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.header('idempotency-key')?.trim();
  if (!key) {
    throw new HttpError(400, 'Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'Idempotency-Key must contain 8 to 200 characters', 'IDEMPOTENCY_KEY_INVALID');
  }

  if (!req.user) throw new HttpError(401, 'Authentication required', 'NO_TOKEN');
  req.bookingRetry = {
    key,
    scope: `${req.user.id}:${req.method}:${req.baseUrl}${req.path}`,
    fingerprint: createFingerprint(req.body)
  };
  next();
}
