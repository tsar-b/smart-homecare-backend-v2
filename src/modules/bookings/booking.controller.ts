import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { assertBookableSlot, buildBookingQuote, isSlotInPast, normalizeSlots } from './booking.service.js';

const ACTIVE_STATUSES = ['대기', '확정', 'pending', 'confirmed', 'approved'];

export async function createBooking(req: Request, res: Response) {
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('name, phone, address, address_detail, is_guest')
    .eq('id', req.user!.id)
    .single();
  if (profileError || !profile) throw new HttpError(404, 'User profile not found', 'PROFILE_NOT_FOUND');

  const [quote] = await Promise.all([
    buildBookingQuote({
      subtypeReference: req.body.subtype_id ?? req.body.asset_id ?? req.body.subtype,
      serviceTypeReference: req.body.service_type_id ?? req.body.service_type,
      pricingTierId: req.body.pricing_tier_id,
      tier: req.body.tier,
      options: req.body.selected_options ?? req.body.options,
      legacyTotalPrice: req.body.total_price
    }),
    assertBookableSlot(req.body.reservation_date, req.body.reservation_time, req.body.timezone)
  ]);

  const payload = {
    client_request_id: req.body.client_request_id,
    asset_id: req.body.asset_id ?? quote.subtype.id,
    service_type_id: quote.serviceType.id,
    subtype_id: quote.subtype.id,
    pricing_tier_id: quote.pricingTier?.id ?? null,
    service_type: quote.serviceType.key,
    subtype: quote.subtype.label,
    tier: quote.pricingTier?.key ?? req.body.tier ?? null,
    options: quote.optionSnapshots,
    name: req.body.name ?? profile.name ?? 'Guest',
    phone: req.body.phone ?? profile.phone ?? null,
    address: req.body.address ?? profile.address ?? null,
    detail_address: req.body.detail_address ?? req.body.addressDetail ?? profile.address_detail ?? null,
    reservation_date: req.body.reservation_date,
    reservation_time: req.body.reservation_time,
    timezone: req.body.timezone,
    memo: req.body.memo ?? null,
    symptom: req.body.symptom ?? null,
    total_price: quote.totalPrice,
    price_source: quote.priceSource,
    user_id: req.user!.id,
    legacy_user_id: req.user!.legacyUserId ?? null,
    is_guest: Boolean(profile.is_guest),
    status: '대기'
  };

  const { data, error } = await supabaseAdmin.from('bookings').insert(payload).select('*').single();
  if (error?.code === '23505') {
    const detail = `${error.message} ${error.details ?? ''}`;
    const duplicateSubmission = detail.includes('client_request_id');
    throw new HttpError(
      409,
      duplicateSubmission ? 'This booking was already submitted' : 'Time slot is already booked',
      duplicateSubmission ? 'DUPLICATE_BOOKING' : 'BOOKING_SLOT_UNAVAILABLE'
    );
  }
  if (error) throw new HttpError(400, error.message, 'BOOKING_CREATE_FAILED');
  res.status(201).json(toBookingResponse(data));
}

export async function getBookingHistory(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('reservation_date', { ascending: false });

  if (error) throw new HttpError(400, error.message, 'BOOKING_HISTORY_FAILED');
  res.json((data ?? []).map(toBookingResponse));
}

export async function getBookingDetail(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .maybeSingle();
  if (error || !data) throw new HttpError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
  res.json(await addServiceLabel(data));
}

export async function cancelBooking(req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .update({ status: '취소' })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .in('status', ACTIVE_STATUSES)
    .select('*')
    .maybeSingle();
  if (error) throw new HttpError(400, error.message, 'BOOKING_CANCEL_FAILED');
  if (!data) throw new HttpError(409, 'Booking cannot be cancelled', 'BOOKING_NOT_CANCELLABLE');
  res.json(toBookingResponse(data));
}

export async function getAvailableTimeSlots(req: Request, res: Response) {
  const date = String(req.query.date);
  const [{ data: configured, error: slotError }, { data: bookings, error: bookingError }] = await Promise.all([
    supabaseAdmin.from('timeslots').select('date, type, slots'),
    supabaseAdmin
      .from('bookings')
      .select('reservation_time')
      .eq('reservation_date', date)
      .in('status', ACTIVE_STATUSES)
  ]);
  if (slotError || bookingError) {
    throw new HttpError(503, slotError?.message ?? bookingError?.message ?? 'Availability failed', 'AVAILABILITY_FAILED');
  }

  const exact = (configured ?? []).find((row) => row.date === date);
  const fallback = (configured ?? []).find((row) => row.date === null || row.type === 'generic');
  const slots = normalizeSlots(exact?.slots ?? fallback?.slots ?? []);
  const taken = new Set((bookings ?? []).map((booking) => booking.reservation_time));
  res.json(
    slots.map((time) => ({
      time,
      available: !taken.has(time) && !isSlotInPast(date, time, 'Asia/Seoul')
    }))
  );
}

export function toBookingResponse(row: Record<string, any>) {
  const options = Array.isArray(row.options)
    ? row.options.map((option: any) => ({
        ...option,
        option: option.key ?? option.option_id ?? option.option,
        optionLabel: option.label ?? option.optionLabel,
        choice: option.value ?? option.choice,
        choiceLabel: option.selected_label ?? option.choiceLabel,
        selectedLabel: option.selected_label ?? option.selectedLabel,
        extraCost: Number(option.extra_cost ?? option.extraCost ?? 0)
      }))
    : [];
  return {
    ...row,
    options,
    _id: row.id,
    userId: row.legacy_user_id,
    serviceType: row.service_type,
    serviceTypeId: row.service_type_id,
    subtypeId: row.subtype_id,
    pricingTierId: row.pricing_tier_id,
    reservationDate: row.reservation_date,
    reservationTime: row.reservation_time,
    totalPrice: row.total_price,
    detailAddress: row.detail_address,
    isGuest: row.is_guest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serviceLabel: row.service_label ?? row.service_type
  };
}

async function addServiceLabel(row: Record<string, any>) {
  if (!row.service_type_id) return toBookingResponse(row);
  const { data } = await supabaseAdmin
    .from('service_types')
    .select('label')
    .eq('id', row.service_type_id)
    .maybeSingle();
  return toBookingResponse({ ...row, service_label: data?.label ?? row.service_type });
}
