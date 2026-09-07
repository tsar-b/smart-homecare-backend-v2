# SHC v2 Deployment

## Required Environment

Set these in the hosting provider's encrypted environment settings:

```text
NODE_ENV=production
PORT=5050
PUBLIC_API_URL=https://api.example.com
CORS_ORIGINS=https://app.example.com
TRUST_PROXY=true
ENABLE_BOOKING_MEDIA_PILOT_UPLOADS=false
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

Use `AUTH_EMAIL_AUTO_CONFIRM=true` only for local or controlled testing. The
backend rejects that setting when `NODE_ENV=production`.

`ENABLE_BOOKING_MEDIA_PILOT_UPLOADS` defaults to false. Keep it false for a
public deployment. Set it true only in a trusted closed-pilot environment after
the Storage provider's hard budget/rate controls and alerts have been verified;
it enables every video and every file that requires the TUS transport.

## Release Order

1. Back up MongoDB and Supabase.
2. Dry-run every unapplied SQL file in `database/migrations/`.
3. Apply migrations, including `007_booking_attachments.sql`, and run
   `npm run db:verify-border`. Treat the restrictive booking-media
   `storage.objects` policy as a release requirement, especially in a reused
   Supabase project.
4. Run `npm run storage:ensure-booking-media`, then verify with
   `npm run storage:ensure-booking-media -- --check`. This is intentionally a
   Storage API operation rather than direct SQL against `storage.objects`.
5. Deploy the backend with `npm ci && npm run build` and `npm start`.
6. Schedule `npm run storage:reconcile-booking-media` at least every ten
   minutes. It requires the built `dist/` tree. Run it once manually in staging,
   retain its output, and alert on non-zero exit or repeated `failed` counts.
   The release is incomplete without this schedule: expired intents and
   deletion/rejection tombstones otherwise keep user quota indefinitely.
7. Configure the health check as `/ready` and liveness check as `/health`.
   Readiness verifies Auth, both database tables, and the exact private bucket
   configuration, so it intentionally remains 503 until steps 3 and 4 finish.
   `/ready` does **not** prove the `storage.objects` policy boundary; use the
   database verifier and live Storage denial smoke for that.
8. Run `SMOKE_API_URL=https://... npm run test:live` in a test-capable
   deployment. This seeds private objects with the service credential and
   proves an ordinary authenticated user cannot list/read/insert/update/delete
   them.
9. Run the opt-in media lifecycle smoke against a disposable active staging
   booking with the pilot flag temporarily enabled as described below, then run
   every two-session concurrency and replay-abuse scenario in
   `database/tests/booking_attachments_concurrency.md`. Reset the public release
   configuration to `ENABLE_BOOKING_MEDIA_PILOT_UPLOADS=false` afterward.
10. Approve and document a ready-media retention period, the deletion job that
    enforces it, privacy-request handling, and dispute/legal holds. This is a
    production release requirement, not a future cleanup note.
11. Add a sandboxed media probe/transcode or malware-scanning boundary before
    administrators display untrusted originals. The current API validates only
    stored size, MIME/cache metadata, and a bounded header; the 60-second video
    limit is client UX, not a server guarantee. Verify the hosted `info()`
    representation of `cacheControl: "0"` is `max-age=0` (or another explicitly
    accepted zero form) in the staging media smoke.
12. Point a staging frontend at the backend and verify all login providers and
    one complete photo/video upload lifecycle.
13. Release the frontend, monitor errors, database reservations, final and
    temporary Storage usage, request/bandwidth spend, and reconciler runs, and
    retain the v1 rollback path.

The included Dockerfile builds a production image as the non-root `node` user.
The server listens on `0.0.0.0` through Node's default HTTP binding.

## Booking Media Storage

`shc-booking-images-v1` and `shc-booking-videos-v1` must both remain private.
Migration 007 must also leave
`shc_booking_media_deny_direct_client_access` as a **restrictive** policy for
`anon` and `authenticated` on `storage.objects`. This blocks both bucket IDs
even if the reused project already contains a broad permissive policy. The
backend checks booking ownership or administrator status and issues a
path-bound signed capability. Never put the service/secret key in the Expo
application, and do not replace the restrictive guard with a merely permissive
policy whose absence of a match can be defeated by another policy.

Bucket and database limits use decimal bytes: images 10,000,000 and videos
45,000,000. The resumable protocol uses a binary 6 MiB chunk (6,291,456 bytes),
as required by Supabase. The 45 MB video cap remains below the current 50 MB
per-file ceiling available to Supabase Free projects, but the project-level
global Storage limit must also permit it.

The database allows at most six rows/two videos/100,000,000 bytes per booking
and 12 rows/100,000,000 bytes per owner. A service-role-only singleton in
`public.booking_media_limits` is the project circuit breaker and starts at 100
rows/500,000,000 bytes. Every attachment state, including deleting/rejected
tombstones, counts. Inspect both the configuration and actual reservations
before and after deployment:

```sql
select singleton_key, max_reserved_rows, max_reserved_bytes, updated_at
from public.booking_media_limits;

select count(*) as reserved_rows,
       coalesce(sum(declared_size_bytes), 0) as reserved_bytes
from public.booking_attachments;
```

Do not expose this table through generic admin CRUD. Raise a circuit-breaker
value only through a controlled service-role operation after confirming
provider capacity/billing limits, reconciler and ready-media retention health,
alerts below the new ceiling, and actual object-size distribution. A database
increase without a provider hard budget is not cost protection.

