import 'dotenv/config';
import { z } from 'zod';

const BooleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const OptionalEnvironmentString = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  },
  z.string().min(1).optional()
);

export const EnvSchema = z.object({
  PORT: z.coerce.number().default(5050),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:5050'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  TRUST_PROXY: BooleanString.default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  ENABLE_BOOKING_MEDIA_PILOT_UPLOADS: BooleanString.default('false'),
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),
  APP_INITIALIZE_CACHE_TTL_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: OptionalEnvironmentString,
  SUPABASE_PUBLISHABLE_KEY: OptionalEnvironmentString,
  SUPABASE_SECRET_KEY: OptionalEnvironmentString,
  SUPABASE_SERVICE_ROLE_KEY: OptionalEnvironmentString,
  AUTH_EMAIL_AUTO_CONFIRM: BooleanString.default('false'),
  OAUTH_SESSION_EMAIL_DOMAIN: z.string().min(3).default('auth.shc.invalid'),
  KAKAO_REST_API_KEY: OptionalEnvironmentString,
  KAKAO_ADMIN_KEY: OptionalEnvironmentString,
  APPLE_CLIENT_IDS: OptionalEnvironmentString
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

  const backendKeys = new Set(
    [value.SUPABASE_SECRET_KEY, value.SUPABASE_SERVICE_ROLE_KEY].filter(
      (candidate): candidate is string => Boolean(candidate)
    )
  );
  for (const [field, publicKey] of [
    ['SUPABASE_PUBLISHABLE_KEY', value.SUPABASE_PUBLISHABLE_KEY],
    ['SUPABASE_ANON_KEY', value.SUPABASE_ANON_KEY]
  ] as const) {
    if (!publicKey) continue;
    const legacyRole = decodeSupabaseJwtRole(publicKey);
    const knownPublicFormat = publicKey.startsWith('sb_publishable_') || legacyRole === 'anon';
    if (
      publicKey.startsWith('sb_secret_') ||
      backendKeys.has(publicKey) ||
      legacyRole === 'service_role' ||
      !knownPublicFormat
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be a Supabase publishable key or legacy anon-role JWT, never a backend key`,
        path: [field]
      });
    }
  }

  if (value.NODE_ENV === 'production' && value.AUTH_EMAIL_AUTO_CONFIRM) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AUTH_EMAIL_AUTO_CONFIRM cannot be enabled in production',
      path: ['AUTH_EMAIL_AUTO_CONFIRM']
    });
  }
});

function decodeSupabaseJwtRole(value: string) {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

export const env = EnvSchema.parse(process.env);
