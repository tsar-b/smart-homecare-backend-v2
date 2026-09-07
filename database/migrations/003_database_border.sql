-- SHC v2 database border.
-- Every rule here is enforced by PostgreSQL so concurrent API calls cannot
-- bypass it with a check-then-insert race.

create unique index if not exists users_legacy_user_id_unique_idx
  on public.users (legacy_user_id)
  where legacy_user_id is not null;

create unique index if not exists users_guest_phone_unique_idx
  on public.users (regexp_replace(phone, '[^0-9]', '', 'g'))
  where is_guest is true and phone is not null;

create table if not exists public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('standard', 'kakao', 'apple', 'guest')),
  provider_subject text not null,
  provider_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create index if not exists user_identities_user_id_idx
  on public.user_identities (user_id);

create table if not exists public.identity_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  alias_kind text not null,
  alias_value text not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (user_id, alias_kind, alias_value)
);

insert into public.user_identities (user_id, provider, provider_subject, provider_email)
select id, 'kakao', kakao_id, email
from public.users
where kakao_id is not null
on conflict (provider, provider_subject) do nothing;

insert into public.user_identities (user_id, provider, provider_subject, provider_email)
select id, 'standard', lower(trim(email)), email
from public.users
where provider = 'standard' and email is not null
on conflict (provider, provider_subject) do nothing;

insert into public.user_identities (user_id, provider, provider_subject)
select id, 'guest', regexp_replace(phone, '[^0-9]', '', 'g')
from public.users
where is_guest is true and phone is not null
on conflict (provider, provider_subject) do nothing;

insert into public.identity_aliases (user_id, alias_kind, alias_value, source)
select id, 'display_name', '쌀숭이', 'shc-v1'
from public.users
where name = '게스트'
on conflict (user_id, alias_kind, alias_value) do nothing;

alter table public.requests
  add column if not exists client_request_id uuid;

create unique index if not exists requests_user_client_request_unique_idx
  on public.requests (user_id, client_request_id)
  where client_request_id is not null;

alter table public.bookings
  add column if not exists client_request_id uuid;

create unique index if not exists bookings_user_client_request_unique_idx
  on public.bookings (user_id, client_request_id)
  where client_request_id is not null;

create unique index if not exists bookings_unique_active_slot_idx
  on public.bookings (reservation_date, reservation_time)
  where status in ('대기', '확정', 'pending', 'confirmed', 'approved');

create table if not exists public.idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  fingerprint text not null,
  state text not null check (state in ('processing', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (scope, idempotency_key)
);

create index if not exists idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at);

