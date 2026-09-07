import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../core/errors.js';

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    throw new HttpError(403, 'Admin permission required', 'ADMIN_REQUIRED');
  }
  next();
}
