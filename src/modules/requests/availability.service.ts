import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

const BLOCKING_STATUSES = ['pending', 'confirmed', 'approved'];

export async function assertRequestSlotAvailable(reservationDate: string, reservationTime: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('id')
    .eq('reservation_date', reservationDate)
    .eq('reservation_time', reservationTime)
    .in('status', BLOCKING_STATUSES)
    .limit(1);

  if (error) throw new HttpError(400, error.message, 'AVAILABILITY_CHECK_FAILED');
  if (data?.length) throw new HttpError(409, 'Time slot is already booked', 'REQUEST_SLOT_UNAVAILABLE');
}
