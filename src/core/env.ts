import 'dotenv/config';
import { z } from 'zod';

const BooleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const EnvSchema = z.object({
  PORT: z.coerce.number().default(5050),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:5050'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  TRUST_PROXY: BooleanString.default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),
  APP_INITIALIZE_CACHE_TTL_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  AUTH_EMAIL_AUTO_CONFIRM: BooleanString.default('false'),
  OAUTH_SESSION_EMAIL_DOMAIN: z.string().min(3).default('auth.shc.invalid'),
  KAKAO_REST_API_KEY: z.string().optional(),
  KAKAO_ADMIN_KEY: z.string().optional(),
  APPLE_CLIENT_IDS: z.string().optional()
}).superRefine((value, context) => {
  if (!value.SUPABASE_ANON_KEY && !value.SUPABASE_PUBLISHABLE_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required',
      path: ['SUPABASE_PUBLISHABLE_KEY']
    });
  }

  if (!value.SUPABASE_SECRET_KEY && !value.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required',
      path: ['SUPABASE_SECRET_KEY']
    });
  }

  if (value.NODE_ENV === 'production' && value.CORS_ORIGINS.split(',').map((origin) => origin.trim()).includes('*')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CORS_ORIGINS cannot contain * in production',
      path: ['CORS_ORIGINS']
    });
  }
});

export const env = EnvSchema.parse(process.env);
