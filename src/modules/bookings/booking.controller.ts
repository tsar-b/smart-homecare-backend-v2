import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

export async function createBooking(req: Request, res: Response) {
  const payload = {
    client_request_id: req.body.client_request_id,
    asset_id: req.body.asset_id ?? null,
    service_type: req.body.service_type ?? null,
    subtype: req.body.subtype ?? null,
    name: req.body.name,
    phone: req.body.phone ?? null,
    address: req.body.address ?? null,
    detail_address: req.body.detail_address ?? null,
    reservation_date: req.body.reservation_date,
    reservation_time: req.body.reservation_time,
    memo: req.body.memo ?? null,
    total_price: req.body.total_price ?? null,
    user_id: req.user!.id,
    legacy_user_id: req.user!.legacyUserId ?? null,
    status: '대기'
  };

  const { data, error } = await supabaseAdmin.from('bookings').insert(payload).select('*').single();
  if (error?.code === '23505') {
    const duplicateSubmission = error.message.includes('bookings_user_client_request_unique_idx');
    throw new HttpError(
      409,
      duplicateSubmission ? 'This booking was already submitted' : 'Time slot is already booked',
      duplicateSubmission ? 'DUPLICATE_BOOKING' : 'BOOKING_SLOT_UNAVAILABLE'
    );
  }
  if (error) throw new HttpError(400, error.message, 'BOOKING_CREATE_FAILED');
  res.status(201).json(data);
}

export async function getBookingHistory(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('reservation_date', { ascending: false });

  if (error) throw new HttpError(400, error.message, 'BOOKING_HISTORY_FAILED');
  res.json(data);
}
