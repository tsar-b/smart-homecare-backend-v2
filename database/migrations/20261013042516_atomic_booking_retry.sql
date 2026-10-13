-- Additive SHC booking retry protocol. Apply AFTER 001-008, before deploying
-- the API that requires these RPCs. Never run mixed old/new booking writers.
-- Receipts are immutable and retained until operator-reviewed retention; no
-- TTL or automatic cleanup may silently make a submitted request new again.
create table public.booking_submission_receipts (
  user_id text not null references public.users(id) on delete cascade,
  client_request_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_scope text not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  booking_id text not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, client_request_id),
  unique (user_id, idempotency_key)
);

-- A receipt intentionally survives admin booking removal. It must not recreate
-- a deleted/cancelled booking when an old request is delivered again.
alter table public.booking_submission_receipts enable row level security;
revoke all on public.booking_submission_receipts from public, anon, authenticated, service_role;
grant select, insert on public.booking_submission_receipts to service_role;
create policy booking_submission_receipts_server on public.booking_submission_receipts
  for all to service_role using (true) with check (true);

create function public.lookup_booking_submission(
  p_user_id text, p_client_request_id uuid, p_key text, p_scope text, p_fingerprint text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  receipt public.booking_submission_receipts%rowtype;
  previous public.idempotency_keys%rowtype;
  saved_body jsonb;
begin
  if p_user_id is null or p_user_id = '' or p_client_request_id is null
     or p_key is null or length(p_key) not between 8 and 200
     or p_scope is null or length(p_scope) > 500
     or left(p_scope, length(p_user_id) + 6) <> p_user_id || ':POST:'
     or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid booking retry identity';
  end if;

  for receipt in select * from public.booking_submission_receipts
    where user_id = p_user_id
      and (client_request_id = p_client_request_id or idempotency_key = p_key)
  loop
    if receipt.client_request_id <> p_client_request_id or receipt.idempotency_key <> p_key
       or receipt.request_scope <> p_scope or receipt.fingerprint <> p_fingerprint then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    saved_body := receipt.response_body;
  end loop;
  if saved_body is not null then
    return jsonb_build_object('outcome', 'replay', 'booking', saved_body);
  end if;

  -- Completed pre-upgrade keys are safe only with the original fingerprint
  -- AND matching owner/request ID. Incomplete historical bookings have no
  -- durable payload proof: fail closed instead of guessing or duplicating.
  select * into previous from public.idempotency_keys
    where scope = p_scope and idempotency_key = p_key;
  if found then
    if previous.fingerprint <> p_fingerprint then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    if previous.state = 'completed' then
      if previous.response_status = 201
         and previous.response_body->>'user_id' = p_user_id
         and previous.response_body->>'client_request_id' = p_client_request_id::text then
        return jsonb_build_object('outcome', 'replay', 'booking', previous.response_body);
      end if;
      return jsonb_build_object('outcome', 'review_required');
    end if;
  end if;
  if exists (select 1 from public.bookings
    where user_id = p_user_id and client_request_id = p_client_request_id) then
    return jsonb_build_object('outcome', 'review_required');
  end if;
  return jsonb_build_object('outcome', 'missing');
end;
$$;

create function public.commit_booking_submission(
  p_user_id text, p_client_request_id uuid, p_key text, p_scope text,
  p_fingerprint text, p_booking jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  prior jsonb;
  inserted public.bookings%rowtype;
  business_now timestamp;
begin
  -- One short database transaction; no email, media, HTTP or price lookup
  -- occurs while this lock is held. Hash collisions only serialize callers.
  perform pg_advisory_xact_lock(hashtextextended('shc-booking:' || p_user_id, 0));
  prior := public.lookup_booking_submission(
    p_user_id, p_client_request_id, p_key, p_scope, p_fingerprint);
  if prior->>'outcome' <> 'missing' then return prior; end if;

  -- Only Express (service_role) calls this function, after validation and
  -- catalog pricing. Reject identity/status injection even from a bad caller.
  if p_booking is null or jsonb_typeof(p_booking) <> 'object'
     or (p_booking->>'user_id') is distinct from p_user_id
     or (p_booking->>'client_request_id')::uuid is distinct from p_client_request_id
     or (p_booking->>'timezone') is distinct from 'Asia/Seoul'
     or (p_booking->>'status') is distinct from '대기'
     or coalesce(p_booking->>'price_source', '') not in ('catalog', 'legacy_client')
     or (p_booking->>'reservation_date') is null
     or (p_booking->>'reservation_date') !~ '^\d{4}-\d{2}-\d{2}$'
     or (p_booking->>'reservation_time') is null
     or (p_booking->>'reservation_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    raise exception using errcode = '22023', message = 'Invalid server booking payload';
  end if;

  -- Recheck after lock acquisition, but NEVER reject a committed replay just
  -- because its appointment is now in the past or catalog prices changed.
  business_now := clock_timestamp() at time zone 'Asia/Seoul';
  if (p_booking->>'reservation_date')::date + (p_booking->>'reservation_time')::time
      <= date_trunc('minute', business_now) then
    return jsonb_build_object('outcome', 'past');
  end if;

  insert into public.bookings (
    client_request_id, asset_id, service_type_id, subtype_id, pricing_tier_id,
    service_type, subtype, tier, options, name, phone, address, detail_address,
    reservation_date, reservation_time, timezone, memo, symptom, total_price,
    price_source, user_id, legacy_user_id, is_guest, status
  ) values (
    p_client_request_id, p_booking->>'asset_id', p_booking->>'service_type_id',
    p_booking->>'subtype_id', p_booking->>'pricing_tier_id', p_booking->>'service_type',
    p_booking->>'subtype', p_booking->>'tier', p_booking->'options', p_booking->>'name',
    p_booking->>'phone', p_booking->>'address', p_booking->>'detail_address',
    p_booking->>'reservation_date', p_booking->>'reservation_time', 'Asia/Seoul',
    p_booking->>'memo', p_booking->>'symptom', (p_booking->>'total_price')::integer,
    p_booking->>'price_source', p_user_id, (p_booking->>'legacy_user_id')::integer,
    (p_booking->>'is_guest')::boolean, '대기'
  ) returning * into inserted;

  insert into public.booking_submission_receipts (
    user_id, client_request_id, idempotency_key, request_scope, fingerprint, booking_id, response_body
  ) values (
    p_user_id, p_client_request_id, p_key, p_scope, p_fingerprint, inserted.id, to_jsonb(inserted)
  );
  return jsonb_build_object('outcome', 'created', 'booking', to_jsonb(inserted));
  -- Any error (including a competing slot or receipt failure) aborts BOTH
  -- inserts. A crash/disconnect before commit leaves neither operation saved.
end;
$$;

create function public.booking_retry_ready()
returns boolean language sql security invoker set search_path = '' as $$
  select has_table_privilege(current_user, 'public.booking_submission_receipts', 'SELECT')
    and has_table_privilege(current_user, 'public.booking_submission_receipts', 'INSERT')
    and has_table_privilege(current_user, 'public.bookings', 'SELECT')
    and has_table_privilege(current_user, 'public.bookings', 'INSERT')
    and has_table_privilege(current_user, 'public.idempotency_keys', 'SELECT')
    and has_function_privilege(current_user,
      'public.lookup_booking_submission(text,uuid,text,text,text)', 'EXECUTE')
    and has_function_privilege(current_user,
      'public.commit_booking_submission(text,uuid,text,text,text,jsonb)', 'EXECUTE');
$$;

revoke all on function public.lookup_booking_submission(text,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.commit_booking_submission(text,uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.booking_retry_ready() from public, anon, authenticated;
grant execute on function public.lookup_booking_submission(text,uuid,text,text,text) to service_role;
grant execute on function public.commit_booking_submission(text,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.booking_retry_ready() to service_role;
