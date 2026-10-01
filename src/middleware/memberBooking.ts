import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../core/errors.js';

/** New bookings are member-only. Existing booking reads/media remain unchanged. */
export function requireBookingMember(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'Sign in to book', 'NO_TOKEN');
  if (req.user.isGuest || req.user.provider === 'guest') {
    throw new HttpError(403, 'A member account is required for a new booking', 'MEMBER_ACCOUNT_REQUIRED');
  }
  next();
}
