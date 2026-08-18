import { z } from 'zod';

export const RegisterSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200)
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200)
});

export const GuestRegisterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(50),
  address: z.string().trim().min(1).max(500),
  addressDetail: z.string().trim().max(500).optional()
});
