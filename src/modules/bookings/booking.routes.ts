import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { validate } from '../../middleware/validate.js';
import {
  cancelBooking,
  createBooking,
  getAvailableTimeSlots,
  getBookingDetail,
  getBookingHistory
} from './booking.controller.js';
import { AvailabilityQuerySchema, BookingParamsSchema, CreateBookingSchema } from './booking.schema.js';
import {
  completeBookingAttachment,
  createBookingAttachmentIntent,
  deleteCustomerBookingAttachment,
  getCustomerAttachmentDownloadUrl,
  listCustomerBookingAttachments
} from '../bookingAttachments/bookingAttachment.controller.js';
import {
  BookingAttachmentBookingParamsSchema,
  BookingAttachmentParamsSchema,
  CreateBookingAttachmentIntentSchema
} from '../bookingAttachments/bookingAttachment.schema.js';
import { bookingAttachmentIntentLimiter } from '../bookingAttachments/bookingAttachment.middleware.js';

export const bookingRouter = Router();

bookingRouter.post('/', requireAuth, requireIdempotencyKey, validate({ body: CreateBookingSchema }), createBooking);
bookingRouter.get('/history', requireAuth, getBookingHistory);
bookingRouter.get('/availability', validate({ query: AvailabilityQuerySchema }), getAvailableTimeSlots);
bookingRouter.post(
  '/:bookingId/attachments/upload-intents',
  requireAuth,
  bookingAttachmentIntentLimiter,
  validate({ params: BookingAttachmentBookingParamsSchema, body: CreateBookingAttachmentIntentSchema }),
  createBookingAttachmentIntent
);
bookingRouter.get(
  '/:bookingId/attachments',
  requireAuth,
  validate({ params: BookingAttachmentBookingParamsSchema }),
  listCustomerBookingAttachments
);
bookingRouter.post(
  '/:bookingId/attachments/:attachmentId/complete',
  requireAuth,
  validate({ params: BookingAttachmentParamsSchema }),
  completeBookingAttachment
);
bookingRouter.get(
  '/:bookingId/attachments/:attachmentId/download-url',
  requireAuth,
  validate({ params: BookingAttachmentParamsSchema }),
  getCustomerAttachmentDownloadUrl
);
bookingRouter.delete(
  '/:bookingId/attachments/:attachmentId',
  requireAuth,
  validate({ params: BookingAttachmentParamsSchema }),
  deleteCustomerBookingAttachment
);
bookingRouter.get('/:id', requireAuth, validate({ params: BookingParamsSchema }), getBookingDetail);
bookingRouter.patch('/:id/cancel', requireAuth, validate({ params: BookingParamsSchema }), cancelBooking);
