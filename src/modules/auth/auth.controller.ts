import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { createSupabasePublicClient } from '../../db/supabaseClient.js';
import {
  confirmationRequiredResponse,
  readProfileByAuthUserId,
  readProfileById,
  sessionResponse,
  upsertAuthenticatedIdentity
} from './auth.service.js';

export async function register(req: Request, res: Response) {
  const { name, phone, email, password, address, addressDetail } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const client = createSupabasePublicClient();
  let authUserId: string | null = null;
  let session = null;
  let emailConfirmed = false;

  const userMetadata = {
    name,
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(addressDetail ? { address_detail: addressDetail } : {})
  };

  if (env.AUTH_EMAIL_AUTO_CONFIRM) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: userMetadata
    });
    if (error || !data.user) throw mapRegistrationError(error?.message);
    authUserId = data.user.id;
    emailConfirmed = Boolean(data.user.email_confirmed_at);

    const signedIn = await client.auth.signInWithPassword({ email: normalizedEmail, password });
    if (signedIn.error || !signedIn.data.session) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId);
      throw new HttpError(503, 'Account was created but a session could not be issued', 'SESSION_ISSUE_FAILED');
    }
    session = signedIn.data.session;
  } else {
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail,
      password,
      options: { data: userMetadata }
    });
    if (error || !data.user || data.user.identities?.length === 0) {
      throw mapRegistrationError(error?.message);
    }
    authUserId = data.user.id;
    session = data.session;
    emailConfirmed = Boolean(data.user.email_confirmed_at);
  }

  if (!session || !emailConfirmed) {
    res.status(202).json(confirmationRequiredResponse());
    return;
  }

  try {
    const identity = await upsertAuthenticatedIdentity({
      authUserId,
      provider: 'standard',
      providerSubject: normalizedEmail,
      email: normalizedEmail,
      name,
      phone,
      address,
      addressDetail,
      emailVerified: true
    });
    const profile = await readProfileById(identity.profileId);
    res.status(201).json(sessionResponse(session, profile));
  } catch (error) {
    await supabaseAdmin.auth.admin.deleteUser(authUserId);
    throw error;
  }
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const client = createSupabasePublicClient();
  let auth = await client.auth.signInWithPassword({ email: normalizedEmail, password });

  if (auth.error || !auth.data.session || !auth.data.user) {
    auth = await migrateLegacyPassword(normalizedEmail, password);
  }

  if (auth.error || !auth.data.session || !auth.data.user) {
    throw new HttpError(401, 'Invalid email or password', 'INVALID_LOGIN');
  }
  if (!auth.data.user.email_confirmed_at) {
    throw new HttpError(403, 'Email confirmation is required', 'EMAIL_CONFIRMATION_REQUIRED');
  }

  let profile = await readProfileByAuthUserId(auth.data.user.id);
  if (!profile) {
    const metadata = registrationProfileMetadata(auth.data.user.user_metadata);
    const identity = await upsertAuthenticatedIdentity({
      authUserId: auth.data.user.id,
      provider: 'standard',
      providerSubject: normalizedEmail,
      email: normalizedEmail,
      name: metadata.name ?? normalizedEmail.split('@')[0],
      phone: metadata.phone,
      address: metadata.address,
      addressDetail: metadata.addressDetail,
      emailVerified: true
    });
    profile = await readProfileById(identity.profileId);
  } else if (auth.data.user.email_confirmed_at && !profile.email_verified) {
    const { error } = await supabaseAdmin
      .from('users')
      .update({ email_verified: true })
      .eq('id', profile.id);
    if (!error) profile = await readProfileById(profile.id);
  }

  res.json(sessionResponse(auth.data.session, profile));
}

export async function registerGuest(_req: Request, _res: Response) {
  throw new HttpError(
    503,
    'Guest registration requires verified phone ownership and is not available yet',
    'GUEST_VERIFICATION_REQUIRED'
  );
}

export async function refreshSession(req: Request, res: Response) {
  const client = createSupabasePublicClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: req.body.refresh_token });
  if (error || !data.session || !data.user) {
    throw new HttpError(401, 'Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
  }
  const profile = await readProfileByAuthUserId(data.user.id);
  if (!profile) throw new HttpError(403, 'Authenticated account has no SHC profile', 'PROFILE_REQUIRED');
  res.json(sessionResponse(data.session, profile));
}

export async function logout(req: Request, res: Response) {
  const token = req.headers.authorization!.replace(/^Bearer\s+/i, '');
  const { error } = await supabaseAdmin.auth.admin.signOut(token, 'global');
  if (error) throw new HttpError(400, 'Unable to revoke session', 'LOGOUT_FAILED');
  res.status(204).send();
}

export async function updatePassword(req: Request, res: Response) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user!.authUserId, {
    password: req.body.password
  });
  if (error) throw new HttpError(400, error.message, 'PASSWORD_UPDATE_FAILED');
  res.json({ ok: true });
}

async function migrateLegacyPassword(email: string, password: string) {
  const failed = { data: { session: null, user: null }, error: new Error('Invalid login') } as any;
  const { data: legacy, error } = await supabaseAdmin
    .from('users')
    .select('id, auth_user_id, name, phone, email, password_hash, address, address_detail')
    .ilike('email', email)
    .maybeSingle();

  if (error || !legacy?.password_hash || !(await bcrypt.compare(password, legacy.password_hash))) {
    return failed;
  }

  let authUserId = legacy.auth_user_id as string | null;
  if (authUserId) {
    const updated = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      password,
      email_confirm: true
    });
    if (updated.error) return failed;
  } else {
    const created = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: legacy.name, phone: legacy.phone }
    });
    if (created.error || !created.data.user) return failed;
    authUserId = created.data.user.id;

    try {
      await upsertAuthenticatedIdentity({
        authUserId,
        provider: 'standard',
        providerSubject: email,
        email,
        name: legacy.name,
        phone: legacy.phone,
        address: legacy.address,
        addressDetail: legacy.address_detail,
        emailVerified: true
      });
    } catch {
      await supabaseAdmin.auth.admin.deleteUser(authUserId);
      return failed;
    }
  }

  const client = createSupabasePublicClient();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (!signedIn.error && signedIn.data.session) {
    await supabaseAdmin.from('users').update({ password_hash: null }).eq('id', legacy.id);
  }
  return signedIn;
}

function mapRegistrationError(message?: string) {
  if (/already|registered|exists/i.test(message ?? '')) {
    return new HttpError(409, 'An account already exists for this email', 'IDENTITY_ALREADY_EXISTS');
  }
  return new HttpError(400, message ?? 'Registration failed', 'REGISTER_FAILED');
}

export function registrationProfileMetadata(value: unknown) {
  const metadata = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    name: metadataString(metadata.name, 120),
    phone: metadataString(metadata.phone, 50),
    address: metadataString(metadata.address, 500),
    addressDetail: metadataString(metadata.address_detail ?? metadata.addressDetail, 500)
  };
}

function metadataString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}
