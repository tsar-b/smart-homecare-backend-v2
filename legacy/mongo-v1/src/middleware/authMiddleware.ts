// src/middleware/authMiddleware.ts

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        _id: string;
        userId?: number | string;
        isAdmin: boolean;
        isGuest: boolean;
        provider: 'standard' | 'kakao' | 'apple' | 'guest';
        phoneNeedsUpdate?: boolean;
      };
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ message: 'No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    req.user = {
      _id: decoded._id,
      userId: decoded.userId,
      isAdmin: decoded.isAdmin,
      isGuest: decoded.isGuest,
      provider: decoded.provider ?? 'standard', 
      phoneNeedsUpdate: decoded.phoneNeedsUpdate ?? false,
    };

    next();
  } catch (err) {
    console.error('Invalid token:', err);
    res.status(403).json({ message: '토큰이 유효하지 않습니다.' });
  }
};

export const requireValidPhone = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.provider === 'kakao' && req.user.phoneNeedsUpdate) {
    res.status(409).json({
      code: 'PHONE_REQUIRED',
      message: '전화번호 등록이 필요합니다.',
    });
    return;
  }
  next();
};


export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user?.isAdmin) {
    res.status(403).json({ message: '관리자 권한이 필요합니다.' });
    return; 
  }
  next();
};
