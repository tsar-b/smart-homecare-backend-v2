# Standard email/password login fix

## Scope

Fixes the existing standard login, not social-provider setup or a new product
feature. The reported Mac symptom was unknown, so these findings are reproduced
code defects rather than a claim to have reproduced that particular device event.

- Supabase email-confirmation errors now return `EMAIL_CONFIRMATION_REQUIRED`.
- Rate limits, disabled email login, restricted accounts, malformed responses and
  Auth service failures no longer collapse into incorrect-password responses.
- Only `invalid_credentials` can enter the V1 password migration fallback.
- A linked Supabase account can no longer have its password overwritten using a
  leftover V1 password hash. Such accounts must use their current password or the
  recovery flow. Truly unlinked V1 accounts retain the existing migration path.
- Mobile customer-safe errors distinguish these cases in Korean and English.
  Raw provider messages and credentials are not rendered.

## Verification

- 75 frontend automated tests and frontend TypeScript check passed.
- Backend TypeScript build and all 82 compiled backend tests passed, including
  11 new real-controller / installed-Auth-SDK tests with mocked network/storage.
- The Windows sandbox's `tsx` launcher hit `uv_os_get_passwd` / `ENOMEM`; running
  the TypeScript-compiled test modules with Node succeeded. This does not establish
  physical RAM exhaustion or a runtime application failure.
- A temporary loopback HTTP server ran the updated backend against the configured
  Supabase project. The production frontend `createV2Api` client and adapters
  exercised login, authenticated profile read, token refresh and another profile
  read using the existing dedicated, linked, confirmed QA member. All passed.
- One deliberately incorrect QA password returned `401 INVALID_LOGIN`; the
  existing valid test session remained usable.
- No accounts were created/deleted, passwords changed, booking/media records
  modified, or OAuth settings changed by live verification. The temporary server
  was closed. No credential/session values were printed.

## Mac handoff boundary

Both updated backend and frontend sources are required for the corrected behavior
and localized messages. Restart the backend and reload/rebuild the app as needed.
Ensure the app's public API origin points to that running backend; a physical
phone cannot use the laptop's loopback address as its own backend.

This verification is live API evidence plus mocked native-session persistence
coverage, not a fresh Android/iOS UI run or store release. No commit, push, public
deployment, shared migration, or provider configuration was performed in this pass.
