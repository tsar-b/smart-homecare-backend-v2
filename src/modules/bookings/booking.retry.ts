import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type RetryResult = { outcome: string; booking?: Record<string, any> };

export function bookingRetryArguments(req: Request) {
  if (!req.user || !req.bookingRetry) {
    throw new HttpError(500, 'Booking retry context is missing', 'BOOKING_RETRY_CONTEXT_MISSING');
  }
  return {
    p_user_id: req.user.id,
    p_client_request_id: req.body.client_request_id,
    p_key: req.bookingRetry.key,
    p_scope: req.bookingRetry.scope,
    p_fingerprint: req.bookingRetry.fingerprint
  };
}

export async function readBookingReplay(req: Request) {
  const { data, error } = await supabaseAdmin.rpc('lookup_booking_submission', bookingRetryArguments(req));
  if (error) throw retryUnavailable();
  const result = checkResult(data);
  if (result.outcome === 'missing') return null;
  return replayOrThrow(result);
}

export async function commitBooking(req: Request, res: Response, payload: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc('commit_booking_submission', {
    ...bookingRetryArguments(req), p_booking: payload
  });
  if (error?.code === '23505') {
    // A concurrent pre-upgrade writer is not silently accepted as equivalent.
    if (`${error.message} ${error.details ?? ''}`.includes('client_request')) {
      throw reviewRequired();
    }
    throw new HttpError(409, 'Time slot is already booked', 'BOOKING_SLOT_UNAVAILABLE');
  }
  // Network/RPC failures can have an unknown commit outcome. Never fall back to
  // direct INSERT or create another request ID; retry the same request instead.
  if (error) throw retryUnavailable();
  const result = checkResult(data);
  if (result.outcome === 'created' && result.booking?.id) return result.booking;
  const row = replayOrThrow(result);
  res.setHeader('Idempotency-Replayed', 'true');
  return row;
}

function checkResult(data: unknown): RetryResult {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('outcome' in data)) {
    throw retryUnavailable();
  }
  return data as RetryResult;
}

function replayOrThrow(result: RetryResult): Record<string, any> {
  if (result.outcome === 'replay' && result.booking?.id) return result.booking;
  if (result.outcome === 'conflict') {
    throw new HttpError(409, 'Booking retry identity was reused with a different request', 'IDEMPOTENCY_CONFLICT');
  }
  if (result.outcome === 'review_required') throw reviewRequired();
  if (result.outcome === 'past') throw new HttpError(409, 'Reservation time is in the past', 'BOOKING_SLOT_IN_PAST');
  throw retryUnavailable();
}

function retryUnavailable() {
  return new HttpError(503, 'Booking retry store is unavailable; retry the same request', 'IDEMPOTENCY_STORE_UNAVAILABLE');
}

function reviewRequired() {
  return new HttpError(409, 'A previous booking may exist; check booking history before submitting again', 'BOOKING_RETRY_REVIEW_REQUIRED');
}
