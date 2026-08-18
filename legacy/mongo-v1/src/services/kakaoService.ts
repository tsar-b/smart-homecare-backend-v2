// src/services/kakaoService.ts

import User from '../models/User';
import { generateUserId } from '../utils/generateUserId';

/** Both snake-case and camel-case are accepted */
interface Shipping {
  base_address?:   string;
  detail_address?: string;
  baseAddress?:    string;
  detailAddress?:  string;
}

interface Params {
  kakaoProfile: any;
  phone:        string;
  shippingAddr?: Shipping | null;
}

export const findOrCreateKakaoUser = async ({
  kakaoProfile,
  phone,
  shippingAddr = null,
}: Params) => {
  /* ────────────── 0. basic normalisation ────────────── */
  const kakaoId = String(kakaoProfile.id);
  const acct    = kakaoProfile.kakao_account ?? {};
  const email   = acct.email ?? `kakao_${kakaoId}@noemail.com`;
  const nick    = kakaoProfile.properties?.nickname ?? '카카오 유저';

  /** Convert camel-case keys → snake-case once */
  if (shippingAddr) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore  (ok: we check for undefined first)
    shippingAddr.base_address   = shippingAddr.base_address   ?? shippingAddr.baseAddress;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    shippingAddr.detail_address = shippingAddr.detail_address ?? shippingAddr.detailAddress;
  }

  /* ────────────── 1. create on first login ────────────── */
  let user = await User.findOne({ kakaoId });

  if (!user) {
    user = await User.create({
      email,
      name:     nick,
      phone,                       // already formatted 010-XXXX-XXXX
      provider: 'kakao',
      userId:   await generateUserId(),
      kakaoId,
      isGuest:  false,
      isAdmin:  false,
      emailVerified: true,
      address:       shippingAddr?.base_address   ?? '',
      addressDetail: shippingAddr?.detail_address ?? '',
    });

    return user;                   // brand-new user is up-to-date
  }

  /* ────────────── 2. keep existing user in sync ───────── */
  let dirty = false;

  // a) address
  if (shippingAddr?.base_address) {
    const base = shippingAddr.base_address.trim();
    if (!user.address?.trim() || user.address !== base) {
      user.address = base;
      dirty = true;
    }
  }

  if (shippingAddr?.detail_address) {
    const detail = shippingAddr.detail_address.trim();
    if (!user.addressDetail?.trim() || user.addressDetail !== detail) {
      user.addressDetail = detail;
      dirty = true;
    }
  }

  // b) phone – replace dummy 010-0000-xxxx once we have a real one
  if (
    user.phone?.startsWith('010-0000') &&
    phone !== user.phone &&
    phone.length === 13             // 010-1234-5678
  ) {
    user.phone = phone;
    dirty = true;
  }

  if (dirty) {
  await user.save();
  console.log('[Kakao] user saved →', {
    _id: user._id,
    address: user.address,
    addressDetail: user.addressDetail,
  });
}
  return user;
};
