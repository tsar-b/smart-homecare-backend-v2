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

`BOOKING_SLOT_UNAVAILABLE` means another request won the slot.
`IDEMPOTENCY_CONFLICT` means one key was reused with a different body.

## Legacy Aliases

The current mobile app can continue using `/login`, `/register`, `/timeslots`,
`/history`, `/historydetail/:id`, `/servicetypes`, `/options`, and `/pricing`.
Response objects include both Mongo-style `_id`/camelCase aliases and canonical
Supabase fields during the migration window.

## Provider Configuration

Apple identity tokens are verified against Apple's JWKS and the backend
`APPLE_CLIENT_IDS` allowlist. Kakao access tokens are validated with Kakao before
a Supabase session is issued. Kakao address search additionally requires
`KAKAO_REST_API_KEY`; Kakao unlink on account deletion requires
`KAKAO_ADMIN_KEY`.
