# Google Auth setup and Mac handoff - October 1, 2026

This is a development-test handoff, not a production release or a completed
Google user sign-in. It supersedes the pending Google setup observations in
`SUPABASE_BROWSER_AUTH_SETUP.md`; that document remains a historical checkpoint.

## Shared project configuration completed

For the existing SHC Supabase project `ixnwmvznoptjbfnrgfbn`:

- Google browser OAuth is enabled with the newly supplied Web application client
  ID and client secret. Credentials are stored in Supabase, not this repository.
- Kakao and Apple provider settings were left unchanged and remain disabled.
- The native return allowlist includes the exact callback and its narrowly
  scoped state-query pattern:

  ```text
  smarthomecareapplication://auth/callback
  smarthomecareapplication://auth/callback\?state=*
  ```

- Migration `008_google_auth_identity.sql` was applied in one transaction with
  lock/statement timeouts. Before applying, the live identity function body was
  compared with migration 004 and matched. Afterward, it matched 008, and the
  identity constraint accepted Google.
- The identity RPC remains executable only by the backend service role, not
  `anon` or `authenticated`. Identity-table RLS remains enabled. Neither client
  role can create objects in `public` or `auth`.
- The Security Advisor returned the same pre-existing
  `auth_leaked_password_protection` warning before and after the change. It was
  not silently enabled or treated as a passing production-security audit.

Do not reapply migrations 007 or 008 solely because you cloned code on the Mac.
These observations apply to the shared project above, not a fresh project.
No application user, booking or media records were deleted by this setup.

## Backend on the Mac

Preserve local changes and private environment files. Pull `main` with
`git pull --ff-only`; if the checkout diverges, inspect it instead of resetting.
Use Node.js 22 or newer (the Windows checks used Node 24).

Keep the existing private Supabase server configuration. Add these non-secret
settings to the backend `.env`, preserving any other intended return URLs:

```dotenv
SUPABASE_OAUTH_PROVIDERS=google
AUTH_REDIRECT_URLS=smarthomecareapplication://auth/callback
```

Then run:

```bash
npm ci
npm run build
npm test
npm run dev
```

Check `GET /ready` and `GET /api/auth/browser/config`. The first must be healthy;
the second should advertise only `google` plus password recovery. This requires
a running backend: GitHub stores source, not a hosted API.

The Google provider secret is already configured in the shared Supabase project.
Do not copy it into `EXPO_PUBLIC_*`, the frontend, a screenshot, or Git. The Mac
does not need the whole private credential notebook merely to run Google OAuth.
The backend still needs its own private Supabase publishable/anon and server key.

## Verification performed

- TypeScript build and 82 backend tests passed.
- The real frontend API adapter reached a freshly started backend, whose
  readiness checks passed for Auth, Database and Storage.
- The browser-provider response offered only Google. Starting OAuth produced a
  PKCE request to the correct Supabase project and a redirect to Google with the
  project callback. Google's initial page returned HTTP 200, with no known
  client/redirect error detected. This does not validate a successful code exchange.
- A controlled provider-denial callback returned to the native SHC route with
  the original app state. No Google account was selected or consent granted.
- Existing-QA-account email login, profile access, refresh, and profile access
  after refresh passed. One wrong-password attempt returned `INVALID_LOGIN`,
  without disrupting the valid session. No account was created or password changed.

## Remaining Mac acceptance test

Follow the frontend's matching `GOOGLE_AUTH_MAC_HANDOFF_2026-10-01.md` and rebuild
the iOS development client. Test a real Google sign-in, profile/session creation,
app relaunch, sign-out, repeat sign-in, cancellation, and warm/cold callback returns.
Only a real successful OAuth exchange verifies Google's client secret and the
complete identity creation path. This setup did not establish that result.

If Google blocks the tester, inspect the Google Auth Platform audience, tester
access and exact authorized redirect URI. Do not weaken callback checks or
change account ownership to get around an error. The registered provider URI is:

```text
https://ixnwmvznoptjbfnrgfbn.supabase.co/auth/v1/callback
```

Kakao/Apple migration, recovery-email delivery, production deployment, and store
submission remain separate work. Existing synthetic social identities must not
be deleted, reassigned or merged by untrusted email to bypass conflicts.
