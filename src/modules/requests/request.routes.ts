import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { validate } from '../../middleware/validate.js';
import { createRequest, getRequestDetail, getRequestHistory } from './request.controller.js';
import { CreateRequestSchema, RequestParamsSchema } from './request.schema.js';

export const requestRouter = Router();

requestRouter.post('/', requireAuth, requireIdempotencyKey, validate({ body: CreateRequestSchema }), createRequest);
requestRouter.get('/history', requireAuth, getRequestHistory);
requestRouter.get('/:id', requireAuth, validate({ params: RequestParamsSchema }), getRequestDetail);
