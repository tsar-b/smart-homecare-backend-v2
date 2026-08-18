import { z } from 'zod';

export const CreateBookingSchema = z.object({
  client_request_id: z.string().uuid(),
  asset_id: z.string().optional(),
  service_type: z.string().min(1).max(120).optional(),
  subtype: z.string().max(120).optional(),
  name: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  detail_address: z.string().max(500).optional(),
  reservation_date: z.string().min(1),
  reservation_time: z.string().min(1),
  memo: z.string().max(2000).optional(),
  total_price: z.number().int().nonnegative().optional()
});
