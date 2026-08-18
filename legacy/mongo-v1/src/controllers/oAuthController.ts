// src/controllers/oAuthController.ts

import { Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { findOrCreateKakaoUser } from "../services/kakaoService";
import User from '../models/User';
import Booking from '../models/bookingModel';
import { verifyAppleIdentityToken } from '../services/appleService';
import { Document, Types } from "mongoose";


export const kakaoLogin = async (req: Request, res: Response): Promise<void> => {
  const tag = `[KAKAO ${req.id}]`;
  console.log(`${tag} start`);
  const { accessToken, shippingAddr: clientAddr } = req.body;
  if (!accessToken) {
    res.status(400).json({ message: 'Access token is required.' });
    return;
  }

  try {
    console.log(`${tag} calling Kakao APIs …`);
    /* 1 ─ Parallel fetch profile + address */
    const [profileRes, addressRes] = await Promise.allSettled([
      axios.get('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      axios.get('https://kapi.kakao.com/v1/user/shipping_address', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { address_id: 'default' },
      }),
    ]);

    if (profileRes.status !== 'fulfilled') {
      console.error(`${tag} profile fetch failed`, profileRes.reason?.response?.data || profileRes.reason);
      res.status(500).json({ message: '카카오 프로필 정보를 불러오지 못했습니다.' });
      return;
    }

    const kakaoProfile = profileRes.value.data;
    const kakaoId = kakaoProfile?.id;
    if (!kakaoId) {
      res.status(500).json({ message: '카카오 ID를 가져오지 못했습니다.' });
      return;
    }

 /* 2 ─ Extract address (accept both snake_case & camelCase) */
let shippingAddr:| { base_address?: string; detail_address?: string }| null = null;

if (addressRes.status === 'fulfilled') {
  const raw  = addressRes.value.data;
  const list =
        raw.shipping_addresses   // REST response
     ?? raw.shippingAddresses    // SDK style (just in case)
     ?? [];

  const best = list.find((a: any) => a.is_default || a.isDefault) ?? list[0];

  if (best) {
    const base   = (best.base_address   ?? best.baseAddress  ?? '').trim();
    const detail = (best.detail_address ?? best.detailAddress?? '').trim();

    if (base || detail) {
      shippingAddr = { base_address: base, detail_address: detail };
    }
  }
}

if (!shippingAddr && clientAddr) {
    shippingAddr = {
      base_address:   clientAddr.base_address   ?? clientAddr.baseAddress   ?? '',
      detail_address: clientAddr.detail_address ?? clientAddr.detailAddress ?? '',
    };
  }

/* ⚑  ─────────────── see what we decided to store */
console.log(`${tag} shippingAddr chosen →`, shippingAddr);



    /* 3 ─ Normalize phone */
    const acct = kakaoProfile.kakao_account ?? {};
    let rawPhone = acct.phone_number?.replace(/\D/g, '');
    let phone = '';

    if (rawPhone?.startsWith('82')) {
      rawPhone = '0' + rawPhone.slice(2);
    }

    if (rawPhone && rawPhone.length === 11) {
      phone = `${rawPhone.slice(0, 3)}-${rawPhone.slice(3, 7)}-${rawPhone.slice(7)}`;
    } else {
      const fallback = `010${(kakaoId % 10_000_000_00).toString().padStart(8, '0')}`;
      phone = `${fallback.slice(0, 3)}-${fallback.slice(3, 7)}-${fallback.slice(7)}`;
    }

    /* 4 ─ Find or create user */
    const user = await findOrCreateKakaoUser({
      kakaoProfile,
      phone,
      shippingAddr,
    });

    const needsPhoneUpdate = !rawPhone;

    console.log(`${tag} user _id=${user._id} kakaoId=${kakaoId}`);

    /* 5 ─ Sign JWT */
    const token = jwt.sign(
      {
        _id: user._id,
        email: user.email,
        userId: user.userId,
        isAdmin: user.isAdmin,
        provider: 'kakao',
        phoneNeedsUpdate: needsPhoneUpdate,
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    /* 6 ─ Respond */
    res.status(200).json({
      message: '카카오 로그인에 성공했습니다.',
      user,
      token,
      needsPhoneUpdate,
      shippingAddr,
    });
    console.log(`${tag} success`);
  } catch (err: any) {
    console.error(`${tag} ERROR`, err?.response?.data || err);
    res.status(500).json({ message: '카카오 로그인에 실패했습니다.' });
  }
};


export const searchKakaoAddress = async (req: Request, res: Response): Promise<void> => {
  const query = String(req.query.query ?? '').trim();

  if (!query) {
    res.status(400).json({ message: '주소 쿼리가 필요합니다.' });
    return;
  }
  if (!process.env.KAKAO_REST_API_KEY) {
    console.error('❗ Kakao REST API Key is missing');
    res.status(500).json({ message: '서버 환경변수 오류' });
    return;
  }

  try {
    const response = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
      headers: {
        Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}`,
      },
      params: {
        query,
        category_group_code: 'AD5',
        size: 30,
      },
    });

    res.status(200).json(response.data);
  } catch (err: any) {
    console.error('Kakao API 오류:', err?.response?.data || err.message);
    res.status(500).json({ message: '카카오 주소 검색 실패' });
  }
};

export const searchExpandedRoad = async (req: Request, res: Response): Promise<void> => {
  const base = req.query.query?.toString();
  if (!base) {
    res.status(400).json({ message: 'query required' });
    return;
  }

  try {
    const addresses = [];

    for (let i = 1; i <= 30; i++) {
      const response = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
        headers: {
          Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}`,
        },
        params: { query: `${base} ${i}` },
      });

      const filtered = response.data.documents.filter((d: any) => d.road_address);
      if (filtered.length) {
        addresses.push(...filtered);
      }

      if (addresses.length >= 5) break;
    }

    res.status(200).json(addresses);
  } catch (err: any) {
    console.error('searchExpandedRoad error:', err.response?.data || err.message);
    res.status(500).json({ message: '주소 확장 검색 실패' });
  }
};
export { findOrCreateKakaoUser };

