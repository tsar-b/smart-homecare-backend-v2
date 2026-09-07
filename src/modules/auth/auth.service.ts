import { createHash } from 'node:crypto';
import type { Session } from '@supabase/supabase-js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';
import { createSupabasePublicClient } from '../../db/supabaseClient.js';
import { normalizeEmail } from '../../lib/canonical.js';
import type { IdentityProvider } from './identity.service.js';

export const PROFILE_SELECT = [
  'id',
  'auth_user_id',
  'legacy_user_id',
  'name',
  'phone',
  'email',
  'provider',
  'is_admin',
  'is_guest',
  'email_verified',
  'address',
  'address_detail',
  'created_at',
  'updated_at'
].join(', ');

export type ProfileRow = {
  id: string;
  auth_user_id: string | null;
  legacy_user_id: number | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  provider: IdentityProvider | 'standard' | null;
  is_admin: boolean | null;
  is_guest: boolean | null;
  email_verified: boolean | null;
  address: string | null;
  address_detail: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type UpsertAuthenticatedIdentityInput = {
  authUserId: string;
  provider: IdentityProvider | 'standard';
  providerSubject: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  addressDetail?: string | null;
  emailVerified?: boolean;
  metadata?: Record<string, unknown>;
};

type ProviderSessionInput = Omit<UpsertAuthenticatedIdentityInput, 'authUserId'>;

export async function upsertAuthenticatedIdentity(input: UpsertAuthenticatedIdentityInput) {
  const { data, error } = await supabaseAdmin
    .rpc('upsert_authenticated_identity', {
      p_address: cleanOptional(input.address),
      p_address_detail: cleanOptional(input.addressDetail),
      p_auth_user_id: input.authUserId,
      p_email: normalizeEmail(input.email),
      p_email_verified: Boolean(input.emailVerified),
      p_metadata: input.metadata ?? {},
      p_name: cleanOptional(input.name),
      p_phone: cleanOptional(input.phone),
      p_provider: input.provider,
      p_provider_subject: input.providerSubject.trim()
    })
    .single();

  if (error) {
    const conflict = error.code === '23505' || /already linked|identity already/i.test(error.message);
    throw new HttpError(
      conflict ? 409 : 400,
      conflict ? 'This identity is already linked to another account' : error.message,
      conflict ? 'IDENTITY_ALREADY_LINKED' : 'IDENTITY_UPSERT_FAILED'
    );
  }

  const result = data as { profile_id?: string; was_created?: boolean } | null;
  if (!result?.profile_id) {
    throw new HttpError(500, 'Identity upsert returned no profile', 'IDENTITY_UPSERT_FAILED');
  }

  return {
    profileId: String(result.profile_id),
    wasCreated: Boolean(result.was_created)
  };
}

export async function readProfileById(profileId: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(PROFILE_SELECT)
    .eq('id', profileId)
    .single();

  if (error || !data) throw new HttpError(404, 'SHC profile not found', 'PROFILE_NOT_FOUND');
  return data as unknown as ProfileRow;
}

export async function readProfileByAuthUserId(authUserId: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(PROFILE_SELECT)
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (error) throw new HttpError(503, 'Unable to load SHC profile', 'PROFILE_LOOKUP_FAILED');
  return (data as unknown as ProfileRow | null) ?? null;
}

export async function issueProviderSession(
  input: ProviderSessionInput,
  options: { allowExistingSession?: boolean } = {}
) {
  const existing = await readProfileByProvider(input.provider, input.providerSubject);
  if (existing?.auth_user_id && options.allowExistingSession === false) {
    throw new HttpError(
      409,
      'A guest session already exists for this phone number',
      'GUEST_ALREADY_REGISTERED'
    );
  }
  let authUserId = existing?.auth_user_id ?? null;
  let authEmail: string | null = null;
  let createdAuthUserId: string | null = null;

  if (authUserId) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(authUserId);
    if (error || !data.user?.email) {
      throw new HttpError(409, 'Linked authentication account is unavailable', 'AUTH_ACCOUNT_UNAVAILABLE');
    }
    authEmail = data.user.email;
  } else {
    authEmail = syntheticProviderEmail(input.provider, input.providerSubject);
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      email_confirm: true,
      app_metadata: { shc_provider: input.provider },
      user_metadata: { provider_subject: input.providerSubject }
    });

    if (error || !data.user) {
      throw new HttpError(503, 'Unable to create authentication account', 'AUTH_ACCOUNT_CREATE_FAILED');
    }
    authUserId = data.user.id;
    createdAuthUserId = data.user.id;
  }

  try {
    const identity = await upsertAuthenticatedIdentity({ ...input, authUserId });
    const profile = await readProfileById(identity.profileId);
    const session = await issueMagicLinkSession(authEmail);
    return {
      profileWasCreated: identity.wasCreated,
      response: sessionResponse(session, profile)
    };
  } catch (error) {
    if (createdAuthUserId) {
      await supabaseAdmin.auth.admin.deleteUser(createdAuthUserId);
    }
    throw error;
  }
}

