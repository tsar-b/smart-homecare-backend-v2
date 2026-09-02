import { z } from 'zod';

export const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(50).optional(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  address: z.string().trim().min(1).max(500).optional(),
  addressDetail: z.string().trim().max(500).optional()
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

export const RefreshSessionSchema = z
  .object({
    refresh_token: z.string().min(1).max(4096).optional(),
    refreshToken: z.string().min(1).max(4096).optional()
  })
  .refine((value) => Boolean(value.refresh_token ?? value.refreshToken), {
    message: 'refresh_token is required'
  })
  .transform((value) => ({ refresh_token: value.refresh_token ?? value.refreshToken! }));

export const UpdatePasswordSchema = z.object({
  password: z.string().min(8).max(200)
});

export const AppleLoginSchema = z.object({
  identityToken: z.string().min(20).max(20_000),
  authorizationCode: z.string().max(10_000).optional(),
  nonce: z.string().max(500).optional(),
  name: z.string().trim().min(1).max(120).optional()
});

const ShippingAddressSchema = z.object({
  base_address: z.string().max(500).optional(),
  detail_address: z.string().max(500).optional(),
  baseAddress: z.string().max(500).optional(),
  detailAddress: z.string().max(500).optional()
});

export const KakaoLoginSchema = z.object({
  accessToken: z.string().min(20).max(20_000),
  shippingAddr: ShippingAddressSchema.nullish()
});
