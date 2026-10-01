import type { Request, Response } from 'express';
import type { Session, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { readProfileByAuthUserId, readProfileById, sessionResponse, upsertAuthenticatedIdentity } from './auth.service.js';

export const SocialProvider = z.enum(['kakao', 'apple', 'google']);
const State = z.string().regex(/^[a-f0-9]{64}$/);
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const StartFields = { redirectUri: z.string().max(500), state: State, codeChallenge: Challenge };
export const OAuthStartSchema = z.object({ ...StartFields, provider: SocialProvider }).strict();
export const RecoveryStartSchema = z.object({ ...StartFields, email: z.string().trim().email().max(254) }).strict();
export const OAuthExchangeSchema = z.object({ code: z.string().min(1).max(2048), codeVerifier: Verifier, provider: SocialProvider }).strict();
export const RecoveryFinishSchema = z.object({
  code: z.string().min(1).max(2048), codeVerifier: Verifier,
  password: z.string().min(8).max(200).regex(/[A-Za-z]/).regex(/[0-9]/)
}).strict();

export function enabledProviders(value = env.SUPABASE_OAUTH_PROVIDERS) {
  return [...new Set(value.split(',').map(v => v.trim()).filter(v => SocialProvider.safeParse(v).success))];
}

export function callbackUrl(redirectUri: string, state: string, allowlist = env.AUTH_REDIRECT_URLS) {
  const allowed = allowlist.split(',').map(v => v.trim()).filter(Boolean);
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw new HttpError(400, 'Invalid return address', 'AUTH_REDIRECT_INVALID'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && env.NODE_ENV !== 'production';
  if (!allowed.includes(redirectUri) || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'smarthomecareapplication:' || localHttp) ||
      !State.safeParse(state).success) {
    throw new HttpError(400, 'Return address is not allowed', 'AUTH_REDIRECT_INVALID');
  }
  url.searchParams.set('state', state);
  return url.toString();
}

function noStore(res: Response) { res.setHeader('Cache-Control', 'no-store'); }

// The Auth protocol is the same PKCE token/recover request used by supabase-js.
// No admin key, code verifier or access token is ever put in a redirect URL.
async function authRequest(path: string, body: unknown, token?: string) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/${path}`, {
    method: path === 'user' ? 'PUT' : 'POST',
    headers: {
      apikey: (env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY)!,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function browserAuthConfig(_req: Request, res: Response) {
  noStore(res);
  res.json({ providers: enabledProviders(), recovery: true });
}

export async function startOAuth(req: Request, res: Response) {
  noStore(res);
  const input = OAuthStartSchema.parse(req.body);
  if (!enabledProviders().includes(input.provider)) throw new HttpError(503, 'This provider is not enabled', 'OAUTH_PROVIDER_DISABLED');
  const target = new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/authorize`);
  target.searchParams.set('provider', input.provider);
  target.searchParams.set('redirect_to', callbackUrl(input.redirectUri, input.state));
  target.searchParams.set('code_challenge', input.codeChallenge);
  target.searchParams.set('code_challenge_method', 's256');
  res.json({ authorizationUrl: target.toString() });
}

export async function startRecovery(req: Request, res: Response) {
  noStore(res);
  const input = RecoveryStartSchema.parse(req.body);
  const redirect = callbackUrl(input.redirectUri, input.state);
  let result;
  try {
    result = await authRequest(`recover?redirect_to=${encodeURIComponent(redirect)}`, {
      email: input.email.toLowerCase(), code_challenge: input.codeChallenge, code_challenge_method: 's256'
    });
  } catch { throw new HttpError(503, 'Recovery is temporarily unavailable', 'RECOVERY_UNAVAILABLE'); }
  // Never reveal whether an address exists. Provider throttling/outages are
  // reported without forwarding its body, email address, or link.
  if (result.response.status === 429) throw new HttpError(429, 'Please wait before requesting another email', 'AUTH_RATE_LIMITED');
  if (result.response.status >= 500 || result.response.status === 401 || result.response.status === 403) {
    throw new HttpError(503, 'Recovery is temporarily unavailable', 'RECOVERY_UNAVAILABLE');
  }
  res.status(202).json({ ok: true });
}

async function exchange(code: string, codeVerifier: string): Promise<Session> {
  let result;
  try { result = await authRequest('token?grant_type=pkce', { auth_code: code, code_verifier: codeVerifier }); }
  catch { throw new HttpError(503, 'Authentication is temporarily unavailable', 'AUTH_FLOW_UNAVAILABLE'); }
  const data = result.data;
  if (!result.response.ok || !data.access_token || !data.refresh_token || !data.user?.id) {
    throw new HttpError(401, 'This link has expired or was already used. Start again.', 'AUTH_LINK_INVALID');
  }
  return { ...data, expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in } as Session;
}

export function verifiedSocialIdentity(user: User, provider: z.infer<typeof SocialProvider>) {
  const identity = user.identities?.find(item => item.provider === provider && item.user_id === user.id);
  const subject = identity?.identity_data?.sub ?? identity?.id;
  if (!identity || typeof subject !== 'string' || !subject.trim()) {
    throw new HttpError(403, 'Provider identity was not verified', 'OAUTH_IDENTITY_INVALID');
  }
  // Only the Auth server's verified identity is authoritative, never metadata
  // submitted by the app or a client-supplied email/provider subject.
  return { subject, email: typeof identity.identity_data?.email === 'string' ? identity.identity_data.email : null,
    emailVerified: identity.identity_data?.email_verified === true };
}

export async function finishOAuth(req: Request, res: Response) {
  noStore(res);
  const input = OAuthExchangeSchema.parse(req.body);
  if (!enabledProviders().includes(input.provider)) throw new HttpError(503, 'This provider is not enabled', 'OAUTH_PROVIDER_DISABLED');
  const session = await exchange(input.code, input.codeVerifier);
  const identity = verifiedSocialIdentity(session.user, input.provider);
  let profile = await readProfileByAuthUserId(session.user.id);
  if (!profile) {
    const result = await upsertAuthenticatedIdentity({
      authUserId: session.user.id, provider: input.provider, providerSubject: identity.subject,
      email: identity.email, emailVerified: identity.emailVerified,
      name: typeof session.user.user_metadata?.full_name === 'string' ? session.user.user_metadata.full_name.slice(0, 120) : undefined
    });
    profile = await readProfileById(result.profileId);
  }
  // Existing synthetic/legacy identities may conflict. Do not delete, silently
  // reassign, or merge accounts by matching an untrusted display email.
  res.json(sessionResponse(session, profile));
}

export async function finishRecovery(req: Request, res: Response) {
  noStore(res);
  const input = RecoveryFinishSchema.parse(req.body);
  const session = await exchange(input.code, input.codeVerifier);
  let result;
  try { result = await authRequest('user', { password: input.password }, session.access_token); }
  catch { throw new HttpError(503, 'Password update could not be confirmed. Try signing in or request a new link.', 'RECOVERY_UPDATE_UNCERTAIN'); }
  if (!result.response.ok) throw new HttpError(400, 'Password could not be changed. Request a new link and try again.', 'PASSWORD_UPDATE_FAILED');
  // Recovery never activates an SHC browsing session. Return to email login.
  res.json({ ok: true });
}
