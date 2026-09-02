import { readArguments, resolveManagementCredentials, runDatabaseQuery } from './lib/supabaseManagement.mjs';

const args = readArguments();

const query = `
do $$
declare
  first_outcome text;
  second_outcome text;
  replay_outcome text;
begin
  delete from public.idempotency_keys
  where scope = 'verification' and idempotency_key = 'verification-key-0001';

  select outcome into first_outcome
  from public.claim_idempotency_key('verification', 'verification-key-0001', 'fingerprint-a', 60);

  select outcome into second_outcome
  from public.claim_idempotency_key('verification', 'verification-key-0001', 'fingerprint-a', 60);

  if first_outcome <> 'acquired' or second_outcome <> 'in_progress' then
    raise exception 'Idempotency claim verification failed';
  end if;

  perform public.complete_idempotency_key(
    'verification', 'verification-key-0001', 'fingerprint-a', 201, '{"ok":true}'::jsonb
  );

  select outcome into replay_outcome
  from public.claim_idempotency_key('verification', 'verification-key-0001', 'fingerprint-a', 60);

  if replay_outcome <> 'replay' then
    raise exception 'Idempotency replay verification failed';
  end if;

  delete from public.idempotency_keys
  where scope = 'verification' and idempotency_key = 'verification-key-0001';

  if exists (
    select 1 from public.user_identities
    group by provider, provider_subject having count(*) > 1
  ) then
    raise exception 'Duplicate provider identities exist';
  end if;

  if exists (
    select 1 from public.bookings
    where status in ('대기', '확정', 'pending', 'confirmed', 'approved')
    group by reservation_date, reservation_time having count(*) > 1
  ) then
    raise exception 'Duplicate active booking slots exist';
  end if;

  if exists (
    select 1 from public.bookings bookings
    left join public.users users on users.id = bookings.user_id
    where users.id is null
  ) then
    raise exception 'Orphan booking profiles exist';
  end if;

  if to_regprocedure(
    'public.upsert_authenticated_identity(uuid,text,text,text,text,text,text,text,boolean,jsonb)'
  ) is null then
    raise exception 'Supabase Auth identity RPC is missing';
  end if;
end $$;

select json_build_object(
  'profiles', (select count(*) from public.users),
  'profile_names', (select json_agg(name order by name) from public.users),
  'auth_users', (select count(*) from auth.users),
  'auth_linked_profiles', (select count(*) from public.users where auth_user_id is not null),
  'bookings', (select count(*) from public.bookings),
  'legacy_requests', (select count(*) from public.requests),
  'user_identities', (select count(*) from public.user_identities),
  'identity_aliases', (select count(*) from public.identity_aliases),
  'idempotency_keys', (select count(*) from public.idempotency_keys),
  'guest_alias', (
    select json_build_object('canonical', users.name, 'alias', aliases.alias_value)
    from public.identity_aliases aliases
    join public.users users on users.id = aliases.user_id
    where aliases.alias_value = '쌀숭이'
    limit 1
  ),
  'border_indexes', (
    select json_agg(indexname order by indexname)
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'users_legacy_user_id_unique_idx',
        'users_guest_phone_unique_idx',
        'requests_user_client_request_unique_idx',
        'bookings_user_client_request_unique_idx',
        'bookings_unique_active_slot_idx',
        'users_auth_user_id_unique_idx',
        'bookings_user_history_idx',
        'bookings_status_date_idx'
      )
  ),
  'idempotency_rpc',
    to_regprocedure('public.claim_idempotency_key(text,text,text,integer)') is not null,
  'auth_identity_rpc',
    to_regprocedure(
      'public.upsert_authenticated_identity(uuid,text,text,text,text,text,text,text,boolean,jsonb)'
    ) is not null,
  'integrity_constraints', (
    select json_agg(conname order by conname)
    from pg_constraint
    where conname in (
      'users_auth_user_id_fkey',
      'bookings_user_id_fkey',
      'bookings_service_type_id_fkey',
      'bookings_subtype_id_fkey',
      'bookings_pricing_tier_id_fkey',
      'bookings_status_check',
      'bookings_reservation_date_check',
      'bookings_reservation_time_check',
      'bookings_total_price_check',
      'bookings_price_source_check',
      'bookings_timezone_check'
    )
  ),
  'rls_enabled_tables', (
    select json_agg(relname order by relname)
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname in (
        'users', 'bookings', 'user_identities', 'identity_aliases', 'idempotency_keys',
        'catalog_categories', 'service_types', 'subtypes', 'pricing_tiers',
        'request_options', 'assets', 'timeslots', 'audit_logs'
      )
      and pg_class.relrowsecurity
  )
) as verification;
`;

const parsed = await runDatabaseQuery(query, resolveManagementCredentials(args));
console.log(JSON.stringify(parsed[0]?.verification ?? parsed, null, 2));