create or replace function public.claim_idempotency_key(
  p_scope text,
  p_key text,
  p_fingerprint text,
  p_ttl_seconds integer default 86400
)
returns table(outcome text, stored_status integer, stored_body jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.idempotency_keys%rowtype;
begin
  if length(p_scope) < 1 or length(p_scope) > 500 then
    raise exception 'Invalid idempotency scope';
  end if;
  if length(p_key) < 8 or length(p_key) > 200 then
    raise exception 'Invalid idempotency key';
  end if;

  insert into public.idempotency_keys (
    scope, idempotency_key, fingerprint, state, expires_at
  ) values (
    p_scope,
    p_key,
    p_fingerprint,
    'processing',
    now() + make_interval(secs => greatest(p_ttl_seconds, 60))
  )
  on conflict do nothing;

  if found then
    return query select 'acquired'::text, null::integer, null::jsonb;
    return;
  end if;

  select * into existing
  from public.idempotency_keys
  where scope = p_scope and idempotency_key = p_key
  for update;

  if existing.expires_at <= now() then
    update public.idempotency_keys
    set fingerprint = p_fingerprint,
        state = 'processing',
        response_status = null,
        response_body = null,
        updated_at = now(),
        expires_at = now() + make_interval(secs => greatest(p_ttl_seconds, 60))
    where scope = p_scope and idempotency_key = p_key;

    return query select 'acquired'::text, null::integer, null::jsonb;
  elsif existing.fingerprint <> p_fingerprint then
    return query select 'conflict'::text, null::integer, null::jsonb;
  elsif existing.state = 'completed' then
    return query select 'replay'::text, existing.response_status, existing.response_body;
  else
    return query select 'in_progress'::text, null::integer, null::jsonb;
  end if;
end;
$$;

create or replace function public.complete_idempotency_key(
  p_scope text,
  p_key text,
  p_fingerprint text,
  p_response_status integer,
  p_response_body jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.idempotency_keys
  set state = 'completed',
      response_status = p_response_status,
      response_body = p_response_body,
      updated_at = now()
  where scope = p_scope
    and idempotency_key = p_key
    and fingerprint = p_fingerprint
    and state = 'processing';

  return found;
end;
$$;

create or replace function public.release_idempotency_key(
  p_scope text,
  p_key text,
  p_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.idempotency_keys
  where scope = p_scope
    and idempotency_key = p_key
    and fingerprint = p_fingerprint
    and state = 'processing';

  return found;
end;
$$;

create or replace function public.register_standard_user(
  p_name text,
  p_phone text,
  p_email text,
  p_password_hash text
)
returns table(
  id text,
  legacy_user_id integer,
  name text,
  email text,
  provider text,
  is_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(p_email));
  new_user public.users%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('standard:' || normalized_email, 0));

  if exists (select 1 from public.users u where lower(u.email) = normalized_email) then
    raise unique_violation using message = 'Identity already exists';
  end if;

  insert into public.users (name, phone, email, password_hash, provider, is_guest, is_admin, email_verified)
  values (p_name, p_phone, normalized_email, p_password_hash, 'standard', false, false, false)
  returning * into new_user;

  insert into public.user_identities (user_id, provider, provider_subject, provider_email)
  values (new_user.id, 'standard', normalized_email, normalized_email);

  return query
  select new_user.id,
         new_user.legacy_user_id,
         new_user.name,
         new_user.email,
         new_user.provider,
         new_user.is_admin;
end;
$$;

create or replace function public.upsert_provider_identity(
  p_provider text,
  p_provider_subject text,
  p_email text default null,
  p_name text default null,
  p_phone text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(user_id text, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_user_id text;
  created_user_id text;
  normalized_email text := nullif(lower(trim(p_email)), '');
begin
  if p_provider not in ('kakao', 'apple', 'guest') then
    raise exception 'Unsupported identity provider';
  end if;
  if nullif(trim(p_provider_subject), '') is null then
    raise exception 'Provider subject is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_provider || ':' || trim(p_provider_subject), 0)
  );

  select identity.user_id into existing_user_id
  from public.user_identities identity
  where identity.provider = p_provider
    and identity.provider_subject = trim(p_provider_subject);

  if existing_user_id is not null then
    update public.users
    set name = coalesce(nullif(trim(p_name), ''), users.name),
        phone = coalesce(nullif(trim(p_phone), ''), users.phone),
        updated_at = now()
    where users.id = existing_user_id;

    update public.user_identities
    set provider_email = coalesce(normalized_email, provider_email),
        metadata = coalesce(p_metadata, '{}'::jsonb),
        updated_at = now()
    where provider = p_provider and provider_subject = trim(p_provider_subject);

    return query select existing_user_id, false;
    return;
  end if;

  if normalized_email is not null then
    select users.id into existing_user_id
    from public.users
    where lower(users.email) = normalized_email
    for update;
  end if;

  if existing_user_id is null then
    insert into public.users (
      name, phone, email, provider, is_guest, is_admin, email_verified
    ) values (
      coalesce(nullif(trim(p_name), ''), initcap(p_provider) || ' User'),
      nullif(trim(p_phone), ''),
      normalized_email,
      p_provider,
      p_provider = 'guest',
      false,
      p_provider in ('kakao', 'apple') and normalized_email is not null
    )
    returning users.id into created_user_id;

    existing_user_id := created_user_id;
  end if;

  insert into public.user_identities (
    user_id, provider, provider_subject, provider_email, metadata
  ) values (
    existing_user_id,
    p_provider,
    trim(p_provider_subject),
    normalized_email,
    coalesce(p_metadata, '{}'::jsonb)
  );

  return query select existing_user_id, created_user_id is not null;
end;
$$;

alter table public.user_identities enable row level security;
alter table public.identity_aliases enable row level security;
alter table public.idempotency_keys enable row level security;

drop policy if exists user_identities_service_role_all on public.user_identities;
create policy user_identities_service_role_all on public.user_identities
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists identity_aliases_service_role_all on public.identity_aliases;
create policy identity_aliases_service_role_all on public.identity_aliases
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists idempotency_keys_service_role_all on public.idempotency_keys;
create policy idempotency_keys_service_role_all on public.idempotency_keys
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

revoke all on function public.claim_idempotency_key(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.complete_idempotency_key(text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.release_idempotency_key(text, text, text) from public, anon, authenticated;
revoke all on function public.register_standard_user(text, text, text, text) from public, anon, authenticated;
revoke all on function public.upsert_provider_identity(text, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.claim_idempotency_key(text, text, text, integer) to service_role;
grant execute on function public.complete_idempotency_key(text, text, text, integer, jsonb) to service_role;
grant execute on function public.release_idempotency_key(text, text, text) to service_role;
grant execute on function public.register_standard_user(text, text, text, text) to service_role;
grant execute on function public.upsert_provider_identity(text, text, text, text, text, jsonb) to service_role;
