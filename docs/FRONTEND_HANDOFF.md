# SHC v2 Frontend Handoff

## October 13, 2026 upgrade boundary

This revision requires `database/migrations/20261013042516_atomic_booking_retry.sql`
after migrations 001-008 and **before the new API accepts bookings**. It has not
been applied to the shared cloud project as part of this handoff. An operator
must stop/drain old booking writers, apply the reviewed migration once, then
start compatible writers only. Do not mix the old finalizer-based API and the
new transactional API, or automatically roll back to an old writable instance.
See the [backend README rollout instructions](../README.md#october-13-2026-booking-retry-upgrade-required-before-this-api).

`GET /ready` returns 503 until the new retry RPCs and required permissions are
present; `GET /health` alone is insufficient. Cloning to Mac does not authorize
or require rerunning already-applied migrations. Latest-source Android/iOS and
cloud verification must be recorded separately from historical handoffs and
mocked/local SQL tests.

## Base URL

Set the frontend API base to `https://YOUR_BACKEND/api`. For same-Wi-Fi device
testing, use the Mac's LAN address, for example `http://192.168.x.x:5050/api`.
`localhost` on a physical phone means the phone, not the Mac.

The old frontend routes remain available, but new work should use the canonical
routes below.

## Authentication

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/guest`
- `POST /auth/apple`
- `POST /kakao/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET|PATCH|DELETE /users/me`

### Browser OAuth and development route checks

New mobile social sign-in uses these shared browser-PKCE routes for
`google`, `apple` and `kakao`:

- `GET /auth/browser/config`: enabled provider list and recovery availability.
- `POST /auth/oauth/start`: validated provider, exact return URI, random state
  and S256 challenge; returns the Supabase authorization URL.
- `POST /auth/oauth/exchange`: verified callback code, locally saved verifier
  and original provider; returns the normal SHC session only after verification.
- `POST /auth/recovery/start` and `POST /auth/recovery/finish`: separate password
  recovery flow, not a social login or implicit token callback.

The direct-token `/auth/apple` and `/kakao/login` interfaces listed above remain
compatibility paths; the new setup hooks do not use them or a native Apple SDK.

Development builds (`__DEV__`) show **Check Apple route** and **Check Kakao
route** on Login, even when those providers are disabled. The controls send a
real start request through the shared path. They cannot bypass server
`SUPABASE_OAUTH_PROVIDERS`: disabled providers return HTTP 503
`OAUTH_PROVIDER_DISABLED` with safe setup guidance, no browser launch and no
session. Missing callback registration returns `AUTH_REDIRECT_INVALID`.
Failed starts clear the matching pending verifier; cancellation and repeated
callbacks retain the existing safe callback handling. The setup controls are
hidden in release builds; configured providers still use normal sign-in buttons.

Real sign-in requires both provider setup in Supabase and the backend allowlist.
Do not enable a provider just to make the button appear. Refresh the configuration
after operator changes. Keep credentials server-side; do not copy the private
credential notebook into Expo or commit it.

There are two distinct callbacks:

1. Apple/Kakao developer console redirects to the Supabase project's
   `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Supabase returns to `smarthomecareapplication://auth/callback`; register that
   exact URI in Supabase's redirect allowlist and backend `AUTH_REDIRECT_URLS`.
   Web testing instead needs its exact `/auth/callback` origin registered.

The Mac needs a fresh iOS development build with `expo-web-browser` and the
native URL scheme installed (`npm ci`, then `npm run ios` with Xcode/tooling).
Reloading an older binary is not sufficient. This Apple route is browser OAuth,
not an implementation or verification of native Authentication Services.
Successful provider consent, iOS callbacks and release signing remain separate
acceptance checks. No Apple renewal or provider activation was performed here.

Login-like responses include both `token` and `accessToken`; they are the same
Supabase access token. Persist `accessToken` and `refreshToken` in secure device
storage. Send the access token as `Authorization: Bearer TOKEN`. On a `401`, try
one refresh and replace both tokens. Do not loop refresh requests indefinitely.

Registration can return HTTP 202 while email confirmation is pending. That safe
response has null `token`, `accessToken`, `refreshToken`, and `user` fields with
`requiresEmailConfirmation: true`. Do not activate or persist a session until a
later confirmed login returns a non-null access token.

`POST /auth/guest` currently fails closed with
`GUEST_VERIFICATION_REQUIRED`; it never creates or links a guest session until
phone OTP verification is implemented. Keep live guest registration disabled.
`DELETE /users/me` currently fails closed with
`ACCOUNT_DELETION_UNAVAILABLE`; do not promise account erasure in the UI yet.

## Catalog And Booking

Load `GET /app/initialize` once at startup, or use:

- `GET /catalog/initialize`
- `GET /catalog/service-types`
- `GET /catalog/options`
- `GET /catalog/pricing`
- `GET /bookings/availability?date=YYYY-MM-DD`

Create a UUID when the user begins a submission and send it in both places:

```http
POST /api/bookings
Authorization: Bearer ACCESS_TOKEN
Idempotency-Key: 1c16e228-1899-4a6e-96ff-69be6b2f8172
Content-Type: application/json
```

```json
{
  "client_request_id": "1c16e228-1899-4a6e-96ff-69be6b2f8172",
  "subtype_id": "CATALOG_SUBTYPE_ID",
  "service_type_id": "CATALOG_SERVICE_TYPE_ID",
  "pricing_tier_id": "CATALOG_PRICING_TIER_ID",
  "options": [
    { "option_id": "CATALOG_OPTION_ID", "value": "CATALOG_CHOICE_VALUE" }
  ],
  "reservation_date": "2030-06-20",
  "reservation_time": "10:30",
  "timezone": "Asia/Seoul"
}
```

Do not calculate an authoritative price in the client. Display the catalog
estimate, then use `totalPrice` from the booking response. Retry the same body
with the same UUID after a network failure. Generate a new UUID only when the
user intentionally creates a new booking.

The reservation date and time are always `Asia/Seoul` business-local values,
independent of device timezone or UI language. Do not convert them from the
device clock. Both availability and booking creation use the same server-owned
timezone. Older clients may still send a valid IANA `timezone`, but the backend
normalizes that field to `Asia/Seoul` on new bookings; invalid values are rejected.
This correction does not rewrite any existing booking records.

All three catalog IDs in the example are mandatory on `POST /api/bookings`.
Sending `total_price` to that canonical endpoint is a validation error. Only the
deprecated singular `POST /api/booking` route retains temporary V1
client-price compatibility; do not use it in new frontend code.

### Retry outcomes and client behavior

The server stores booking and receipt atomically. Reuse the exact body, key,
request UUID and endpoint after a timeout/uncertain response; do not recalculate
prices, replace profile fields in the retry payload, or silently generate a new
request ID. Identical committed retries return **201** with
`Idempotency-Replayed: true`. The returned booking is the original submission
snapshot, not its latest status. Refresh detail/history afterwards; cancellation,
completion or admin deletion must not be inferred away by an old replay.

| HTTP/code | Required client behavior |
|---|---|
| 409 `BOOKING_SLOT_UNAVAILABLE` | Another booking won the slot. Offer refreshed availability for a deliberate new selection. |
| 409 `BOOKING_SLOT_IN_PAST` | This new submission is too late. Offer a future slot; previously committed matching requests still replay. |
| 409 `IDEMPOTENCY_CONFLICT` | Key, request UUID, endpoint or body conflicts with an earlier submission. Reconcile the original instead of retrying changed content under its identity. |
| 409 `BOOKING_RETRY_REVIEW_REQUIRED` | A historical booking may already exist but cannot be safely matched. Ask the user to inspect history/support before any new submission. Do not auto-rotate IDs. |
| 503 `IDEMPOTENCY_STORE_UNAVAILABLE` | Preserve the draft and identity. Retry the same request when the migration/store/network issue is resolved; the previous commit outcome may be unknown. |

No generic `IDEMPOTENCY_IN_PROGRESS` claim/finalize loop is required for new
bookings; the transaction serializes conflicting retries. Receipt retention is
durable with **no automatic TTL**. The private receipt includes the original
customer response; backend operators must handle retention/erasure deliberately.
It must not be shipped to the client except through owner-authorized replay,
included in public exports or purged by a generic expired-key job.

The current mobile screen retains the same retry identity while that submission
remains mounted. This is not a claim that an unsent draft survives a process
kill: after an app restart, inspect history before making a new submission if
the old outcome is unknown.

## Private Photos And Videos

Create the booking before uploading media. This ensures a failed price or slot
validation never leaves files without a booking. For each selected file:

1. Keep one UUID as `clientAttachmentId` for every retry of that file.
2. Call `POST /bookings/:bookingId/attachments/upload-intents` with
   `{ clientAttachmentId, kind, contentType, sizeBytes }`.
3. Follow the returned `uploadMethod` instead of inferring it from media kind.
4. Upload directly to Storage, then call
   `POST /bookings/:bookingId/attachments/:attachmentId/complete`.
5. Retry only failed attachments against the already-created booking.

The intent response is:

```json
{
  "attachment": {
    "id": "ATTACHMENT_UUID",
    "clientAttachmentId": "CLIENT_ATTACHMENT_UUID",
    "bookingId": "BOOKING_ID",
    "kind": "image",
    "contentType": "image/jpeg",
    "sizeBytes": 123456,
    "status": "pending",
    "createdAt": "2030-06-20T00:00:00.000Z",
    "completedAt": null
  },
  "uploadMethod": "signed_put",
  "signedUrl": "https://...",
  "tusEndpoint": null,
  "uploadToken": "CAPABILITY_TOKEN",
  "storageApiKey": null,
  "chunkSizeBytes": 6291456,
  "expiresAt": "2030-06-20T02:00:00.000Z",
  "bucketId": "shc-booking-images-v1",
  "objectPath": "v1/ab/ATTACHMENT_UUID.jpg"
}
```

For `signed_put`, send the final binary to `signedUrl` with the declared
`Content-Type` and `cacheControl: "0"` (`Cache-Control: max-age=0`). For `tus`,
use the returned signed resumable `tusEndpoint`, a 6,291,456-byte chunk,
`x-signature: uploadToken`, `apikey: storageApiKey`, `x-upsert: false`, and metadata containing the
returned `bucketId`, `objectPath`, `contentType`, and `cacheControl: "0"`.
Supabase recommends TUS
for every file larger than 6 MiB, including an unusually large image.

The backend defaults `ENABLE_BOOKING_MEDIA_PILOT_UPLOADS` to false. While it is
false, every video and every file whose selected transport would be TUS returns
`BOOKING_MEDIA_PILOT_DISABLED`; do not present those choices as generally
available. Enable them only in a trusted closed-pilot deployment with provider
budget/rate guards. This is a deployment control, not proof that a Storage
bearer token is single-use.

Do not send an object path, bucket name, original filename, or server media ID
in the intent request. Do not attach `Idempotency-Key`; unlike booking creation,
the upload-intent response contains a short-lived credential and is deliberately
excluded from generic response replay.

`storageApiKey` is non-null only for TUS and is the project's public
publishable/anon key; it is not a backend secret. Still avoid logging it so
capability-bearing upload payloads can be redacted as one unit. Never substitute
`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in a client.

Limits are six files, two videos, 10,000,000 bytes per image, 45,000,000 bytes
per video, and 100,000,000 bytes total. Supported final MIME types are
`image/jpeg`, `image/png`, `image/webp`, `video/mp4`, and `video/quicktime`.
Normalize HEIC/HEIF to JPEG before requesting an intent.

The API also limits each authenticated account to 12 upload-intent requests per
minute and 12 reserved media rows/100,000,000 reserved bytes across bookings.
The whole project is initially limited to 100 rows/500,000,000 reserved bytes.
Treat `UPLOAD_INTENT_RATE_LIMITED` as a short retry and
`USER_MEDIA_LIMIT_REACHED` as an account-level capacity error. Rows waiting for
capability expiry count toward booking, account, and project reservations.
`PROJECT_MEDIA_LIMIT_REACHED` is a temporary service-capacity error; preserve
the already-created booking, explain that media capacity is unavailable, and
allow retry after operations frees or deliberately raises capacity.

Use these read/delete endpoints:

- `GET /bookings/:bookingId/attachments`
- `GET /bookings/:bookingId/attachments/:attachmentId/download-url`
- `DELETE /bookings/:bookingId/attachments/:attachmentId`
- admin equivalents under `/admin/bookings/:bookingId/attachments`

List responses are metadata-only and never contain `downloadUrl`. Request a
fresh five-minute URL only when opening the viewer and do not cache it. Every media response has
`Cache-Control: no-store`. A 204 delete means the media is hidden and cleanup
has been accepted; a private tombstone may remain for up to 26 hours 5 minutes
after the most recently issued intent because a token can start a 24-hour TUS
session near the end of its two-hour lifetime. `BOOKING_MEDIA_LOCKED` means the
booking was cancelled/completed while an upload was in flight and completion is
no longer accepted.

The server completion check enforces byte count, declared MIME, non-cacheable
Storage metadata, and a bounded allowlisted file header. It does **not** decode
the full file, scan it for malware, or enforce video duration; the current
60-second duration control is client UX only. Do not present untrusted uploads
in an admin browser before production adds a sandboxed probe/transcode or
malware-scanning pipeline and safe response headers.

A signed upload token can be replayed to create more than one partial TUS
session for the same database row. The database quotas therefore cannot cap
temporary multipart storage, Storage API requests, or bandwidth. The app must
not describe the project/owner quotas as a provider-spend ceiling, and a public
resumable launch requires a single-use broker/proxy or hard provider-side
budget and rate protection.

For abuse resistance, `deleting` and `rejected` tombstones continue to consume
the six-file/two-video/100 MB quota until reconciliation removes them. If the
visible files would otherwise fit, `ATTACHMENT_LIMIT_REACHED` includes
`details.reason: "write_capability_tombstones"`, a conservative `retryAfter`,
and `reconcileRequired: true`; show this as temporary cleanup capacity rather
than telling the user their visible selection is too large.

After Storage reports success, retry only the same `complete` endpoint until it
returns 200; completion is idempotent. If that response was lost, do not mint a
new upload intent or re-PUT the object. After an app restart, list attachments,
match `clientAttachmentId`, and try `complete` for a pending row first. Only
request a refreshed intent when completion returns
`ATTACHMENT_UPLOAD_INCOMPLETE`. A ready-row intent retry is rejected with
`ATTACHMENT_ALREADY_COMPLETE` and should trigger a list refresh.

## Legacy Aliases

The current mobile app can continue using `/login`, `/register`, `/booking`,
`/timeslots`, `/history`, `/historydetail/:id`, `/servicetypes`, `/options`, and `/pricing`.
Response objects include both Mongo-style `_id`/camelCase aliases and canonical
Supabase fields during the migration window.

## Legacy direct-token provider configuration

This section describes the retained direct-token compatibility endpoints, not
the new mobile browser-PKCE hooks described above.

Apple identity tokens are verified against Apple's JWKS and the backend
`APPLE_CLIENT_IDS` allowlist. Kakao access tokens are validated with Kakao before
a Supabase session is issued. Kakao address search additionally requires
`KAKAO_REST_API_KEY`. Both `/users/me` and `/kakao/delete` currently return
`ACCOUNT_DELETION_UNAVAILABLE` before any media purge, provider unlink, or Auth
deletion; do not present account erasure as available in the UI.
