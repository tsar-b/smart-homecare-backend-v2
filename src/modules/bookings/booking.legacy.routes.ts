import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createBooking,
  getAvailableTimeSlots,
  getBookingDetail,
  getBookingHistory
} from './booking.controller.js';
import { AvailabilityQuerySchema, BookingParamsSchema, CreateBookingSchema } from './booking.schema.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

export const legacyBookingRouter = Router();

legacyBookingRouter.get('/timeslots', validate({ query: AvailabilityQuerySchema }), getAvailableTimeSlots);
legacyBookingRouter.post('/booking', requireAuth, requireIdempotencyKey, validate({ body: CreateBookingSchema }), createBooking);
legacyBookingRouter.get('/history', requireAuth, getBookingHistory);
legacyBookingRouter.get('/historydetail/:id', requireAuth, validate({ params: BookingParamsSchema }), getBookingDetail);
