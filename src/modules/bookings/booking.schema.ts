import { z } from 'zod';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine(
  (value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  },
  'Invalid calendar date'
);

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const TimezoneSchema = z.string().min(1).max(80).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  },
  'Expected an IANA timezone'
);

const SelectedOptionSchema = z
  .object({
    option_id: z.string().min(1).optional(),
    _id: z.string().min(1).optional(),
    option: z.string().min(1).optional(),
    value: z.string().max(200).optional(),
    selectedValue: z.string().max(200).optional(),
    choice: z.string().max(200).optional()
  })
  .refine((value) => Boolean(value.option_id ?? value._id ?? value.option), {
    message: 'Each selected option requires an option ID'
  })
  .refine((value) => Boolean(value.value ?? value.selectedValue ?? value.choice), {
    message: 'Each selected option requires a selected value'
  });

export const CreateBookingSchema = z.object({
  client_request_id: z.string().uuid(),
  asset_id: z.string().optional(),
  subtype_id: z.string().optional(),
  service_type_id: z.string().optional(),
  pricing_tier_id: z.string().optional(),
  service_type: z.string().min(1).max(120).optional(),
  subtype: z.string().max(120).optional(),
  tier: z.string().max(120).optional(),
  options: z.array(SelectedOptionSchema).max(30).default([]),
  selected_options: z.array(SelectedOptionSchema).max(30).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  detail_address: z.string().max(500).optional(),
  addressDetail: z.string().max(500).optional(),
  reservation_date: IsoDateSchema,
  reservation_time: TimeSchema,
  timezone: TimezoneSchema.default('Asia/Seoul'),
  memo: z.string().max(2000).optional(),
  symptom: z.string().max(2000).optional(),
  total_price: z.number().int().min(-1).optional()
}).refine((value) => Boolean(value.subtype_id ?? value.asset_id ?? value.subtype), {
  message: 'A subtype reference is required',
  path: ['subtype_id']
}).refine((value) => Boolean(value.service_type_id ?? value.service_type), {
  message: 'A service type reference is required',
  path: ['service_type_id']
});

export const BookingParamsSchema = z.object({
  id: z.string().min(1).max(200)
});

export const AvailabilityQuerySchema = z.object({
  date: IsoDateSchema.optional().default(todayInSeoul)
});

function todayInSeoul() {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric'
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
