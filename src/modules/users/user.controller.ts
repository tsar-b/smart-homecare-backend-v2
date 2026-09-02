import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { PROFILE_SELECT, publicProfile } from '../auth/auth.service.js';

export async function getMe(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(PROFILE_SELECT)
    .eq('id', req.user!.id)
    .single();

  if (error) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  res.json(publicProfile(data as any));
}

export async function updateMe(req: Request, res: Response) {
  if (req.user!.isGuest && req.body.phone !== undefined) {
    throw new HttpError(
      409,
      'Guest phone changes require phone verification',
      'GUEST_PHONE_VERIFICATION_REQUIRED'
    );
  }

  const patch = {
    ...(req.body.name !== undefined ? { name: req.body.name } : {}),
    ...(req.body.phone !== undefined ? { phone: req.body.phone } : {}),
    ...(req.body.address !== undefined ? { address: req.body.address } : {}),
    ...(req.body.addressDetail !== undefined || req.body.address_detail !== undefined
      ? { address_detail: req.body.addressDetail ?? req.body.address_detail ?? null }
      : {})
  };

  if (req.body.password) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user!.authUserId, {
      password: req.body.password
    });
    if (error) throw new HttpError(400, error.message, 'PASSWORD_UPDATE_FAILED');
  }

  if (!Object.keys(patch).length) {
    const profile = await loadProfile(req.user!.id);
    res.json(publicProfile(profile as any));
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', req.user!.id)
    .select(PROFILE_SELECT)
    .single();

  if (error) throw new HttpError(400, error.message, 'USER_UPDATE_FAILED');
  res.json(publicProfile(data as any));
}

export async function deleteMe(req: Request, res: Response) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user!.authUserId);
  if (error) throw new HttpError(400, error.message, 'USER_DELETE_FAILED');
  res.json({ ok: true });
}

async function loadProfile(id: string) {
  const { data, error } = await supabaseAdmin.from('users').select(PROFILE_SELECT).eq('id', id).single();
  if (error || !data) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  return data;
}
