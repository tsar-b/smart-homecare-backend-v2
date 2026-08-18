import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

export async function getMe(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, legacy_user_id, name, phone, email, provider, is_admin, is_guest, address, address_detail')
    .eq('id', req.user!.id)
    .single();

  if (error) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  res.json(data);
}

export async function updateMe(req: Request, res: Response) {
  const allowed = ['name', 'phone', 'address', 'address_detail'];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', req.user!.id)
    .select('id, name, phone, address, address_detail')
    .single();

  if (error) throw new HttpError(400, error.message, 'USER_UPDATE_FAILED');
  res.json(data);
}

export async function deleteMe(req: Request, res: Response) {
  const { error } = await supabaseAdmin.from('users').delete().eq('id', req.user!.id);
  if (error) throw new HttpError(400, error.message, 'USER_DELETE_FAILED');
  res.json({ ok: true });
}
