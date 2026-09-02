import { z } from 'zod';

export const UpdateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(7).max(50).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    addressDetail: z.string().trim().max(500).nullable().optional(),
    address_detail: z.string().trim().max(500).nullable().optional(),
    password: z.string().min(8).max(200).optional()
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one profile field is required'
  });
