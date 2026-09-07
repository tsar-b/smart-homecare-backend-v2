import rateLimit from 'express-rate-limit';
import {
  BOOKING_ATTACHMENT_INTENT_RATE_LIMIT,
  BOOKING_ATTACHMENT_INTENT_RATE_WINDOW_MS
} from './bookingAttachment.constants.js';

// requireAuth always runs first. Keying by the canonical user id prevents a
// shared office/mobile IP from pooling the per-account media reservation cap.
export const bookingAttachmentIntentLimiter = rateLimit({
  windowMs: BOOKING_ATTACHMENT_INTENT_RATE_WINDOW_MS,
  limit: BOOKING_ATTACHMENT_INTENT_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user!.id,
  message: {
    code: 'UPLOAD_INTENT_RATE_LIMITED',
    message: 'Too many media upload intents; try again shortly'
  }
});
