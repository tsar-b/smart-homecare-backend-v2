import type { Request, Response } from 'express';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type InitializeCache = {
  expiresAt: number;
  payload: unknown;
};

let cache: InitializeCache | null = null;

type CatalogTableSpec = {
  key: string;
  tables: readonly string[];
};

const CATALOG_TABLES: CatalogTableSpec[] = [
  { key: 'categories', tables: ['catalog_categories', 'categories'] },
  { key: 'serviceTypes', tables: ['service_types', 'servicetypes'] },
  { key: 'subtypes', tables: ['subtypes'] },
  { key: 'pricingTiers', tables: ['pricing_tiers', 'pricings'] },
  { key: 'options', tables: ['request_options', 'options'] },
  { key: 'assets', tables: ['assets'] },
  { key: 'timeSlots', tables: ['timeslots'] }
];

export async function initializeApp(_req: Request, res: Response) {
  if (cache && cache.expiresAt > Date.now()) {
    res.setHeader('cache-control', `private, max-age=${Math.floor(env.APP_INITIALIZE_CACHE_TTL_MS / 1000)}`);
    res.json(cache.payload);
    return;
  }

  const catalog = await readCatalog();
  const payload = {
    version: '2026-06-19.v1',
    currentUser: null,
    featureFlags: {
      requests: true,
      adminCrud: true,
      kakaoAddress: Boolean(env.KAKAO_REST_API_KEY)
    },
    catalog,
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

  res.setHeader('cache-control', `private, max-age=${Math.floor(env.APP_INITIALIZE_CACHE_TTL_MS / 1000)}`);
  res.json(payload);
}

async function readCatalog() {
  const entries = await Promise.all(
    CATALOG_TABLES.map(async ({ key, tables }) => {
      const data = await readFirstAvailable(tables);
      return [key, data ?? []] as const;
    })
  );

  return Object.fromEntries(entries);
}

async function readFirstAvailable(tables: readonly string[]) {
  for (const table of tables) {
    const { data, error } = await supabaseAdmin.from(table).select('*');
    if (!error) return data ?? [];
    if (error.code !== '42P01') {
      throw new HttpError(400, error.message, 'APP_INITIALIZE_FAILED', { table });
    }
  }

  return [];
}
