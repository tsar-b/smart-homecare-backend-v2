# Smart HomeCare Backend v2

For the current atomic-booking rollout contract and mobile setup, see
[frontend handoff](docs/FRONTEND_HANDOFF.md). The
[September live QA and Mac handoff](docs/LIVE_QA_MAC_HANDOFF_2026-09-11.md)
records historical Android evidence, not acceptance of the October 13 changes.

SHC v2 is the Supabase/PostgreSQL replacement for the live MongoDB v1 backend.
MongoDB is not a runtime dependency. The v1 source is preserved in the dedicated
v1 repositories and this repository's Git history, rather than packaged in the
v2 tree. See [V1 preservation](docs/V1_PRESERVATION.md) for the pinned source
commits and pre-cutover evidence checklist.

## Implemented MVP

- Supabase Auth sessions for confirmed email/password and configured Google/Kakao/Apple identities (route support is not provider activation)
- confirmed-login linkage of migrated standard profiles to Supabase Auth
- fail-closed guest registration until phone OTP verification is implemented
- migrated service catalog, pricing, options, assets, and time slots
- server-calculated canonical pricing with client-price compatibility isolated to the legacy route
- booking history, detail, cancellation, and live availability
- private customer booking photos/videos with signed uploads, pilot-gated resumable TUS, and expiring downloads
- PostgreSQL-enforced identity, submission, and active-slot uniqueness
- atomic booking/receipt commit and durable original-response replay (requires the October 13 migration)
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

### October 13, 2026 booking-retry upgrade: required before this API

Apply `database/migrations/20261013042516_atomic_booking_retry.sql` **after
001-008 and before deploying this API revision**. As of this handoff, this new
migration has not been applied to the shared cloud project. Do not assume a
previous `/ready` result covers it, or rerun historical migrations just because
you cloned a repository.

1. Verify the exact target project and its applied migrations; use an approved
   isolated project for destructive acceptance tests.
2. Stop/drain the old booking-writing API instances. Do not run old and new
   booking writers simultaneously; the old response-finish finalizer does not
   participate in the new transaction protocol.
3. Dry-run the new migration with the existing migration tool. Its dry-run
   executes SQL inside a rolled-back transaction; it is not an offline linter.
4. Apply the reviewed migration once, then deploy/start only the compatible API.
   Keep bookings unavailable if the rollout or verification fails. Do not
   casually roll back to the old writable API after new receipts exist.
5. Check `/ready`, then run the controlled acceptance tests. The new readiness
   probe returns **503** while the retry RPCs or required database permissions
   are missing. `/health` may still return 200 because the process is alive.

```bash
npm run db:migrate -- \
  --file database/migrations/20261013042516_atomic_booking_retry.sql \
  --dry-run \
  --project-ref YOUR_APPROVED_PROJECT_REF \
  --secrets-file /absolute/path/to/private-secrets.md
```

Remove `--dry-run` only for a deliberate, approved application after successful
review and verification. Cloud application and latest native acceptance remain
separate from local unit, TypeScript and SQL test results.

The example below applies to the earlier media migration only when it is still
unapplied; it is not the latest booking-retry migration:

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

### Isolated Windows retry verification

`npm run test:booking-db` exercises the exact booking migrations against the
dedicated local PostgreSQL QA cluster. `npm run test:booking-http` first runs
that same SQL suite in a fresh retained database, then exercises production
Express middleware/controllers and the installed Supabase JS client through a
strict loopback provider fixture. Both require `SHC_RETRY_QA_ALLOW_LOCAL=yes`.

These opt-in scripts expect this workspace's sibling `work/shc-retry-qa` runner
on `127.0.0.1:55439`, the synthetic QA owner, and its exact verified data
directory. They deliberately reject unrelated database targets and never load
the application's `.env`. They are **not standalone Mac/cloud setup scripts**;
do not redirect them at a hosted project or production database. Test data and
JSON evidence are retained, not automatically deleted. Stop the owned local
runner after testing.

