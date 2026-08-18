import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { assertRequestSlotAvailable } from './availability.service.js';
import { calculateRequestPrice } from './pricing.service.js';

export async function createRequest(req: Request, res: Response) {
  await assertRequestSlotAvailable(req.body.reservation_date, req.body.reservation_time);

  const totalPrice = await calculateRequestPrice({
    optionIds: req.body.option_ids,
    pricingTierId: req.body.pricing_tier_id
  });

  const payload = {
    client_request_id: req.body.client_request_id,
    category_id: req.body.category_id ?? null,
    service_type_id: req.body.service_type_id ?? null,
    subtype_id: req.body.subtype_id ?? null,
    pricing_tier_id: req.body.pricing_tier_id ?? null,
    option_ids: req.body.option_ids,
    name: req.body.name,
    phone: req.body.phone ?? null,
    address: req.body.address ?? null,
    detail_address: req.body.detail_address ?? null,
    symptom: req.body.symptom ?? null,
    memo: req.body.memo ?? null,
    reservation_date: req.body.reservation_date,
    reservation_time: req.body.reservation_time,
    timezone: req.body.timezone,
    total_price: totalPrice,
    status: 'pending',
    user_id: req.user!.id,
    legacy_user_id: req.user!.legacyUserId ?? null
  };

  const { data, error } = await supabaseAdmin.from('requests').insert(payload).select('*').single();
  if (error?.code === '23505') {
    const duplicateSubmission = error.message.includes('requests_user_client_request_unique_idx');
    throw new HttpError(
      409,
      duplicateSubmission ? 'This request was already submitted' : 'Time slot is already booked',
      duplicateSubmission ? 'DUPLICATE_REQUEST' : 'REQUEST_SLOT_UNAVAILABLE'
    );
  }
  if (error) throw new HttpError(400, error.message, 'REQUEST_CREATE_FAILED');
  res.status(201).json(data);
}

export async function getRequestHistory(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('reservation_date', { ascending: false })
    .order('reservation_time', { ascending: false });

  if (error) throw new HttpError(400, error.message, 'REQUEST_HISTORY_FAILED');
  res.json(data ?? []);
}

export async function getRequestDetail(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .single();

  if (error) throw new HttpError(404, 'Request not found', 'REQUEST_NOT_FOUND');
  res.json(data);
}
