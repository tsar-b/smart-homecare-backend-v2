-- SHC v2 booking integrity.
-- The API validates these fields, and PostgreSQL repeats the critical rules so
-- future scripts and concurrent workers cannot bypass them.

update public.bookings
set client_request_id = md5('legacy-booking:' || id)::uuid
where client_request_id is null;

update public.bookings bookings
set service_type_id = service_types.id
from public.service_types service_types
where bookings.service_type_id is null
  and lower(bookings.service_type) in (lower(service_types.key), lower(service_types.label));

update public.bookings bookings
set subtype_id = subtypes.id
from public.subtypes subtypes
where bookings.subtype_id is null
  and (
    bookings.asset_id = subtypes.id
    or lower(bookings.subtype) in (lower(subtypes.key), lower(subtypes.label))
  );

alter table public.bookings
  alter column client_request_id set not null,
  alter column user_id set not null,
  alter column service_type_id set not null,
  alter column subtype_id set not null,
  alter column name set not null,
  alter column reservation_date set not null,
  alter column reservation_time set not null,
  alter column options set not null,
  alter column status set default '대기',
  alter column status set not null,
  alter column total_price set not null,
  alter column timezone set default 'Asia/Seoul';

alter table public.bookings
  alter column timezone set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_service_type_id_fkey') then
    alter table public.bookings
      add constraint bookings_service_type_id_fkey
      foreign key (service_type_id) references public.service_types(id) on delete restrict not valid;
    alter table public.bookings validate constraint bookings_service_type_id_fkey;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_subtype_id_fkey') then
    alter table public.bookings
      add constraint bookings_subtype_id_fkey
      foreign key (subtype_id) references public.subtypes(id) on delete restrict not valid;
    alter table public.bookings validate constraint bookings_subtype_id_fkey;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_pricing_tier_id_fkey') then
    alter table public.bookings
      add constraint bookings_pricing_tier_id_fkey
      foreign key (pricing_tier_id) references public.pricing_tiers(id) on delete restrict not valid;
    alter table public.bookings validate constraint bookings_pricing_tier_id_fkey;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table public.bookings
      add constraint bookings_status_check
      check (status in (
        '대기', '확정', '완료', '취소',
        'pending', 'confirmed', 'approved', 'completed', 'cancelled'
      )) not valid;
    alter table public.bookings validate constraint bookings_status_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_reservation_time_check') then
    alter table public.bookings
      add constraint bookings_reservation_time_check
      check (reservation_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') not valid;
    alter table public.bookings validate constraint bookings_reservation_time_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_reservation_date_check') then
    alter table public.bookings
      add constraint bookings_reservation_date_check
      check (
        case
          when reservation_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then to_char(to_date(reservation_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') = reservation_date
          else false
        end
      ) not valid;
    alter table public.bookings validate constraint bookings_reservation_date_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_total_price_check') then
    alter table public.bookings
      add constraint bookings_total_price_check
      check (total_price is null or total_price >= -1) not valid;
    alter table public.bookings validate constraint bookings_total_price_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_price_source_check') then
    alter table public.bookings
      add constraint bookings_price_source_check
      check (price_source is null or price_source in ('catalog', 'legacy_client')) not valid;
    alter table public.bookings validate constraint bookings_price_source_check;
  end if;


  if not exists (select 1 from pg_constraint where conname = 'bookings_timezone_check') then
    alter table public.bookings
      add constraint bookings_timezone_check
      check (length(trim(timezone)) between 1 and 80) not valid;
    alter table public.bookings validate constraint bookings_timezone_check;
  end if;
end $$;
