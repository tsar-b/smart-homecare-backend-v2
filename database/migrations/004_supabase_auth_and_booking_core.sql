-- SHC v2 Supabase Auth and booking core.
-- This migration is additive and preserves all migrated v1 profiles/catalog data.

alter table public.users
  add column if not exists auth_user_id uuid;

update public.users
set created_at = coalesce(created_at, migrated_at, now()),
    updated_at = coalesce(updated_at, migrated_at, now()),
    is_admin = coalesce(is_admin, false),
    is_guest = coalesce(is_guest, false),
    email_verified = coalesce(email_verified, false);

alter table public.users
  alter column created_at set default now(),
  alter column updated_at set default now(),
  alter column is_admin set default false,
  alter column is_guest set default false,
  alter column email_verified set default false;

create unique index if not exists users_auth_user_id_unique_idx
  on public.users (auth_user_id)
  where auth_user_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_auth_user_id_fkey'
  ) then
    alter table public.users
      add constraint users_auth_user_id_fkey
      foreign key (auth_user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

alter table public.bookings
  add column if not exists service_type_id text,
  add column if not exists subtype_id text,
  add column if not exists pricing_tier_id text,
  add column if not exists timezone text not null default 'Asia/Seoul',
  add column if not exists price_source text,
  add column if not exists updated_at timestamptz;

update public.bookings
set created_at = coalesce(created_at, migrated_at, now()),
    updated_at = coalesce(updated_at, migrated_at, created_at, now()),
    options = coalesce(options, '[]'::jsonb);

alter table public.bookings
  alter column created_at set default now(),
  alter column updated_at set default now(),
  alter column options set default '[]'::jsonb;

create index if not exists bookings_user_history_idx
  on public.bookings (user_id, reservation_date desc, reservation_time desc);

create index if not exists bookings_status_date_idx
  on public.bookings (status, reservation_date);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_user_id_fkey'
  ) then
    alter table public.bookings
      add constraint bookings_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade not valid;
    alter table public.bookings validate constraint bookings_user_id_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'requests_user_id_fkey'
  ) then
    alter table public.requests
      add constraint requests_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade not valid;
    alter table public.requests validate constraint requests_user_id_fkey;
  end if;
end $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
before update on public.users
for each row execute function public.touch_updated_at();

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
before update on public.bookings
for each row execute function public.touch_updated_at();

drop trigger if exists requests_touch_updated_at on public.requests;
create trigger requests_touch_updated_at
before update on public.requests
for each row execute function public.touch_updated_at();

create or replace function public.upsert_authenticated_identity(
  p_auth_user_id uuid,
  p_provider text,
  p_provider_subject text,
  p_email text default null,
  p_name text default null,
  p_phone text default null,
  p_address text default null,
  p_address_detail text default null,
  p_email_verified boolean default false,
  p_metadata jsonb default '{}'::jsonb
)
returns table(profile_id text, was_created boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  normalized_email text := nullif(lower(trim(p_email)), '');
  normalized_subject text := nullif(trim(p_provider_subject), '');
  target_profile_id text;
  identity_profile_id text;
  linked_auth_user_id uuid;
  created_profile_id text;
begin
  if p_provider not in ('standard', 'kakao', 'apple', 'guest') then
    raise exception 'Unsupported identity provider';
  end if;
  if normalized_subject is null then
    raise exception 'Provider subject is required';
  end if;
  if not exists (select 1 from auth.users where id = p_auth_user_id) then
    raise exception 'Supabase Auth user does not exist';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('auth:' || p_auth_user_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(p_provider || ':' || normalized_subject, 0)
  );

  select users.id into target_profile_id
  from public.users
  where users.auth_user_id = p_auth_user_id;

  select identities.user_id into identity_profile_id
  from public.user_identities identities
  where identities.provider = p_provider
    and identities.provider_subject = normalized_subject;

  if target_profile_id is not null
     and identity_profile_id is not null
     and target_profile_id <> identity_profile_id then
    raise unique_violation using message = 'Identity already linked to another account';
  end if;

  target_profile_id := coalesce(target_profile_id, identity_profile_id);

  if target_profile_id is null and p_provider = 'standard' and normalized_email is not null then
    select users.id into target_profile_id
    from public.users
    where lower(users.email) = normalized_email
    for update;
  end if;

  if target_profile_id is null then
    insert into public.users (
      id,
      auth_user_id,
      name,
      phone,
      email,
      address,
      address_detail,
      provider,
      is_guest,
      is_admin,
      email_verified,
      created_at,
      updated_at
    ) values (
      p_auth_user_id::text,
      p_auth_user_id,
      coalesce(nullif(trim(p_name), ''), case when p_provider = 'guest' then 'Guest' else initcap(p_provider) || ' User' end),
      nullif(trim(p_phone), ''),
      case when p_provider = 'standard' then normalized_email else null end,
      nullif(trim(p_address), ''),
      nullif(trim(p_address_detail), ''),
      p_provider,
      p_provider = 'guest',
      false,
      p_email_verified,
      now(),
      now()
    )
    returning id into created_profile_id;

    target_profile_id := created_profile_id;
  else
    select users.auth_user_id into linked_auth_user_id
    from public.users
    where users.id = target_profile_id
    for update;

    if linked_auth_user_id is not null and linked_auth_user_id <> p_auth_user_id then
      raise unique_violation using message = 'Identity already linked to another account';
    end if;

    update public.users
    set auth_user_id = p_auth_user_id,
        name = coalesce(nullif(trim(p_name), ''), users.name),
        phone = coalesce(nullif(trim(p_phone), ''), users.phone),
        email = case
          when p_provider = 'standard' then coalesce(normalized_email, users.email)
          else users.email
        end,
        address = coalesce(nullif(trim(p_address), ''), users.address),
        address_detail = coalesce(nullif(trim(p_address_detail), ''), users.address_detail),
        provider = coalesce(users.provider, p_provider),
        is_guest = case when p_provider = 'guest' then true else coalesce(users.is_guest, false) end,
        email_verified = coalesce(users.email_verified, false) or p_email_verified,
        updated_at = now()
    where users.id = target_profile_id;
  end if;

  insert into public.user_identities (
    user_id,
    provider,
    provider_subject,
    provider_email,
    metadata
  ) values (
    target_profile_id,
    p_provider,
    normalized_subject,
    normalized_email,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider, provider_subject) do update
  set provider_email = coalesce(excluded.provider_email, user_identities.provider_email),
      metadata = excluded.metadata,
      updated_at = now()
  where user_identities.user_id = target_profile_id;

  if not found then
    raise unique_violation using message = 'Identity already linked to another account';
  end if;

  return query
  select target_profile_id, created_profile_id is not null;
end;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.upsert_authenticated_identity(
  uuid, text, text, text, text, text, text, text, boolean, jsonb
) from public, anon, authenticated;

grant execute on function public.upsert_authenticated_identity(
  uuid, text, text, text, text, text, text, text, boolean, jsonb
) to service_role;
