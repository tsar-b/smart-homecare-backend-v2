# SHC v2 Frontend Handoff

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

All three catalog IDs in the example are mandatory on `POST /api/bookings`.
Sending `total_price` to that canonical endpoint is a validation error. Only the
deprecated singular `POST /api/booking` route retains temporary V1
client-price compatibility; do not use it in new frontend code.

`BOOKING_SLOT_UNAVAILABLE` means another request won the slot.
`IDEMPOTENCY_CONFLICT` means one key was reused with a different body.

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

## Provider Configuration

Apple identity tokens are verified against Apple's JWKS and the backend
`APPLE_CLIENT_IDS` allowlist. Kakao access tokens are validated with Kakao before
a Supabase session is issued. Kakao address search additionally requires
`KAKAO_REST_API_KEY`. Both `/users/me` and `/kakao/delete` currently return
`ACCOUNT_DELETION_UNAVAILABLE` before any media purge, provider unlink, or Auth
deletion; do not present account erasure as available in the UI.
