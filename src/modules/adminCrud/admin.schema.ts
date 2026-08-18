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
