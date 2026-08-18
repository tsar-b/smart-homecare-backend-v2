// src/middleware/requestLogger.ts

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// attach req.id and log the basic line
export const requestLogger = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = randomUUID().slice(0, 8);   // short id is fine
  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl}`);
  next();
};

// helper so TS knows req.id exists everywhere
declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}
