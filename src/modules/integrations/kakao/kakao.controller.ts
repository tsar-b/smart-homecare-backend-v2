import type { Request, Response } from 'express';
import { HttpError } from '../../../core/errors.js';
import { env } from '../../../core/env.js';
import { issueProviderSession } from '../../auth/auth.service.js';

type KakaoProfile = {
  id?: number | string;
  properties?: { nickname?: string };
  kakao_account?: {
    email?: string;
    is_email_valid?: boolean;
    is_email_verified?: boolean;
    phone_number?: string;
    profile?: { nickname?: string };
  };
};

type KakaoShippingAddress = {
  base_address?: string;
  detail_address?: string;
  baseAddress?: string;
  detailAddress?: string;
  is_default?: boolean;
  isDefault?: boolean;
};

export async function loginKakao(req: Request, res: Response) {
  const { accessToken, shippingAddr: clientAddress } = req.body;
  const [profileResult, addressResult] = await Promise.allSettled([
    kakaoFetch<KakaoProfile>('https://kapi.kakao.com/v2/user/me', accessToken),
    kakaoFetch<{ shipping_addresses?: KakaoShippingAddress[]; shippingAddresses?: KakaoShippingAddress[] }>(
      'https://kapi.kakao.com/v1/user/shipping_address',
      accessToken
    )
  ]);

  if (profileResult.status === 'rejected' || !profileResult.value.id) {
    throw new HttpError(401, 'Unable to validate Kakao access token', 'KAKAO_TOKEN_INVALID');
  }

  const profile = profileResult.value;
  const account = profile.kakao_account ?? {};
  const rawPhone = normalizeKoreanPhone(account.phone_number);
  const shippingAddress = pickShippingAddress(
    addressResult.status === 'fulfilled'
      ? addressResult.value.shipping_addresses ?? addressResult.value.shippingAddresses ?? []
      : [],
    clientAddress
  );
  const trustedEmail = account.is_email_valid && account.is_email_verified ? account.email : null;
  const { response: session } = await issueProviderSession({
    provider: 'kakao',
    providerSubject: String(profile.id),
    email: trustedEmail,
    emailVerified: Boolean(trustedEmail),
    name: account.profile?.nickname ?? profile.properties?.nickname ?? 'Kakao User',
    phone: rawPhone,
    address: shippingAddress?.base_address,
    addressDetail: shippingAddress?.detail_address,
    metadata: { issuer: 'kakao' }
  });

  res.json({
    ...session,
    needsPhoneUpdate: !rawPhone,
    shippingAddr: shippingAddress
  });
}

export async function searchKakaoAddress(req: Request, res: Response) {
  const query = String(req.query.query ?? '').trim();
  if (!query) throw new HttpError(400, 'query is required', 'QUERY_REQUIRED');
  if (!env.KAKAO_REST_API_KEY) throw new HttpError(500, 'Kakao key is not configured', 'KAKAO_NOT_CONFIGURED');

  const response = await fetchWithTimeout(
    'https://dapi.kakao.com/v2/local/search/address.json?' + new URLSearchParams({ query, size: '30' }),
    { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` } }
  );

  if (!response.ok) {
    throw new HttpError(response.status, 'Kakao address lookup failed', 'KAKAO_ADDRESS_FAILED');
  }

  res.json(await response.json());
}

export async function expandKakaoAddress(req: Request, res: Response) {
  const query = String(req.query.query ?? '').trim();
  if (!query) throw new HttpError(400, 'query is required', 'QUERY_REQUIRED');
  if (!env.KAKAO_REST_API_KEY) throw new HttpError(503, 'Kakao key is not configured', 'KAKAO_NOT_CONFIGURED');

  const addresses: unknown[] = [];
  for (let suffix = 1; suffix <= 15 && addresses.length < 5; suffix += 1) {
    const response = await fetchWithTimeout(
      'https://dapi.kakao.com/v2/local/search/address.json?' +
        new URLSearchParams({ query: `${query} ${suffix}`, size: '10' }),
      { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` } }
    );
    if (!response.ok) throw new HttpError(response.status, 'Kakao address lookup failed', 'KAKAO_ADDRESS_FAILED');
    const body = (await response.json()) as { documents?: Array<{ road_address?: unknown }> };
    addresses.push(...(body.documents ?? []).filter((entry) => entry.road_address));
  }

  res.json(addresses.slice(0, 5));
}

export async function deleteKakaoAccount(_req: Request, _res: Response) {
  // Account erasure needs an account-deleting state, session revocation, and a
  // resumable provider/database/Storage saga. Performing any purge or Kakao
  // unlink before that coordination exists can leave a partially deleted
  // account when a concurrent upload or downstream deletion fails.
  throw new HttpError(
    503,
    'Account deletion is unavailable until complete erasure and provider revocation are implemented',
    'ACCOUNT_DELETION_UNAVAILABLE'
  );
}

async function kakaoFetch<T>(url: string, accessToken: string) {
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Kakao API returned ${response.status}`);
  return (await response.json()) as T;
}

function pickShippingAddress(addresses: KakaoShippingAddress[], fallback?: KakaoShippingAddress | null) {
  const selected = addresses.find((address) => address.is_default || address.isDefault) ?? addresses[0] ?? fallback;
  if (!selected) return null;
  const baseAddress = (selected.base_address ?? selected.baseAddress ?? '').trim();
  const detailAddress = (selected.detail_address ?? selected.detailAddress ?? '').trim();
  if (!baseAddress && !detailAddress) return null;
  return { base_address: baseAddress, detail_address: detailAddress };
}

function normalizeKoreanPhone(value?: string) {
  if (!value) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
  if (!digits.startsWith('0') || digits.length < 9 || digits.length > 11) return null;
  return digits;
}

function fetchWithTimeout(url: string, init?: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}
