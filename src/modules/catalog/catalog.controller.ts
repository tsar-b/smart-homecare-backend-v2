import type { Request, Response } from 'express';
import { HttpError } from '../../core/errors.js';
import { initializeApp } from '../appInitialize/appInitialize.controller.js';
import {
  filterLegacyOptions,
  findLegacyPricing,
  readCatalogRows,
  toLegacyServiceTypes
} from './catalog.service.js';

export async function initializeCatalog(req: Request, res: Response) {
  await initializeApp(req, res);
}

export async function getServiceTypes(_req: Request, res: Response) {
  const rows = await readCatalogRows();
  res.json(toLegacyServiceTypes(rows));
}

export async function getOptions(req: Request, res: Response) {
  const rows = await readCatalogRows();
  const subtype = resolveIdentity(rows.subtypes, String(req.query.subtype ?? ''));
  const serviceType = resolveIdentity(rows.serviceTypes, String(req.query.serviceType ?? ''));
  res.json(filterLegacyOptions(rows, subtype, serviceType));
}

export async function getPricing(req: Request, res: Response) {
  const rows = await readCatalogRows();
  const subtype = resolveIdentity(rows.subtypes, String(req.query.subtype ?? ''));
  const serviceType = resolveIdentity(rows.serviceTypes, String(req.query.serviceType ?? ''));
  if (!subtype || !serviceType) {
    throw new HttpError(400, 'subtype and serviceType are required', 'PRICING_QUERY_REQUIRED');
  }
  const pricing = findLegacyPricing(rows, subtype, serviceType);
  if (!pricing.length) throw new HttpError(404, 'Pricing not found', 'PRICING_NOT_FOUND');
  res.json(pricing.length === 1 ? pricing[0] : pricing);
}

function resolveIdentity(rows: any[], value: string) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return rows.find(
    (row) =>
      String(row.id) === value ||
      String(row.key ?? '').toLowerCase() === normalized ||
      String(row.label ?? '').toLowerCase() === normalized
  )?.id as string | undefined;
}
