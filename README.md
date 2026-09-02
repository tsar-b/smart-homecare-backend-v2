# Smart HomeCare Backend v2

SHC v2 is the Supabase/PostgreSQL replacement for the live MongoDB v1 backend.
MongoDB is not a runtime dependency. The v1 source is retained under
`legacy/mongo-v1/` only for behavior comparison and rollback during cutover.

## Implemented MVP

- Supabase Auth sessions for email/password, guest, Kakao, and Apple identities
- automatic linkage of the three migrated SHC profiles to Supabase Auth
- migrated service catalog, pricing, options, assets, and time slots
- server-calculated catalog pricing with legacy request compatibility
- booking history, detail, cancellation, and live availability
- PostgreSQL-enforced identity, submission, and active-slot uniqueness
- durable idempotency claim and completed-response replay
- explicit admin booking/user APIs and allowlisted catalog CRUD with audit logs
- v1 frontend route and response aliases during the cutover
- health, readiness, OpenAPI, migration, verification, and live smoke tooling

## Local Setup

Use Node.js 22 or newer.

```bash
npm ci
npm run env:bootstrap -- \
  --project-ref YOUR_PROJECT_REF \
  --secrets-file /absolute/path/to/private-secrets.md
npm run build
npm test
npm run dev
```

The secrets file must contain a line labeled `Access Token` with a Supabase
Management API access token. The bootstrap command retrieves the project's API
keys, probes them, selects a working public/admin pair, and writes an ignored
mode-0600 `.env`. It never prints key values.

The API starts on `http://localhost:5050` by default. Port 5000 is avoided
because macOS commonly reserves it for AirPlay Receiver.

## Database

Apply migrations in numeric order. Existing SHC data is preserved.

```bash
npm run db:migrate -- \
  --file database/migrations/005_booking_integrity.sql \
  --dry-run \
  --project-ref YOUR_PROJECT_REF \
  --secrets-file /absolute/path/to/private-secrets.md
```

Remove `--dry-run` only after it passes. Verify the live database border with:

```bash
npm run db:verify-border -- \
  --project-ref YOUR_PROJECT_REF \
  --secrets-file /absolute/path/to/private-secrets.md
```

## Booking Contract

`POST /api/bookings` requires:

- a Supabase access token in `Authorization: Bearer ...`
- an `Idempotency-Key` header, reused only for an identical retry
- the same UUID in `client_request_id`
- canonical service, subtype, and pricing identifiers from the catalog API

The API calculates prices from Supabase catalog rows. PostgreSQL remains the
final authority for duplicate identities, duplicate submissions, invalid
catalog references, and active-slot collisions under concurrency.

## Verification

```bash
npm run build
npm test
npm audit --omit=dev
npm run test:live
```

`test:live` targets `PUBLIC_API_URL` or `SMOKE_API_URL`. It creates isolated
temporary users and bookings, tests concurrent slot contention and admin CRUD,
then removes its Auth users, profiles, bookings, idempotency rows, and audit
records. Run it only against a test-capable environment where registrations can
receive a session (`AUTH_EMAIL_AUTO_CONFIRM=true` is suitable locally).

The machine-readable contract is served at `/openapi.json`. Frontend integration
notes are in `docs/FRONTEND_HANDOFF.md`; deployment steps are in
`docs/DEPLOYMENT.md`.

## Secret Boundary

`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, the database password, and
the Supabase Management API token are backend-only credentials. Never place any
of them in Expo, React Native, browser code, Git, screenshots, or chat. A
publishable/anon key is the only Supabase key that may be shipped to a client,
although this frontend should call the SHC API rather than query tables directly.

Do not delete the MongoDB project immediately after deployment. Keep a final
backup and a short rollback window; remove it only after v2 writes and reads have
been verified in production.
