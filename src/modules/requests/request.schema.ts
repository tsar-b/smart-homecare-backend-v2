import { z } from 'zod';

export const CreateRequestSchema = z.object({
  client_request_id: z.string().uuid(),
  category_id: z.string().optional(),
  service_type_id: z.string().optional(),
  subtype_id: z.string().optional(),
  pricing_tier_id: z.string().optional(),
  option_ids: z.array(z.string()).max(20).default([]),
  name: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  detail_address: z.string().max(500).optional(),
  symptom: z.string().max(2000).optional(),
  memo: z.string().max(2000).optional(),
  reservation_date: z.string().min(1).max(40),
  reservation_time: z.string().min(1).max(40),
  timezone: z.string().min(1).max(80).default('Asia/Seoul')
});

export const RequestParamsSchema = z.object({
  id: z.string().min(1).max(200)
});
