# Changes From SHC v1

| v1 behavior | Failure mode | v2 border |
| --- | --- | --- |
| `findOne(email)` then `save()` | concurrent registrations create duplicates | case-insensitive unique index plus atomic registration RPC |
| `findOne(kakaoId)` then `create()` | concurrent OAuth callbacks create duplicates | unique provider identity plus advisory-lock upsert RPC |
| phone lookup for guests | formatting variants and races bypass lookup | normalized partial unique phone index |
| numeric `userId` and copied booking name | stale names survive profile changes | canonical user UUID; old names are aliases only |
| check slot then save booking | two requests can take one slot | partial unique active-slot index |
| no retry identity | timeout retries create another booking | PostgreSQL idempotency record plus client request UUID |
| in-memory idempotency | lost on restart and split across instances | shared PostgreSQL claim, replay, and expiry |
| Mongo runtime writes | weak relational constraints | Supabase/PostgreSQL is the only v2 write target |

## Required Client Behavior

1. Generate one UUID when the confirmation screen/action begins.
2. Send it as `client_request_id` and `Idempotency-Key`.
3. Reuse the same values for every retry of that exact action.
4. Generate new values only after success or after the user materially changes
   the submission.
5. Disable the submit control while one request is in flight.

Client controls improve the experience. They are not trusted as the database
border; all uniqueness remains enforced by PostgreSQL.
