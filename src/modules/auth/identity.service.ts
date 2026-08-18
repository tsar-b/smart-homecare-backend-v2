import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { normalizeEmail } from '../../lib/canonical.js';

export type IdentityProvider = 'apple' | 'guest' | 'kakao';

type ProviderIdentityInput = {
  provider: IdentityProvider;
  providerSubject: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  metadata?: Record<string, unknown>;
};

export async function upsertProviderIdentity(input: ProviderIdentityInput) {
  const { data, error } = await supabaseAdmin
    .rpc('upsert_provider_identity', {
      p_email: normalizeEmail(input.email),
      p_metadata: input.metadata ?? {},
      p_name: cleanOptional(input.name),
      p_phone: cleanOptional(input.phone),
      p_provider: input.provider,
      p_provider_subject: input.providerSubject.trim()
    })
    .single();

  if (error) throw new HttpError(400, error.message, 'IDENTITY_UPSERT_FAILED');
  const identity = data as { user_id?: string; was_created?: boolean } | null;
  if (!identity?.user_id) throw new HttpError(500, 'Identity upsert returned no user', 'IDENTITY_UPSERT_FAILED');

  return {
    userId: String(identity.user_id),
    wasCreated: Boolean(identity.was_created)
  };
}

function cleanOptional(value?: string | null) {
  const cleaned = value?.trim();
  return cleaned || null;
}
