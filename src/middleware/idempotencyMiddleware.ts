import type { NextFunction, Request, Response } from 'express';
import { env } from '../core/env.js';
import { HttpError } from '../core/errors.js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';
import { createFingerprint } from '../lib/canonical.js';

type ClaimResult = {
  outcome: 'acquired' | 'conflict' | 'in_progress' | 'replay';
  stored_body: unknown;
  stored_status: number | null;
};

export async function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header('idempotency-key')?.trim();
  if (!key) {
    throw new HttpError(400, 'Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'Idempotency-Key must contain 8 to 200 characters', 'IDEMPOTENCY_KEY_INVALID');
  }

  const scope = `${req.user?.id ?? 'anonymous'}:${req.method}:${req.baseUrl}${req.path}`;
  const fingerprint = createFingerprint(req.body);
  const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
    p_fingerprint: fingerprint,
    p_key: key,
    p_scope: scope,
    p_ttl_seconds: Math.ceil(env.IDEMPOTENCY_TTL_MS / 1000)
  });

  if (error) {
    throw new HttpError(503, 'Idempotency store is unavailable', 'IDEMPOTENCY_STORE_UNAVAILABLE');
  }

  const claim = (Array.isArray(data) ? data[0] : data) as ClaimResult | undefined;
  if (!claim) {
    throw new HttpError(503, 'Idempotency claim returned no result', 'IDEMPOTENCY_STORE_UNAVAILABLE');
  }

  if (claim.outcome === 'conflict') {
    throw new HttpError(409, 'Idempotency-Key was reused with a different payload', 'IDEMPOTENCY_CONFLICT');
  }
  if (claim.outcome === 'in_progress') {
    res.setHeader('Retry-After', '2');
    throw new HttpError(409, 'An identical request is already being processed', 'IDEMPOTENCY_IN_PROGRESS');
  }
  if (claim.outcome === 'replay') {
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(claim.stored_status ?? 200).json(claim.stored_body ?? null);
    return;
  }

  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBody = body;
    return originalJson(body);
  };

  res.once('finish', () => {
    const succeeded = res.statusCode >= 200 && res.statusCode < 300;
    const operation = succeeded
      ? supabaseAdmin.rpc('complete_idempotency_key', {
          p_fingerprint: fingerprint,
          p_key: key,
          p_response_body: responseBody ?? null,
          p_response_status: res.statusCode,
          p_scope: scope
        })
      : supabaseAdmin.rpc('release_idempotency_key', {
          p_fingerprint: fingerprint,
          p_key: key,
          p_scope: scope
        });

    void operation.then(({ error: finalizeError }) => {
      if (finalizeError) {
        (req as Request & { log?: { error: (payload: unknown, message: string) => void } }).log?.error(
          { error: finalizeError, key, scope },
          'Failed to finalize idempotency key'
        );
      }
    });
  });

  next();
}
