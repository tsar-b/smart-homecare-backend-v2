import type { Request, Response } from 'express';
import { HttpError } from '../../../core/errors.js';
import { env } from '../../../core/env.js';

export async function searchKakaoAddress(req: Request, res: Response) {
  const query = String(req.query.query ?? '').trim();
  if (!query) throw new HttpError(400, 'query is required', 'QUERY_REQUIRED');
  if (!env.KAKAO_REST_API_KEY) throw new HttpError(500, 'Kakao key is not configured', 'KAKAO_NOT_CONFIGURED');

  const response = await fetch('https://dapi.kakao.com/v2/local/search/address.json?' + new URLSearchParams({ query }), {
    headers: {
      Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}`
    }
  });

  if (!response.ok) {
    throw new HttpError(response.status, 'Kakao address lookup failed', 'KAKAO_ADDRESS_FAILED');
  }

  res.json(await response.json());
}
