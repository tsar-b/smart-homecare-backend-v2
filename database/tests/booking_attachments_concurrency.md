# Booking Attachment Concurrency Test (Staging)

This is a real two-database-session test for migration 007. Static SQL review
and unit tests cannot prove PostgreSQL advisory-lock behavior or visibility
between transactions. Run this procedure after applying the migration to a
disposable staging project; never use production bookings.

## Prerequisites and evidence

Create two confirmed staging users. Give the first user at least six empty,
active bookings and the second user at least one. Record their profile IDs as
`OWNER` and `OTHER_OWNER`, the first user's booking IDs as `B1` through `B6`,
and the second user's booking as `B7`. Use two independent `psql` processes connected directly to
the same staging database as a role permitted to write `booking_attachments`.
Autocommit must be enabled except where `BEGIN` is shown.

Before testing, record:

- date, migration version, project ref, and tester
- `select version();`
- `select pg_get_functiondef('public.enforce_booking_attachment_limits()'::regprocedure);`
- the output and elapsed/blocking behavior from both sessions

The test rows do not need matching Storage objects. Every generated path still
obeys the database path constraint. Replace the uppercase placeholders below
with the disposable IDs.

## Helper pattern

This pattern inserts one valid image reservation. Change only the booking ID,
size, or MIME/bucket pair requested by a scenario.

```sql
with generated as (select gen_random_uuid() as id)
insert into public.booking_attachments (
  id, client_attachment_id, booking_id, owner_user_id, bucket_id,
  object_path, media_kind, mime_type, declared_size_bytes,
  upload_expires_at, write_expires_at, status
)
select
  id, gen_random_uuid(), 'B1', 'OWNER', 'shc-booking-images-v1',
  format('v1/%s/%s.jpg', substr(id::text, 1, 2), id),
  'image', 'image/jpeg', 1,
  clock_timestamp() + interval '2 hours',
  clock_timestamp() + interval '26 hours 5 minutes',
  'pending'
from generated
returning id;
```

## Test 1: two writers cannot exceed six rows on one booking

Seed five rows on `B1`:

```sql
with generated as (
  select gen_random_uuid() as id from generate_series(1, 5)
)
insert into public.booking_attachments (
  id, client_attachment_id, booking_id, owner_user_id, bucket_id,
  object_path, media_kind, mime_type, declared_size_bytes,
  upload_expires_at, write_expires_at, status
)
select
  id, gen_random_uuid(), 'B1', 'OWNER', 'shc-booking-images-v1',
  format('v1/%s/%s.jpg', substr(id::text, 1, 2), id),
  'image', 'image/jpeg', 1,
  clock_timestamp() + interval '2 hours',
  clock_timestamp() + interval '26 hours 5 minutes',
  'pending'
from generated;
```

In session A, begin a transaction and insert the sixth row with the helper
pattern. Do not commit yet:

```sql
begin;
-- Run the one-row helper with B1 and OWNER.
select pg_backend_pid() as session_a_holding_quota_lock;
```

In session B, run the same one-row helper for `B1`. It must block; it must not
return a seventh row. While it is blocked, session A runs `commit;`. Session B
must then fail with SQLSTATE `23514` and a message containing `at most 6
attachments`.

Verify from either session:

```sql
select count(*) from public.booking_attachments where booking_id = 'B1';
-- Expected: 6
```

Failure means either insert succeeded, returned before A committed, or the
final count is not six.

## Test 2: two bookings cannot race past the per-owner row cap

Delete Test 1 rows, then seed 11 one-byte images for the same `OWNER`, spread
across six active bookings as 2/2/2/2/2/1. No booking may start with six rows.
This setup query can be adapted after replacing all IDs:

```sql
with distribution(booking_id, amount) as (
  values ('B1', 2), ('B2', 2), ('B3', 2),
         ('B4', 2), ('B5', 2), ('B6', 1)
), generated as (
  select booking_id, gen_random_uuid() as id
  from distribution
  cross join lateral generate_series(1, amount)
)
insert into public.booking_attachments (
  id, client_attachment_id, booking_id, owner_user_id, bucket_id,
  object_path, media_kind, mime_type, declared_size_bytes,
  upload_expires_at, write_expires_at, status
)
select
  id, gen_random_uuid(), booking_id, 'OWNER', 'shc-booking-images-v1',
  format('v1/%s/%s.jpg', substr(id::text, 1, 2), id),
  'image', 'image/jpeg', 1,
  clock_timestamp() + interval '2 hours',
  clock_timestamp() + interval '26 hours 5 minutes',
  'pending'
from generated;
```

Session A begins and uses the helper to insert row 12 on `B6`, then holds the
transaction. Session B uses the helper to attempt row 13 on `B5`; it must block
until A commits, then fail with SQLSTATE `23514` and
`USER_MEDIA_LIMIT_REACHED`. The final owner count must be 12:

```sql
select count(*)
from public.booking_attachments
where owner_user_id = 'OWNER';
-- Expected: 12
```

