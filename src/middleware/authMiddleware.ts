import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../core/env.js';
import { HttpError } from '../core/errors.js';

export type AuthUser = {
  id: string;
  legacyUserId?: number;
  isAdmin: boolean;
  provider?: 'standard' | 'kakao' | 'apple' | 'guest';
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'No token provided', 'NO_TOKEN');

  const decoded = jwt.verify(token, env.JWT_SECRET) as any;
  req.user = {
    id: decoded.sub ?? decoded._id,
    legacyUserId: decoded.userId,
    isAdmin: Boolean(decoded.isAdmin),
    provider: decoded.provider
  };
  next();
}
