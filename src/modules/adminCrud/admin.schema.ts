import { z } from 'zod';

export const AdminTableParamsSchema = z.object({
  table: z.string().min(1).max(80)
});

export const AdminRowParamsSchema = AdminTableParamsSchema.extend({
  id: z.string().min(1).max(200)
});

export const AdminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().min(1).max(80).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
  status: z.string().min(1).max(80).optional(),
  dateFrom: z.string().min(1).max(40).optional(),
  dateTo: z.string().min(1).max(40).optional(),
  search: z.string().min(1).max(120).optional()
});

export const AdminUpdateSchema = z.record(z.unknown()).refine(
  (body) => {
    const blocked = new Set(['id', 'user_id', 'legacy_user_id', 'password', 'password_hash', 'is_admin']);
    return Object.keys(body).every((key) => !blocked.has(key));
  },
  {
    message: 'Request contains protected fields'
  }
);

const AdminDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AdminBookingFilterSchema = z.object({
  start: AdminDateSchema.optional(),
  end: AdminDateSchema.optional(),
  startDate: AdminDateSchema.optional(),
  endDate: AdminDateSchema.optional(),
  status: z.enum(['대기', '확정', '완료', '취소', 'pending', 'confirmed', 'approved', 'completed', 'cancelled']).optional()
}).refine((value) => Boolean(value.start ?? value.startDate) && Boolean(value.end ?? value.endDate), {
  message: 'start and end dates are required'
});

export const AdminBookingUpdateSchema = z.object({
  status: z.enum(['대기', '확정', '완료', '취소', 'pending', 'confirmed', 'approved', 'completed', 'cancelled']).optional(),
  totalPrice: z.number().int().min(-1).optional(),
  total_price: z.number().int().min(-1).optional(),
  options: z.array(z.unknown()).max(30).optional()
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), {
  message: 'At least one booking field is required'
});

export const AdminRoleUpdateSchema = z.object({
  isAdmin: z.boolean().optional(),
  is_admin: z.boolean().optional()
}).refine((value) => value.isAdmin !== undefined || value.is_admin !== undefined, {
  message: 'isAdmin is required'
});
