# Live QA and Mac backend handoff

Updated September 11, 2026. Pull this repository and
[the frontend](https://github.com/tsar-b/smart-homecare-frontend-v2) on `main`.
Preserve existing Mac changes; prefer a fast-forward-only pull or a separate
clone rather than resetting an edited checkout.

## Readiness correction

`/ready` now requires a successful response and a nonnegative safe-integer exact
count from both `users` and `booking_attachments`. Checking only `error === null`
was insufficient: the installed Supabase SDK can represent a bodyless HEAD 404
as an error-free response, including normalizing it to 204 with no count.
Existing empty tables with a verified count of zero still pass.

The added `src/core/http.test.ts` exercises the installed SDK behavior and the
registered readiness handler with mocked upstream calls. It opens no server
socket and requires no live database operations. `npm test` includes this suite.

On September 11, all **63 unit tests** (including the six new readiness tests)
passed, and `npm run build` succeeded with Node 24.14.0. The test run used dummy
`.invalid` Supabase configuration and an absent dotenv path, not the private
live environment. The live Android flow below was not rerun on September 11.

## Verified live state on September 9

- The reviewed migration `database/migrations/007_booking_attachments.sql` was
  applied to the shared project in a fresh-state transaction. SHA-256:
  `8f3a85459971484b17d9e69ec4d5e9ee3d16dc67b7e5be5f5d41587e7d88b741`.
- Both private buckets were provisioned: `shc-booking-images-v1` (10,000,000
  bytes; JPEG/PNG/WebP) and `shc-booking-videos-v1` (45,000,000 bytes;
  MP4/QuickTime).
- Read-only checks verified functions, effective privileges, triggers,
  constraints/indexes, Storage RLS, restrictive policies, and reservation limits.
- `/health`, `/ready` and `/api/app/initialize` returned HTTP 200. Readiness
  reported Auth, Database and Storage healthy before the test services stopped.
- Native Android uploaded an image and a video, retrieved both after restarting
  the app, and displayed/played them. Independent downloads verified the JPEG
  signature and the MP4's source SHA-256. Direct public and authenticated-client
  access was denied; the server-authorized flow succeeded.

These are dated, scoped development-client results, not proof of current uptime,
iOS behavior, a new release APK, all authorization boundaries, or a public rollout.
No live database changes are required merely to pull the source fixes.

## Private Mac setup

Use Node.js 22 or newer and `npm ci`. Preserve any existing `.env`; if absent,
create it from `.env.example` and configure privately:

- `SUPABASE_URL` for the intended existing project.
- `SUPABASE_PUBLISHABLE_KEY` or legacy `SUPABASE_ANON_KEY`.
- `SUPABASE_SECRET_KEY` or legacy `SUPABASE_SERVICE_ROLE_KEY`, backend only.
- The appropriate API origin, exact browser `CORS_ORIGINS` and provider settings
  from `.env.example` for the tests being performed.

Do not commit the private file or copy privileged keys into the app/website.
A Management token is for setup tooling, not a client credential. The optional
bootstrap process is documented in the main README; do not overwrite an existing
working configuration unnecessarily.

Then run:

```bash
npm test
npm run build
npm run dev
```

In another terminal, check the running API (default port 5050):

```bash
curl --fail http://localhost:5050/health
curl --fail http://localhost:5050/ready
```

`/ready` must return 200 with all three dependencies true. An empty response,
generic health success, or frontend preview is not sufficient. If it fails,
inspect the selected project/configuration and response before applying SQL.

The shared project already received migration 007 and both buckets on September
9. Do not reapply migration DDL or reprovision existing resources merely because
the Mac checkout is new. A different/new project needs its own ordered migrations,
catalog and Storage setup.

## Private video test and remaining limits

The backend requires `ENABLE_BOOKING_MEDIA_PILOT_UPLOADS=true` for any video or
resumable TUS intent. The mobile app also needs
`EXPO_PUBLIC_BOOKING_MEDIA_PILOT_UPLOADS=true`; restart each service after changing
its environment. Defaults remain false for public use. Follow the frontend's
[Mac handoff](https://github.com/tsar-b/smart-homecare-frontend-v2/blob/main/docs/LIVE_QA_MAC_HANDOFF_2026-09-11.md)
for simulator/device API addressing and native test steps.

Only small signed-PUT files were exercised live in the September 9 media run.
iOS, large/resumable transfers, cross-user requests, expiry, destructive flows,
quotas/load, malicious files and public-release behavior need separate checks.

The existing QA booking is labelled **DO NOT DISPATCH**. No payment was made.
Preserve the account, booking and media. Do not run `test:live`, `test:live:media`,
`db:verify-border` or `storage:reconcile-booking-media` under a no-deletion rule:
these workflows can write/delete rows or Storage objects. Obtain explicit
approval for any cleanup first. Unit tests are distinct from these live scripts.