October 13 verification: **33/33 SQL checks** and **16/16 HTTP integration
checks** passed with Node 24.19.0, PostgreSQL 17.10, Supabase JS 2.113.0, and
Express 5.2.1. The SQL prerequisite in the HTTP run is repeated coverage, not
33 extra distinct tests. RPC transactions and database role permissions are
real; Auth identities, storage responses, and attachment readiness responses
are synthetic. This does not certify hosted PostgREST/Auth/Storage, media
transfers, or native Android/iOS behavior.

### Request identity and pricing

Both canonical `/api/bookings` and legacy `/api/booking` creation require a
member account. Guest-authenticated profiles cannot bypass this restriction
through the legacy alias. Existing authenticated history/detail access is
unchanged.

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

Scheduling uses the server-owned business timezone `Asia/Seoul` for both
availability and booking creation. `reservation_date` and `reservation_time`
are business-local wall-clock values; they are not converted from the device's
timezone. The optional `timezone` request field remains accepted for older
clients when it is a valid IANA timezone, but is normalized to `Asia/Seoul` for
new bookings. Unknown/invalid timezone values are still rejected. Switching
the UI language does not change the scheduling timezone. Existing booking
records are not rewritten by this policy correction.

### Atomic retry receipts

The new API commits the booking and its `booking_submission_receipts` row in
one PostgreSQL transaction. A lost response is retried with the **same user,
endpoint, Idempotency-Key, client_request_id and request body**. Do not change a
request's contents or mint a new UUID because a timeout leaves the commit
outcome unknown. A replay returns HTTP **201**, the original response snapshot,
and `Idempotency-Replayed: true`, even if that appointment is now in the past.
It is not a fresh booking and not a statement about its current status: refresh
booking detail/history after replay, particularly after cancellation or admin
changes. A receipt does not recreate an individually deleted booking.

- HTTP 409 `IDEMPOTENCY_CONFLICT`: a key/request ID was reused with a different
  request, scope or retry identity. Reconcile the original request first.
- HTTP 409 `BOOKING_RETRY_REVIEW_REQUIRED`: ambiguous pre-upgrade history may
  already contain the booking. Inspect booking history/support records before
  deliberately submitting anything new; do not automatically rotate IDs.
- HTTP 409 `BOOKING_SLOT_UNAVAILABLE` / `BOOKING_SLOT_IN_PAST`: the new booking
  cannot claim that slot. A committed identical replay is handled before these
  current-slot checks.
- HTTP 503 `IDEMPOTENCY_STORE_UNAVAILABLE`: the migration/store may be unavailable
  or a commit response uncertain. Preserve the draft and retry the same identity
  and body after the dependency recovers; there is no direct-insert fallback.

Receipts have **no automatic TTL or cleanup**. They retain a private copy of the
original booking response, including customer contact/address information; they
must not be exposed to ordinary client database roles, logs or public exports.
Their lifetime is independent of an individual booking's removal. Operators
must review retention and coordinated account erasure explicitly: deleting a
receipt can remove the protection against an old request becoming new again.
Do not add receipts to a generic TTL/reconciliation job.

### Apple/Kakao development hooks

The mobile development build can exercise Apple/Kakao through the existing
`/api/auth/oauth/start` and `/api/auth/oauth/exchange` browser-PKCE routes. These
are setup probes, not fake sessions. Both endpoints still enforce the backend
`SUPABASE_OAUTH_PROVIDERS` allowlist; provider credentials and enablement must
also be configured in Supabase before a real sign-in can succeed. A disabled
provider returns `OAUTH_PROVIDER_DISABLED`; an unregistered return URI returns
`AUTH_REDIRECT_INVALID`. Ordinary release sign-in lists only configured providers.
See the [frontend handoff](docs/FRONTEND_HANDOFF.md#browser-oauth-and-development-route-checks)
for callback and Mac rebuild requirements.

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