This is specifically an owner-lock test. Running the competing inserts against
different booking IDs is also recommended; the second writer must still block
on the owner advisory lock.

## Test 3: two bookings cannot race past 100,000,000 owner bytes

Clear the owner's Test 2 rows. Seed two 45,000,000-byte MP4 rows on `B1`, for
90,000,000 bytes total. Use bucket `shc-booking-videos-v1`, extension `.mp4`,
kind `video`, and MIME `video/mp4`; `B1` remains within its two-video and
100,000,000-byte limits.

Session A begins and inserts a 10,000,000-byte JPEG on `B2`, reaching exactly
100,000,000 owner bytes, then holds the transaction. Session B attempts a
one-byte JPEG on `B3`. It must block until A commits, then fail with SQLSTATE
`23514` and `USER_MEDIA_LIMIT_REACHED`. Verify the owner total is exactly
100,000,000 bytes and that the second row does not exist. Because the project
total is still below its 500,000,000-byte default, this specifically proves the
owner lock/check rather than the project circuit breaker.

## Test 4: two owners cannot race past the project row circuit breaker

Clear all prior disposable rows. Record the current
`booking_media_limits` values, then temporarily lower only
`max_reserved_rows` to the current project row count plus one. Keep
`max_reserved_bytes` above the current byte total plus two. This operation
requires the service role and must be restored immediately after the test.

Session A begins and inserts one one-byte image for `OWNER` on `B1`, then keeps
the transaction open. Session B inserts one one-byte image for `OTHER_OWNER` on
`B7`. Because the owners and bookings differ, the project advisory lock is the
only shared quota lock: session B must block. Commit session A. Session B must
then fail with SQLSTATE `23514` and `PROJECT_MEDIA_LIMIT_REACHED`. Verify the
project row count rose by exactly one, remove the two users' disposable rows,
and restore the exact recorded project limits before continuing. Failure to
restore the singleton makes every later result invalid.

Repeat the same shape for bytes if desired: temporarily set
`max_reserved_bytes` to the current project byte total plus one, race two
one-byte inserts from different owners/bookings, and require the second to fail
only after the first commits.

## Test 5: capability refresh wins over a stale expiry claim

Clear earlier rows and insert one pending image on active `B1` with both expiry
columns set to `2000-01-01T00:00:00Z`. Save its UUID as `ATTACHMENT`.

Session A:

```sql
begin;
select id, status, upload_expires_at, write_expires_at
from public.refresh_booking_attachment_capability('ATTACHMENT');
-- Leave the transaction open. The returned expiry must be in the future.
```

Session B, while A is open:

```sql
select id, status, write_expires_at
from public.claim_expired_booking_attachment(
  'ATTACHMENT',
  '2000-01-01T00:00:00Z'::timestamptz
);
```

Session B must block. Commit A. Session B must then return zero rows because its
observed expiry is stale. Verify the row remains `pending` with the extended
expiry.

## Test 6: expiry claim wins over a concurrent refresh

Reset `ATTACHMENT` to `pending` with `write_expires_at` equal to
`2000-01-01T00:00:00Z`.

Session A:

```sql
begin;
select id, status, write_expires_at
from public.claim_expired_booking_attachment(
  'ATTACHMENT',
  '2000-01-01T00:00:00Z'::timestamptz
);
-- Expected inside A: one row, status deleting. Leave A open.
```

Session B:

```sql
select id, status, upload_expires_at, write_expires_at
from public.refresh_booking_attachment_capability('ATTACHMENT');
```

Session B must block. Commit A. Session B must return zero rows because the row
is no longer pending. This proves reconciliation cannot mint a new capability
and capability refresh cannot revive an already-claimed tombstone.

## Test 7: one signed token can create multiple partial TUS sessions

This is a Storage abuse-boundary check, not a PostgreSQL transaction. Follow
the full disposable-staging procedure in `docs/DEPLOYMENT.md` under **Signed
TUS Replay Abuse Check**: obtain one signed upload token, reuse it for at least
three TUS creation requests for the same bucket/path, record every status and
distinct `Location`, start a small partial upload on each accepted session, and
record temporary storage/request/bandwidth usage and verified cleanup.

Database reservation totals must remain one row throughout. Multiple accepted
sessions prove why neither the 12-row/100,000,000-byte owner cap nor the
100-row/500,000,000-byte project cap bounds upstream temporary multipart cost.
Do not enable public video/TUS from this test alone; require hard provider
budget/rate guards with alerts or a single-use broker/proxy.

## Cleanup and pass criteria

Remove only the disposable user's test metadata, then delete the disposable
bookings/user through the normal staging cleanup path:

```sql
delete from public.booking_attachments where owner_user_id = 'OWNER';
select count(*) from public.booking_attachments where owner_user_id = 'OWNER';
-- Expected: 0
```

A complete pass requires captured evidence that the losing transaction blocked
until the winner committed, received the expected error or zero-row result,
and left the exact final count/state described above. If both sessions were not
live at the same time, record the test as **not run**, not passed.