export function sessionResponse(session: Session | null, profile: ProfileRow) {
  return {
    token: session?.access_token ?? null,
    accessToken: session?.access_token ?? null,
    refreshToken: session?.refresh_token ?? null,
    expiresAt: session?.expires_at ?? null,
    expiresIn: session?.expires_in ?? null,
    user: publicProfile(profile),
    requiresEmailConfirmation: session === null
  };
}

export function confirmationRequiredResponse() {
  return {
    token: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    expiresIn: null,
    user: null,
    requiresEmailConfirmation: true
  };
}

export function publicProfile(profile: ProfileRow) {
  return {
    _id: profile.id,
    id: profile.id,
    userId: profile.legacy_user_id ?? undefined,
    legacy_user_id: profile.legacy_user_id,
    name: profile.name,
    phone: profile.phone,
    email: profile.email,
    provider: profile.provider,
    isAdmin: Boolean(profile.is_admin),
    is_admin: Boolean(profile.is_admin),
    isGuest: Boolean(profile.is_guest),
    is_guest: Boolean(profile.is_guest),
    emailVerified: Boolean(profile.email_verified),
    email_verified: Boolean(profile.email_verified),
    address: profile.address,
    addressDetail: profile.address_detail,
    address_detail: profile.address_detail,
    createdAt: profile.created_at,
    created_at: profile.created_at,
    updatedAt: profile.updated_at,
    updated_at: profile.updated_at
  };
}

async function readProfileByProvider(provider: string, providerSubject: string) {
  const { data: identity, error } = await supabaseAdmin
    .from('user_identities')
    .select('user_id')
    .eq('provider', provider)
    .eq('provider_subject', providerSubject.trim())
    .maybeSingle();

  if (error) throw new HttpError(503, 'Unable to resolve provider identity', 'IDENTITY_LOOKUP_FAILED');
  if (!identity?.user_id) return null;
  return readProfileById(identity.user_id);
}

async function issueMagicLinkSession(email: string) {
  const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    throw new HttpError(503, 'Unable to issue provider session', 'SESSION_ISSUE_FAILED');
  }

  const client = createSupabasePublicClient();
  const { data, error } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink'
  });
  if (error || !data.session) {
    throw new HttpError(503, 'Unable to verify provider session', 'SESSION_ISSUE_FAILED');
  }
  return data.session;
}

function syntheticProviderEmail(provider: string, subject: string) {
  const digest = createHash('sha256').update(`${provider}:${subject}`).digest('hex').slice(0, 40);
  return `${provider}-${digest}@${env.OAUTH_SESSION_EMAIL_DOMAIN}`;
}

function cleanOptional(value?: string | null) {
  const cleaned = value?.trim();
  return cleaned || null;
}
