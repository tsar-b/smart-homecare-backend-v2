import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../core/errors.js';
import { supabaseAdmin } from '../db/supabaseAdmin.js';

export type AuthUser = {
  id: string;
  authUserId: string;
  email?: string;
  legacyUserId?: number;
  isAdmin: boolean;
  isGuest: boolean;
  provider?: 'standard' | 'kakao' | 'apple' | 'guest';
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authorization = req.headers.authorization?.trim();
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'No token provided', 'NO_TOKEN');

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !authData.user) {
    throw new HttpError(401, 'Invalid or expired access token', 'INVALID_TOKEN');
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, legacy_user_id, email, provider, is_admin, is_guest')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();

  if (profileError) {
    throw new HttpError(503, 'Unable to load authenticated profile', 'PROFILE_LOOKUP_FAILED');
  }
  if (!profile) {
    throw new HttpError(403, 'Authenticated account has no SHC profile', 'PROFILE_REQUIRED');
  }

  req.user = {
    id: profile.id,
    authUserId: authData.user.id,
    email: profile.email ?? authData.user.email,
    legacyUserId: profile.legacy_user_id ?? undefined,
    isAdmin: Boolean(profile.is_admin),
    isGuest: Boolean(profile.is_guest),
    provider: profile.provider ?? undefined
  };
  next();
}
