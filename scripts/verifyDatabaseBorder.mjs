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

  if to_regclass('public.booking_attachments') is null then
    raise exception 'Booking attachment table is missing';
  end if;

  if to_regclass('public.booking_media_limits') is null then
    raise exception 'Booking media project-limit table is missing';
  end if;

  if (select count(*) from public.booking_media_limits where singleton_key = 'default') <> 1 then
    raise exception 'Booking media project-limit singleton is missing';
  end if;

  if exists (
    select 1
    from public.booking_attachments attachments
    left join public.bookings bookings
      on bookings.id = attachments.booking_id
     and bookings.user_id = attachments.owner_user_id
    where bookings.id is null
  ) then
    raise exception 'Orphan or mismatched booking attachments exist';
  end if;

  if exists (
    select 1
    from public.booking_attachments
    group by booking_id
    having count(*) > 6
      or count(*) filter (where media_kind = 'video') > 2
      or sum(declared_size_bytes) > 100000000
  ) then
    raise exception 'Booking attachment quota violation exists';
  end if;

  if exists (
    select 1
    from public.booking_attachments
    group by owner_user_id
    having count(*) > 12
      or sum(declared_size_bytes) > 100000000
  ) then
    raise exception 'User media reservation quota violation exists';
  end if;

  if exists (
    select 1
    from (
      select count(*)::bigint as reserved_rows,
             coalesce(sum(declared_size_bytes), 0)::bigint as reserved_bytes
      from public.booking_attachments
    ) totals
    cross join public.booking_media_limits limits
    where limits.singleton_key = 'default'
      and (
        totals.reserved_rows > limits.max_reserved_rows
        or totals.reserved_bytes > limits.max_reserved_bytes
      )
  ) then
    raise exception 'Project media reservation quota violation exists';
  end if;

  if to_regprocedure('public.refresh_booking_attachment_capability(uuid)') is null
     or to_regprocedure('public.claim_owned_booking_attachment_deletion(uuid,text)') is null
     or to_regprocedure('public.claim_expired_booking_attachment(uuid,timestamptz)') is null
     or to_regprocedure('public.delete_expired_booking_attachment(uuid,timestamptz)') is null then
    raise exception 'Booking attachment lifecycle RPC is missing';
  end if;

  if (
    select count(*)
    from pg_trigger triggers
    join pg_class tables on tables.oid = triggers.tgrelid
    join pg_namespace schemas on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relname = 'booking_attachments'
      and triggers.tgname in (
        'booking_attachments_enforce_limits',
        'booking_attachments_enforce_editable_state',
        'booking_attachments_touch_updated_at'
      )
      and not triggers.tgisinternal
      and triggers.tgenabled <> 'D'
  ) <> 3 then
    raise exception 'Booking attachment quota/editable-state triggers are missing or disabled';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.enforce_booking_attachment_limits()'::regprocedure,
      'public.enforce_booking_attachment_editable_state()'::regprocedure,
      'public.refresh_booking_attachment_capability(uuid)'::regprocedure,
      'public.claim_owned_booking_attachment_deletion(uuid,text)'::regprocedure,
      'public.claim_expired_booking_attachment(uuid,timestamptz)'::regprocedure,
      'public.delete_expired_booking_attachment(uuid,timestamptz)'::regprocedure
    ]) function_list(function_oid)
    where has_function_privilege('anon', function_oid::oid, 'EXECUTE')
       or has_function_privilege('authenticated', function_oid::oid, 'EXECUTE')
       or not has_function_privilege('service_role', function_oid::oid, 'EXECUTE')
  ) then
    raise exception 'Booking attachment function EXECUTE boundary is incorrect';
  end if;

  if has_table_privilege('anon', 'public.booking_attachments', 'SELECT')
     or has_table_privilege('authenticated', 'public.booking_attachments', 'SELECT')
     or has_table_privilege('anon', 'public.booking_media_limits', 'SELECT')
     or has_table_privilege('authenticated', 'public.booking_media_limits', 'SELECT') then
    raise exception 'Booking attachment/config table grants expose private media metadata';
  end if;

  if (
    select count(*)
    from storage.buckets
    where public is false
      and (
        (
          id = 'shc-booking-images-v1'
          and file_size_limit = 10000000
          and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']::text[]
          and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']::text[]
        )
        or
        (
          id = 'shc-booking-videos-v1'
          and file_size_limit = 45000000
          and allowed_mime_types @> array['video/mp4', 'video/quicktime']::text[]
          and allowed_mime_types <@ array['video/mp4', 'video/quicktime']::text[]
        )
      )
  ) <> 2 then
    raise exception 'Booking media buckets are missing, public, or misconfigured';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'shc_booking_media_deny_direct_client_access'
      and permissive = 'RESTRICTIVE'
      and cmd = 'ALL'
      and roles @> array['anon'::name, 'authenticated'::name]
      and qual like '%shc-booking-images-v1%'
      and qual like '%shc-booking-videos-v1%'
      and with_check like '%shc-booking-images-v1%'
      and with_check like '%shc-booking-videos-v1%'
  ) then
    raise exception 'Restrictive booking media Storage policy is missing or malformed';
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
  'booking_attachments', (select count(*) from public.booking_attachments),
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
        'bookings_status_date_idx',
        'bookings_id_user_id_unique_idx',
        'booking_attachments_booking_status_created_idx',
        'booking_attachments_owner_created_idx',
        'booking_attachments_pending_expiry_idx'
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
      'bookings_timezone_check',
      'booking_attachments_booking_owner_fkey',
      'booking_attachments_client_id_unique',
      'booking_attachments_storage_object_unique',
      'booking_attachments_status_check',
      'booking_attachments_kind_bucket_check',
      'booking_attachments_mime_check',
      'booking_attachments_declared_size_check',
      'booking_attachments_actual_size_check',
      'booking_attachments_path_check',
      'booking_media_limits_singleton_check',
      'booking_media_limits_rows_check',
      'booking_media_limits_bytes_check'
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
        'request_options', 'assets', 'timeslots', 'audit_logs', 'booking_attachments',
        'booking_media_limits'
      )
      and pg_class.relrowsecurity
  ),
  'booking_media_buckets', (
    select json_agg(
      json_build_object(
        'id', id,
        'public', public,
        'file_size_limit', file_size_limit,
        'allowed_mime_types', allowed_mime_types
      ) order by id
    )
    from storage.buckets
    where id in ('shc-booking-images-v1', 'shc-booking-videos-v1')
  ),
  'booking_media_direct_access_guard', (
    select json_build_object(
      'policyname', policyname,
      'permissive', permissive,
      'roles', roles,
      'qual', qual,
      'with_check', with_check
    )
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'shc_booking_media_deny_direct_client_access'
  ),
  'booking_media_project_limit', (
    select json_build_object(
      'max_reserved_rows', max_reserved_rows,
      'max_reserved_bytes', max_reserved_bytes,
      'current_reserved_rows', (select count(*) from public.booking_attachments),
      'current_reserved_bytes', (
        select coalesce(sum(declared_size_bytes), 0) from public.booking_attachments
      )
    )
    from public.booking_media_limits
    where singleton_key = 'default'
  )
) as verification;
`;

const parsed = await runDatabaseQuery(query, resolveManagementCredentials(args));
console.log(JSON.stringify(parsed[0]?.verification ?? parsed, null, 2));
