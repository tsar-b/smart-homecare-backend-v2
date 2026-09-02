import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, refreshSession, register, registerGuest, updatePassword } from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import {
  AppleLoginSchema,
  GuestRegisterSchema,
  LoginSchema,
  RefreshSessionSchema,
  RegisterSchema,
  UpdatePasswordSchema
} from './auth.schema.js';
import { env } from '../../core/env.js';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { loginApple } from '../integrations/apple/apple.controller.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'AUTH_RATE_LIMITED', message: 'Too many authentication attempts' }
});

authRouter.post('/register', authLimiter, validate({ body: RegisterSchema }), register);
authRouter.post('/guest', authLimiter, validate({ body: GuestRegisterSchema }), registerGuest);
authRouter.post('/login', authLimiter, validate({ body: LoginSchema }), login);
authRouter.post('/apple', authLimiter, validate({ body: AppleLoginSchema }), loginApple);
authRouter.post('/refresh', authLimiter, validate({ body: RefreshSessionSchema }), refreshSession);
authRouter.post('/logout', requireAuth, logout);
authRouter.patch('/password', requireAuth, validate({ body: UpdatePasswordSchema }), updatePassword);

export const legacyAuthRouter = Router();
legacyAuthRouter.post('/register', authLimiter, validate({ body: RegisterSchema }), register);
legacyAuthRouter.post('/login', authLimiter, validate({ body: LoginSchema }), login);
