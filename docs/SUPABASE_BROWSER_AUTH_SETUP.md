# Supabase browser authentication - September 14, 2026

## Current evidence

Implementation supports Kakao, Apple and Google through Supabase Auth PKCE,
plus email password recovery. Existing V1-compatible authentication endpoints
remain available; this is not an automatic migration of legacy social accounts.

A read-only call to the configured project's Auth settings on September 14
returned HTTP 200: Kakao false, Apple false, Google false, email true. The local
backend provider opt-in is empty. No provider settings were changed and no
reset emails were sent by this implementation run.

## Required configuration

1. Review and apply `database/migrations/008_google_auth_identity.sql` after 007.
   It extends the identity provider constraint and service-only RPC to Google,
   preserving the identity ownership/conflict rules from migration 004. This
   migration has been prepared, not applied to the shared project in this run.
   Execute it as one database transaction using the existing migration tooling.
2. In Supabase Authentication / Sign In / Providers, configure and enable:
   - Kakao: REST API key (client ID), Kakao Login client secret and consent items.
   - Apple: Apple Services ID and a valid generated OAuth client-secret JWT.
     Generating/renewing that JWT requires the Apple Team ID, Key ID and private
     Sign in with Apple key. Maintain its expiry/rotation procedure.
   - Google: Web application OAuth client ID and client secret; configure the
     consent screen and eligible test users while the Google app is in testing.
3. Each provider's redirect URI must be the project's Supabase callback:
   `https://<project-ref>.supabase.co/auth/v1/callback`, not the SHC API address.
4. Configure Supabase's allowed return URLs for the exact native callback route
   `smarthomecareapplication://auth/callback` and the final web callback route
   `https://<owned-web-host>/auth/callback`. The app adds a random `state` query
   parameter: verify that the allowlist accepts that query and returns it
   unchanged. If a pattern is needed, scope it to that exact host/path and query;
   do not allow arbitrary production hosts or all application paths.
5. Add private backend configuration only after the corresponding providers work:

   ```dotenv
   SUPABASE_OAUTH_PROVIDERS=kakao,apple,google
   AUTH_REDIRECT_URLS=smarthomecareapplication://auth/callback,https://<owned-web-host>/auth/callback
   ```

   `AUTH_REDIRECT_URLS` contains exact URLs, no wildcard/query/fragment. For
   development, an exact localhost callback can be added in non-production.
   Match web origins in CORS and serve the application at `/auth/callback` too.
6. Configure reliable Supabase Auth email delivery and the recovery template.
   Keep the generated confirmation link intact so PKCE and state survive.
   Recovery links must be opened on the same device and, for web, in the same
   browser tab/session that requested them. The local pending-flow lifetime is
   30 minutes; the Supabase code/link can expire sooner.
7. Rebuild the Android/iOS development client to include `expo-web-browser`
   after pulling the frontend dependency changes. Verify the custom scheme in
   the actual built binary. A web export is not a native-build verification.

Do not put provider secrets, Apple private keys, service-role keys, recovery
links or access tokens into the mobile/web bundle, screenshots, chat or Git.
Place secrets in Supabase's provider settings or an explicitly private file.

## Protocol and account safety

- App-generated PKCE S256 verifier and random state are kept in SecureStore on
  native, or sessionStorage for the web flow. Credentials are not URL parameters.
- The API accepts only explicit providers and exact allowlisted return URLs.
- Callback parsing rejects different origins/paths, absent/mismatched/duplicate
  state, duplicate codes, token-bearing fragments and expired local flows.
- The backend exchanges the code using the public Auth key, obtains the verified
  provider identity from Supabase, then resolves the SHC profile server-side.
- Existing legacy synthetic identities may conflict with a newly created
  Supabase social account. They must not be reassigned, deleted or merged by
  client-supplied email. Resolve ownership with a reviewed migration before
  retiring the old routes. Test both new and existing social accounts.
- Recovery uses the exchanged user's access token to change that user's password;
  it does not use an admin password override or activate an SHC app session.
- The recovery request response intentionally does not disclose account existence.
  A generic accepted response does not prove email delivery.

## Verification boundary

69 backend tests and the TypeScript build passed during implementation. New
tests use mocked Auth HTTP responses and cover provider opt-in, callback
allowlisting, verified identity ownership, generic recovery responses, user-token
password update and invalid-code rejection. They do not prove provider consent,
SMTP delivery, native return-link handling or live identity migration.

Before launch, test each provider on fresh Android and iOS builds: success,
cancel, denial, warm/cold return, duplicate return and existing-account conflict.
Test recovery with an explicitly authorized QA account: delivery, expiry,
already-used link, wrong device, password policy, then fresh email sign-in.
Retain QA records and media unless deletion is explicitly authorized.

## Official references

- [Supabase Kakao setup](https://supabase.com/docs/guides/auth/social-login/auth-kakao)
- [Supabase Apple setup](https://supabase.com/docs/guides/auth/social-login/auth-apple)
- [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
