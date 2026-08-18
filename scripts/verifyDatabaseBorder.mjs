import fs from 'node:fs';

const projectRef = process.env.SUPABASE_PROJECT_REF ?? 'ixnwmvznoptjbfnrgfbn';
const secretsPath = process.env.SHC_SECRETS_FILE ?? '/Users/allan/Documents/blyat.md';
const secrets = fs.readFileSync(secretsPath, 'utf8');
const accessToken = secrets.match(/Access Token\s*(?:[:=]|\n)\s*`?([^\s`]+)/i)?.[1];

if (!accessToken) throw new Error('Supabase Access Token was not found');

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
end $$;

select json_build_object(
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
        'bookings_unique_active_slot_idx'
      )
  ),
  'idempotency_rpc',
    to_regprocedure('public.claim_idempotency_key(text,text,text,integer)') is not null
) as verification;
`;

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query })
});

const body = await response.text();
if (!response.ok) throw new Error(`Verification failed (${response.status}): ${body}`);

const parsed = JSON.parse(body);
console.log(JSON.stringify(parsed[0]?.verification ?? parsed, null, 2));
