# SHC v2 Deployment

## Required Environment

Set these in the hosting provider's encrypted environment settings:

```text
NODE_ENV=production
PORT=5050
PUBLIC_API_URL=https://api.example.com
CORS_ORIGINS=https://app.example.com
TRUST_PROXY=true
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
```

If the project's modern secret key is rejected by the Supabase gateway, use
`SUPABASE_SERVICE_ROLE_KEY` instead. The local bootstrap command probes both and
selects the working one. Never configure both a stale secret and a working
service-role key because the backend deliberately prefers the modern secret.

Optional provider settings:

```text
AUTH_EMAIL_AUTO_CONFIRM=false
OAUTH_SESSION_EMAIL_DOMAIN=auth.example.com
APPLE_CLIENT_IDS=com.example.ios,com.example.web
KAKAO_REST_API_KEY=...
KAKAO_ADMIN_KEY=...
```

Use `AUTH_EMAIL_AUTO_CONFIRM=true` only for local or controlled testing unless
the product intentionally accepts unverified email ownership.

## Release Order

1. Back up MongoDB and Supabase.
2. Dry-run every unapplied SQL file in `database/migrations/`.
3. Apply migrations and run `npm run db:verify-border`.
4. Deploy the backend with `npm ci && npm run build` and `npm start`.
5. Configure the health check as `/ready` and liveness check as `/health`.
6. Run `SMOKE_API_URL=https://... npm run test:live` in a test-capable deployment.
7. Point a staging frontend at the backend and verify all login providers.
8. Release the frontend, monitor errors, and retain the v1 rollback path.

The included Dockerfile builds a production image as the non-root `node` user.
The server listens on `0.0.0.0` through Node's default HTTP binding.

## Manual Provider Tests

Automated tests cannot mint real Apple or Kakao user tokens. Before production:

- sign in with Apple on a physical iOS device
- sign in with Kakao and confirm nickname/phone/address behavior
- delete one disposable account for each provider
- confirm Kakao unlink when `KAKAO_ADMIN_KEY` is configured
- verify email confirmation and password reset email delivery

## Rollback

The database migrations are additive except for stricter booking constraints.
Do not reverse them during an incident. Roll the API/frontend back while keeping
Supabase intact, then diagnose from request IDs and backend logs. Keep MongoDB
read-only during the rollback window to avoid two writable sources of truth.
