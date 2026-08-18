import type { Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../core/logger.js';

export const requestLogger = pinoHttp<Request, Response>({
  logger,
  genReqId: (req, res) => {
    const existingId = req.headers['x-request-id'];
    const requestId = Array.isArray(existingId) ? existingId[0] : existingId;
    const id = requestId ?? randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customProps: (req) => ({
    requestId: (req as { id?: string }).id
  })
}) as unknown as RequestHandler;
