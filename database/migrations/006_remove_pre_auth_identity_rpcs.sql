-- Retire v1-compatible identity writers that created profiles without a
-- Supabase Auth user. The v2 API uses upsert_authenticated_identity instead.

drop function if exists public.register_standard_user(text, text, text, text);
drop function if exists public.upsert_provider_identity(text, text, text, text, text, jsonb);
