import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { validate } from '../../middleware/validate.js';
import { createBooking, getBookingHistory } from './booking.controller.js';
import { CreateBookingSchema } from './booking.schema.js';

export const bookingRouter = Router();

bookingRouter.post('/', requireAuth, requireIdempotencyKey, validate({ body: CreateBookingSchema }), createBooking);
bookingRouter.get('/history', requireAuth, getBookingHistory);