Signed upload tokens last two hours. The same path-bound token can initiate a
resumable TUS URL even when the intended client transport was `signed_put`, and
that session can remain writable for up to 24 hours. A client could initiate it
near the end of the token lifetime, so every intent uses a conservative 26-hour
write window plus clock-skew grace (26 hours 5 minutes with the current values).
Attachment deletion first removes the object and hides the row, then retains a
`deleting` tombstone until that window has passed. Completion never shortens the
reservation because a parallel TUS session may still exist. The reconciler
removes the path again before deleting the tombstone. Administrative booking or
user deletion returns `ATTACHMENT_PURGE_PENDING` rather than deleting database
ownership while such a tombstone exists.

A signed upload token is replayable: one token may create multiple partial TUS
sessions for the same object path. Owner/project database limits bound terminal
objects, not temporary multipart bytes, request count, or bandwidth. The pilot
flag prevents this API from intentionally returning TUS/video workflows, but a
holder can still try a token issued for `signed_put` against the Storage TUS
endpoint. Therefore keep video/TUS in a trusted closed pilot unless the provider
has hard budget/rate enforcement and alerts. Public TUS requires either those
controls or a single-use upload broker/proxy; do not treat an application rate
limiter or database quota as equivalent.

Ready media is not automatically purged merely because a booking is cancelled
or completed. Before production, decide and document a customer-media retention
period, implement and schedule its deletion path, and account for privacy
requests plus legitimate service/dispute holds. Verify the job in staging and
alert on failures. Account erasure remains disabled until that policy,
attachment purge, and provider revocation are complete.

## Live Booking-Media Smoke

The normal `npm run test:live` requires a test deployment where email
registration immediately produces a session. It verifies bucket policy denial,
but deliberately does not upload customer attachments.

For the complete media lifecycle, first create two disposable confirmed staging
users and one empty, active booking owned by the first user. The booking must
have room for two files and at least 6,291,520 bytes. Export fresh access tokens
for both users and run:

```bash
RUN_MEDIA_SMOKE=true \
SMOKE_API_URL=https://staging-api.example.com \
MEDIA_SMOKE_BOOKING_ID=DISPOSABLE_ACTIVE_BOOKING_ID \
MEDIA_SMOKE_OWNER_ACCESS_TOKEN=OWNER_TOKEN \
MEDIA_SMOKE_NONOWNER_ACCESS_TOKEN=OTHER_USER_TOKEN \
npm run test:live:media
```

`SUPABASE_URL`, one public/publishable key, and one backend secret/service-role
key must also be configured. The script refuses to start unless
`RUN_MEDIA_SMOKE=true`, and the staging API must temporarily run with
`ENABLE_BOOKING_MEDIA_PILOT_UPLOADS=true`. It uploads a tiny JPEG through signed PUT and a
6 MiB-plus MP4 fixture through signed-token TUS, completes and downloads them,
confirms Storage reports zero cache lifetime, confirms lists stay metadata-only,
checks non-owner list/download/delete denial, invokes owner deletion, and then
uses the backend credential to remove its staging metadata/tombstones. That last
cleanup intentionally bypasses the normal 26-hour tombstone retention and is
acceptable only because the harness owns every random capability and exits
without reusing one. Never run it in production.

Live commands require network, deployed migration/buckets/policies, and staging
credentials. Repository build, unit tests, or `node --check` do not execute
them; keep the deployment blocked until actual live output has been captured.

## Signed TUS Replay Abuse Check

Run this only in a disposable staging project with the pilot flag enabled. Mint
one upload intent, then deliberately reuse its single `uploadToken`, bucket,
and object path in at least three TUS session-creation requests before any
session completes. Capture every HTTP status and distinct `Location`, plus the
provider's temporary storage, request, and bandwidth observations. Start a
small partial upload on each accepted session, then clean up every disposable
session/object using the provider-supported cleanup or expiry path and verify
that usage returns to baseline.

Record multiple accepted sessions as the expected upstream abuse residual, not
as a database quota failure: all sessions correspond to one attachment row.
Block public video/TUS if a provider hard budget/rate guard with alerts is not
proven, or route uploads through a single-use broker/proxy. If upstream behavior
changes and replay is rejected, retain the captured evidence rather than
assuming that behavior from unit tests. The detailed two-session database
checks are in `database/tests/booking_attachments_concurrency.md`.

Admin media endpoints attempt best-effort operational audit inserts. Those
inserts are warn-and-continue and the database log is not an append-only
external sink. They are useful for operations, but not tamper-resistant or
transactional compliance evidence. Configure an append-only external audit
sink before making such a guarantee.

## Manual Provider Tests

Automated tests cannot mint real Apple or Kakao user tokens. Before production:

- sign in with Apple on a physical iOS device
- sign in with Kakao and confirm nickname/phone/address behavior
- confirm `/users/me` and `/kakao/delete` fail closed with
  `ACCOUNT_DELETION_UNAVAILABLE` and cause no provider/database/Storage side
  effects; do not test real unlink until the deletion saga is implemented
- verify email confirmation and password reset email delivery

## Rollback

The database migrations are additive except for stricter booking constraints.
Do not reverse them during an incident. Roll the API/frontend back while keeping
Supabase intact, then diagnose from request IDs and backend logs. Keep MongoDB
read-only during the rollback window to avoid two writable sources of truth.
