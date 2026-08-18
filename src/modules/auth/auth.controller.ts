import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { upsertProviderIdentity } from './identity.service.js';

export async function register(req: Request, res: Response) {
  const { name, phone, email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const passwordHash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin
    .rpc('register_standard_user', {
      p_email: normalizedEmail,
      p_name: name,
      p_password_hash: passwordHash,
      p_phone: phone ?? null
    })
    .single();

  if (error?.code === '23505' || error?.message.includes('Identity already exists')) {
    throw new HttpError(409, 'An account already exists for this email', 'IDENTITY_ALREADY_EXISTS');
  }
  if (error) throw new HttpError(400, error.message, 'REGISTER_FAILED');
  res.status(201).json({ user: data });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, legacy_user_id, email, password_hash, provider, is_admin')
    .ilike('email', normalizedEmail)
    .single();

  if (error || !user?.password_hash) {
    throw new HttpError(401, 'Invalid login', 'INVALID_LOGIN');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new HttpError(401, 'Invalid login', 'INVALID_LOGIN');

  const token = createToken(user);

  res.json({ token });
}

export async function registerGuest(req: Request, res: Response) {
  const { name, phone, address, addressDetail } = req.body;
  const normalizedPhone = phone.replace(/[^0-9]/g, '');
  const identity = await upsertProviderIdentity({
    provider: 'guest',
    providerSubject: normalizedPhone,
    name,
    phone
  });

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .update({ address, address_detail: addressDetail ?? null, name, phone })
    .eq('id', identity.userId)
    .select('id, legacy_user_id, name, email, provider, is_admin, is_guest')
    .single();

  if (error || !user) throw new HttpError(400, error?.message ?? 'Guest registration failed', 'GUEST_REGISTER_FAILED');

  res.status(identity.wasCreated ? 201 : 200).json({
    token: createToken(user, '90d'),
    userId: user.legacy_user_id ?? user.id,
    reused: !identity.wasCreated
  });
}

type TokenUser = {
  id: string;
  legacy_user_id?: number | null;
  is_admin?: boolean | null;
  provider?: string | null;
};

function createToken(user: TokenUser, expiresIn: SignOptions['expiresIn'] = '7d') {
  return jwt.sign(
    {
      sub: user.id,
      userId: user.legacy_user_id,
      isAdmin: Boolean(user.is_admin),
      provider: user.provider
    },
    env.JWT_SECRET,
    { expiresIn }
  );
}
