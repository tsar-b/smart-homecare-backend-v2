import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.string().default('development'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:5000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  TRUST_PROXY: z.coerce.boolean().default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),
  APP_INITIALIZE_CACHE_TTL_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(24),
  KAKAO_REST_API_KEY: z.string().optional(),
  KAKAO_ADMIN_KEY: z.string().optional()
}).superRefine((value, context) => {
  if (!value.SUPABASE_SECRET_KEY && !value.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required',
      path: ['SUPABASE_SECRET_KEY']
    });
  }
});

export const env = EnvSchema.parse(process.env);