export const deleteKakaoAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user?._id);
    if (!user || user.provider !== 'kakao' || !user.kakaoId) {
      res.status(400).json({ message: '유효하지 않은 카카오 유저입니다.' });
      return;
    }

    // 1️⃣ Unlink Kakao
    try {
  await axios.post('https://kapi.kakao.com/v1/user/unlink',
                   `target_id_type=user_id&target_id=${user.kakaoId}`, {
    headers: {
      Authorization: `KakaoAK ${process.env.KAKAO_ADMIN_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  console.log('✅ Kakao unlink success');
} catch (e: any) {
  const code = e?.response?.data?.code;
  if (code !== -101) {
    console.error('unlink failed:', e?.response?.data || e);
    throw e;
  }
}
    // 2️⃣ Delete bookings (if any)
    await Booking.deleteMany({ user: user.userId }); 

    // 3️⃣ Delete user
    await user.deleteOne();

    res.status(200).json({ message: '카카오 계정과 관련 데이터가 삭제되었습니다.' });
  } catch (err) {
    console.error('deleteKakaoAccount error:', err);
    res.status(500).json({ message: '카카오 계정 삭제에 실패했습니다.' });
  }
};

export const loginApple = async (req: Request, res: Response): Promise<void> => {
  try {
    const { identityToken, authorizationCode } = req.body;

    if (!identityToken || !authorizationCode) {
      res.status(400).json({ message: '애플 정보가 존재하지 않습니다.' });
      return;
    }

    const payload = await verifyAppleIdentityToken(identityToken, process.env.APPLE_SERVICE_ID!);

    const user = await User.findOneAndUpdate(
      { 'apple.sub': payload.sub },
      {
        $setOnInsert: {
          email: payload.email ?? `relay-${payload.sub}@apple.com`,
          name: 'Apple User',
          'apple.sub': payload.sub,
          provider: 'apple',
        },
      },
      { upsert: true, new: true }
    );

    const token = createJwt(user);
    res.status(200).json({ token, user });
    return; 

  } catch (error) {
    console.error('[Apple Login Error]', error);
    res.status(500).json({ message: '애플 로그인 실패' });
     return;
  }
};

function createJwt(user: Document<unknown, {}, { createdAt: NativeDate; updatedAt: NativeDate; } & { name: string; isGuest: boolean; isAdmin: boolean; provider: "standard" | "kakao" | "guest" | "apple" | null; emailVerified: boolean; userId?: number | null | undefined; phone?: string | null | undefined; email?: string | null | undefined; password?: string | null | undefined; address?: string | null | undefined; addressDetail?: string | null | undefined; kakaoId?: string | null | undefined; providerId?: string | null | undefined; }> & { createdAt: NativeDate; updatedAt: NativeDate; } & { name: string; isGuest: boolean; isAdmin: boolean; provider: "standard" | "kakao" | "guest" | "apple" | null; emailVerified: boolean; userId?: number | null | undefined; phone?: string | null | undefined; email?: string | null | undefined; password?: string | null | undefined; address?: string | null | undefined; addressDetail?: string | null | undefined; kakaoId?: string | null | undefined; providerId?: string | null | undefined; } & { _id: Types.ObjectId; } & { __v: number; }) {
  throw new Error("미구현입니다.");
}
