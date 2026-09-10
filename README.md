# Smart HomeCare Backend v2

For the verified Android integration results and current Mac setup checklist,
see [live QA and Mac handoff](docs/LIVE_QA_MAC_HANDOFF_2026-09-11.md).

SHC v2 is the Supabase/PostgreSQL replacement for the live MongoDB v1 backend.
MongoDB is not a runtime dependency. The v1 source is preserved in the dedicated
v1 repositories and this repository's Git history, rather than packaged in the
v2 tree. See [V1 preservation](docs/V1_PRESERVATION.md) for the pinned source
commits and pre-cutover evidence checklist.

## Implemented MVP

- Supabase Auth sessions for confirmed email/password, Kakao, and Apple identities
- confirmed-login linkage of migrated standard profiles to Supabase Auth
- fail-closed guest registration until phone OTP verification is implemented
- migrated service catalog, pricing, options, assets, and time slots
- server-calculated canonical pricing with client-price compatibility isolated to the legacy route
- booking history, detail, cancellation, and live availability
- private customer booking photos/videos with signed uploads, pilot-gated resumable TUS, and expiring downloads
- PostgreSQL-enforced identity, submission, and active-slot uniqueness
- durable idempotency claim and completed-response replay
- explicit admin booking/user APIs and allowlisted catalog CRUD with best-effort operational audit logs
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
  --file database/migrations/007_booking_attachments.sql \
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

Provision the two private Storage buckets through the Storage API, then verify
their privacy, MIME allowlists, and limits without making changes:

```bash
npm run storage:ensure-booking-media
npm run storage:ensure-booking-media -- --check
```

## Booking Contract

`POST /api/bookings` requires:

- a Supabase access token in `Authorization: Bearer ...`
- an `Idempotency-Key` header, reused only for an identical retry
- the same UUID in `client_request_id`
- `service_type_id`, `subtype_id`, and `pricing_tier_id` from the catalog API

The canonical API rejects `total_price` and calculates prices from Supabase
catalog rows. Temporary V1 client-price compatibility exists only on deprecated
`POST /api/booking`; new clients must never use that route. The API validates
catalog relationships, while PostgreSQL remains the final authority for
duplicate identities, duplicate submissions, catalog-reference existence, and
active-slot collisions under concurrency.

## Private Booking Media

Create the booking first, then call
`POST /api/bookings/:bookingId/attachments/upload-intents` once per selected
file. The request's stable `clientAttachmentId` is the retry identity. Do not
add `Idempotency-Key` to this route: upload tokens and URLs must never be stored
in the generic completed-response replay table.

The backend chooses `signed_put` through 6 MiB (6,291,456 bytes) and signed-token
TUS above that threshold. All videos and all TUS intents return
`BOOKING_MEDIA_PILOT_DISABLED` unless
`ENABLE_BOOKING_MEDIA_PILOT_UPLOADS=true`; that flag defaults to false. TUS must
use a 6 MiB chunk and the returned token in
the `x-signature` header plus the returned public `storageApiKey` in the
`apikey` header. `x-upsert` remains false, and both upload transports
must store `cacheControl: "0"` (`max-age=0` in Storage object info). After
Storage succeeds, call the attachment `complete` endpoint; only media whose
stored byte count, MIME/cache metadata, and file signature match becomes
visible.

Completion performs a bounded header check, not full image/video decoding,
malware scanning, or server-side duration enforcement. The app's 60-second
video limit is UX only. Before untrusted media is shown to administrators in
production, add a sandboxed probe/transcode or scanning pipeline and verify its
output in staging.

Application and bucket limits use decimal bytes: 10,000,000 per image,
45,000,000 per video, six objects and two videos per booking, and 100,000,000
bytes total. The only supported types are JPEG, PNG, WebP, MP4, and QuickTime.
Each authenticated owner is additionally limited to 12 intent requests per
minute and 12 reserved rows/100,000,000 reserved bytes across bookings.
Migration 007 also installs a service-role-only project circuit breaker in
`booking_media_limits`, initially 100 rows/500,000,000 bytes. All states,
including tombstones, count until reconciliation. Raise either project value
only after provider capacity and billing limits, alerts, reconciliation, and
the observed object-size distribution have been verified.
Both buckets are private. Five-minute read URLs are generated only after an
ownership/admin check and are never persisted. Attachment list responses are
metadata-only; clients request a download URL only when opening one item.

