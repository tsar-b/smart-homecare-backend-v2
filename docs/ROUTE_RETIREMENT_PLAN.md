# Route and Legacy-Field Retirement Plan

Changing the persistence layer from MongoDB to PostgreSQL does not by itself
make the HTTP contract obsolete. The installed mobile client depends on route
paths and response shapes, not on the database driver behind them.

## Removed from the v2 tree

- `legacy/mongo-v1/`: duplicated Mongoose application source and its dependency
  lockfile. The exact v1 source remains available at the pinned repository
  commits in [V1_PRESERVATION.md](V1_PRESERVATION.md).

The root v2 package has no `mongodb` or `mongoose` runtime dependency. Removing
the archive does not remove an active v2 route or alter either database.

## Keep through the client cutover

- `legacy_user_id`, `legacy_id`, `migration_source`, and identity aliases:
  required where used for reconciliation, imported-user mapping, and rollback
  evidence.
- `/api/auth`, `/api/users`, `/api/admin`, `/api/bookings`, `/api/catalog`, and
  `/api/app`: active application boundaries backed by Supabase/PostgreSQL.
- The supported compatibility aliases registered under `/api`, including
  `/api/booking`, `/api/timeslots`, `/api/history`, `/api/historydetail/:id`,
  `/api/register`, and `/api/login`.
- `/api/kakao/address`: an external address integration, not a MongoDB route.
- Health, readiness, and OpenAPI endpoints: deployment and operational checks.

## Current booking boundary

The consolidated backend uses `public.bookings` for both the canonical
`POST /api/bookings` route and the legacy `POST /api/booking` adapter. They share
the booking creation implementation, history, detail, and availability logic.
There is no active `/api/requests` route in the current route registry.

The canonical route requires catalog identifiers and calculates pricing on the
server. Client-price compatibility remains isolated in the legacy adapter;
do not copy that behavior into the canonical route. Attachment operations use
the canonical `/api/bookings/:bookingId/attachments` paths.

Before retiring a legacy alias or its compatibility behavior:

1. Reconcile imported booking counts, identities, fields, and historical prices.
2. Verify the replacement clients use the canonical routes and identifiers.
3. Run contract checks for creation, duplicate submission, history, detail,
   availability, pricing, and administrator operations.
4. Observe production usage for the agreed rollback window.
5. Remove the unused adapter and its compatibility tests together, keeping
   canonical-route coverage and any migration metadata still needed.

An unused imported table is a separate data-retention decision. Route cleanup
does not authorize deleting historical rows or migration evidence.

## Supabase Auth transition

The current backend issues Supabase sessions and validates bearer tokens with
Supabase Auth before loading the SHC profile. It does not use the old custom
SHC JWT verifier. The `/api/login` and `/api/register` aliases invoke the same
handlers as the canonical authentication routes.

Retire an authentication alias only after supported clients have moved to its
replacement and existing password/provider identities have been reconciled.
Keep explicit tests for profile linking, session refresh, and authorization.
Provider integrations and account deletion have separate implementation and
release requirements; the presence of a route does not prove that its complete
lifecycle is ready for production.

Provider unlink/revocation and business APIs may remain server-side after the
interactive sign-in flow uses Supabase Auth.

## Removal gate

A route or compatibility field is removable only when all of these are true:

- zero calls in production telemetry for the agreed observation period;
- no supported client binary references it;
- data reconciliation reports zero unexplained differences;
- replacement contract tests pass;
- rollback documentation no longer requires it;
- the removal is recorded as a breaking change when applicable.
