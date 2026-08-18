# Smart HomeCare Backend v2

SHC v2 is the Supabase/PostgreSQL successor to the MongoDB v1 backend. The v1
source and history are preserved under `legacy/mongo-v1/` for migration and
behavior comparison.

## Database Border

PostgreSQL rejects duplicate identities and submissions even when requests
arrive concurrently:

- case-insensitive unique email
- unique legacy user ID
- unique `(provider, provider_subject)` for Kakao and Apple
- unique normalized guest phone
- unique `(user_id, client_request_id)`
- unique active reservation slot
- PostgreSQL-backed idempotency claim and replay
- canonical `게스트` identity with `쌀숭이` retained only as a migration alias

Apply migrations in order from `database/migrations/`. Migration
`003_database_border.sql` is additive and can be applied to the already
migrated SHC Supabase project.

## Setup

```bash
cp .env.example .env
npm install
npm run build
npm test
npm run dev
```

Use `SUPABASE_SECRET_KEY` when the project provides a modern backend key.
`SUPABASE_SERVICE_ROLE_KEY` remains a legacy fallback. Neither key belongs in
the frontend or Git.

## Write Contract

`POST /api/bookings` and `POST /api/requests` require both:

- `Idempotency-Key` header, reused when the same client action is retried
- `client_request_id` UUID in the JSON body

The header protects request processing and safely replays completed responses.
The UUID and slot indexes remain the final database guarantees.

## Legacy Boundary

MongoDB is no longer a runtime write target. It is retained only for migration,
comparison, and rollback during the cutover window.