Migration 007 also installs a restrictive `storage.objects` policy for these
two bucket IDs. This is required when the Supabase project is reused: an older
permissive authenticated policy must not accidentally expose booking media.
Ordinary anon/authenticated Storage list, read, insert, update, and delete calls
remain denied; the backend service role and path-bound signed capabilities are
the only media data paths.

Deletion uses a tombstone until all signed PUT/TUS write capabilities can no
longer recreate an object. Because the same signed token can initiate a TUS
session near the end of the token's two-hour life, every intent conservatively
retains a 26-hour write window plus grace, including an intent whose requested
transport was `signed_put`. Run this reconciler periodically (for example every
ten minutes) after every deployment build:

```bash
npm run storage:reconcile-booking-media
```

Never delete rows from `storage.objects` with SQL. Booking/user hard deletion
fails closed while a media tombstone is waiting for a write capability to
expire; retry it after reconciliation completes.

Supabase signed upload tokens are bearer capabilities and are not single-use.
One token can be replayed to start multiple resumable sessions for the same
path, so database row/byte caps bound terminal objects but do not bound
temporary multipart storage, request volume, or bandwidth. The pilot flag only
stops this API from advertising video/TUS intents; it cannot stop a malicious
holder from trying the signed token against Storage's TUS endpoint. Keep
video/TUS limited to a trusted closed pilot unless hard provider-side
budget/rate guards are configured. A public launch must keep the pilot flag off
or replace direct resumable upload with a single-use broker/proxy, and any
public direct-upload launch still needs provider spend/request guardrails.

Admin media actions write best-effort operational audit rows. Audit insertion
is not transactional with the media action and `audit_logs` is not an
append-only external sink, so these rows are not tamper-resistant compliance
evidence. Add an append-only external audit destination if that guarantee is
required.

Email-confirmed registration returns a session and profile. When confirmation
is pending, registration returns HTTP 202 with null token/profile fields; the
first confirmed login performs profile creation or migrated-profile linkage.
Guest registration returns `GUEST_VERIFICATION_REQUIRED` until phone OTP is
implemented. `DELETE /api/users/me` and `/api/kakao/delete` similarly return
`ACCOUNT_DELETION_UNAVAILABLE` until complete erasure and provider revocation
are implemented as a coordinated, resumable saga. The Kakao route performs no
media purge, provider unlink, or Auth deletion while disabled.

## Verification

```bash
npm run build
npm test
npm audit --omit=dev
npm run test:live
```

`test:live` targets `PUBLIC_API_URL` or `SMOKE_API_URL`. It creates isolated
temporary users and bookings, tests concurrent slot contention and admin CRUD,
asserts that guest registration and account deletion still fail closed, and
proves that an ordinary authenticated JWT cannot directly list/read/write the
two booking-media buckets. It then removes its Auth users, profiles, bookings,
Storage probes, idempotency rows, and audit records. Run it only against a
test-capable environment where registrations can receive a session
(`AUTH_EMAIL_AUTO_CONFIRM=true` is suitable only outside production;
production configuration rejects it).

The full media lifecycle is a separate, destructive staging smoke test. It
does not create or delete users/bookings: provide an active disposable booking,
its owner's access token, and a different user's token. It exercises signed
PUT, signed-token TUS, completion, owner downloads/deletes, non-owner denial,
and privileged fixture cleanup.

```bash
RUN_MEDIA_SMOKE=true \
SMOKE_API_URL=https://staging-api.example.com \
MEDIA_SMOKE_BOOKING_ID=DISPOSABLE_ACTIVE_BOOKING_ID \
MEDIA_SMOKE_OWNER_ACCESS_TOKEN=OWNER_TOKEN \
MEDIA_SMOKE_NONOWNER_ACCESS_TOKEN=OTHER_USER_TOKEN \
npm run test:live:media
```

The standard Supabase URL/public/admin environment variables are also
required, and the staging API must temporarily enable
`ENABLE_BOOKING_MEDIA_PILOT_UPLOADS`. Never point this command at production.
Neither live smoke command is
part of `npm test`, and a syntax/unit run is not evidence that either live smoke
passed. Record a live result only when the command was actually run with
staging credentials. The two-session database concurrency procedure is in
`database/tests/booking_attachments_concurrency.md`.

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

Removing the duplicate source archive does not retire API compatibility routes
or migration fields. Follow the [route retirement plan](docs/ROUTE_RETIREMENT_PLAN.md)
after client usage and data reconciliation have been verified.
