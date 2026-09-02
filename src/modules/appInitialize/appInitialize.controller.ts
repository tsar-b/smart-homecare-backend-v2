import type { Request, Response } from 'express';
import { env } from '../../core/env.js';
import { buildLegacyBookingCatalog, readCatalogRows } from '../catalog/catalog.service.js';

type InitializeCache = {
  expiresAt: number;
  payload: unknown;
};

let cache: InitializeCache | null = null;

export async function initializeApp(_req: Request, res: Response) {
  if (cache && cache.expiresAt > Date.now()) {
    res.setHeader('cache-control', cacheControl());
    res.json(cache.payload);
    return;
  }

  const rows = await readCatalogRows();
  const legacy = buildLegacyBookingCatalog(rows);
  const payload = {
    version: '2026-09-02.v2',
    currentUser: null,
    featureFlags: {
      requests: false,
      bookings: true,
      adminCrud: true,
      kakaoAddress: Boolean(env.KAKAO_REST_API_KEY)
    },
    catalog: {
      categories: rows.categories,
      serviceTypes: rows.serviceTypes,
      subtypes: rows.subtypes,
      pricingTiers: rows.pricingTiers,
      options: rows.options,
      assets: rows.assets,
      timeSlots: rows.timeSlots
    },
    subtypes: legacy.subtypes,
    timeSlots: legacy.timeSlots,
    settings: {
      timezone: 'Asia/Seoul',
      currency: 'KRW'
    },
    localization: {
      defaultLocale: 'ko',
      supportedLocales: ['en', 'ko']
    }
  };

  cache = {
    expiresAt: Date.now() + env.APP_INITIALIZE_CACHE_TTL_MS,
    payload
  };

  res.setHeader('cache-control', cacheControl());
  res.json(payload);
}

export function clearInitializeCache() {
  cache = null;
}

function cacheControl() {
  const seconds = Math.floor(env.APP_INITIALIZE_CACHE_TTL_MS / 1000);
  return `public, max-age=${seconds}, stale-while-revalidate=${seconds}`;
}
