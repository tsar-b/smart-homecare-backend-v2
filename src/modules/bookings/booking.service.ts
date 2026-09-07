import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type OptionInput = {
  option_id?: string;
  _id?: string;
  option?: string;
  value?: string;
  selectedValue?: string;
  choice?: string;
};

type QuoteInput = {
  subtypeReference: string;
  serviceTypeReference: string;
  pricingTierId?: string;
  tier?: string;
  options: OptionInput[];
  legacyTotalPrice?: number;
};

type CatalogIdentity = { id: string; key: string; label: string };
type PricingTier = {
  id: string;
  key: string;
  label: string;
  base_price: number;
  memo: string | null;
  service_type: string | null;
  service_type_id: string | null;
  subtype: string | null;
};

type OptionRow = {
  id: string;
  key: string;
  label: string;
  extra_cost: number;
  applies_to: unknown;
  service_types: unknown;
  choices: unknown;
};

export type BookingQuote = {
  subtype: CatalogIdentity;
  serviceType: CatalogIdentity;
  pricingTier: PricingTier | null;
  optionSnapshots: Array<{
    option_id: string;
    key: string;
    label: string;
    value: string;
    selected_label: string;
    extra_cost: number;
  }>;
  totalPrice: number;
  priceSource: 'catalog' | 'legacy_client';
};

export async function buildBookingQuote(input: QuoteInput): Promise<BookingQuote> {
  const [subtypes, serviceTypes] = await Promise.all([
    readCatalog<CatalogIdentity>('subtypes', 'id, key, label'),
    readCatalog<CatalogIdentity>('service_types', 'id, key, label')
  ]);
  const subtype = findCatalogIdentity(subtypes, input.subtypeReference, 'subtype');
  const serviceType = findCatalogIdentity(serviceTypes, input.serviceTypeReference, 'service type');

  const { data: pricingData, error: pricingError } = await supabaseAdmin
    .from('pricing_tiers')
    .select('id, key, label, base_price, memo, service_type, service_type_id, subtype')
    .eq('subtype', subtype.id)
    .or(`service_type.eq.${serviceType.id},service_type_id.eq.${serviceType.id}`);
  if (pricingError) throw new HttpError(400, pricingError.message, 'PRICING_LOOKUP_FAILED');

  const pricingTiers = (pricingData ?? []) as PricingTier[];
  const pricingTier = resolvePricingTier(pricingTiers, input.pricingTierId, input.tier);
  const optionSnapshots = await resolveOptions(input.options, subtype.id, serviceType.id);
  const optionsTotal = optionSnapshots.reduce((sum, option) => sum + option.extra_cost, 0);

  if (pricingTier) {
    const basePrice = Number(pricingTier.base_price);
    return {
      subtype,
      serviceType,
      pricingTier,
      optionSnapshots,
      totalPrice: basePrice < 0 ? -1 : basePrice + optionsTotal,
      priceSource: 'catalog'
    };
  }

  if (input.legacyTotalPrice === undefined) {
    throw new HttpError(
      400,
      'pricing_tier_id or tier is required when multiple prices exist',
      'PRICING_TIER_REQUIRED'
    );
  }

  return {
    subtype,
    serviceType,
    pricingTier: null,
    optionSnapshots,
    totalPrice: input.legacyTotalPrice,
    priceSource: 'legacy_client'
  };
}

export async function assertBookableSlot(date: string, time: string, timezone: string) {
  if (isSlotInPast(date, time, timezone)) {
    throw new HttpError(409, 'Reservation time is in the past', 'BOOKING_SLOT_IN_PAST');
  }

  const { data, error } = await supabaseAdmin.from('timeslots').select('date, type, slots');
  if (error) throw new HttpError(503, 'Unable to load configured time slots', 'AVAILABILITY_FAILED');
  const exact = (data ?? []).find((row) => row.date === date);
  const fallback = (data ?? []).find((row) => row.date === null || row.type === 'generic');
  const slots = normalizeSlots(exact?.slots ?? fallback?.slots ?? []);
  if (!slots.includes(time)) {
    throw new HttpError(400, 'Reservation time is not configured', 'BOOKING_SLOT_NOT_CONFIGURED');
  }
}

export function isSlotInPast(date: string, time: string, timezone: string, now = new Date()) {
  const current = zonedDateTime(now, timezone);
  return date < current.date || (date === current.date && time <= current.time);
}

export function normalizeSlots(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((slot) => (typeof slot === 'string' ? slot : typeof slot?.time === 'string' ? slot.time : null))
    .filter((slot): slot is string => Boolean(slot));
}

async function readCatalog<T>(table: string, columns: string) {
  const { data, error } = await supabaseAdmin.from(table).select(columns);
  if (error) throw new HttpError(503, error.message, 'CATALOG_LOOKUP_FAILED');
  return (data ?? []) as unknown as T[];
}

function findCatalogIdentity(rows: CatalogIdentity[], reference: string, label: string) {
  const normalized = reference.trim().toLowerCase();
  const row = rows.find(
    (candidate) =>
      candidate.id === reference ||
      candidate.key.toLowerCase() === normalized ||
      candidate.label.toLowerCase() === normalized
  );
  if (!row) throw new HttpError(400, `Unknown ${label}`, 'CATALOG_REFERENCE_INVALID');
  return row;
}

function resolvePricingTier(rows: PricingTier[], id?: string, tier?: string) {
  if (id) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new HttpError(400, 'Pricing tier does not match this service', 'PRICING_TIER_INVALID');
    return row;
  }
  if (tier) {
    const normalized = tier.trim().toLowerCase();
    const row = rows.find(
      (candidate) => candidate.key.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized
    );
    if (!row) throw new HttpError(400, 'Pricing tier does not match this service', 'PRICING_TIER_INVALID');
    return row;
  }
  return rows.length === 1 ? rows[0] : null;
}

async function resolveOptions(options: OptionInput[], subtypeId: string, serviceTypeId: string) {
  if (!options.length) return [];

  const normalized = options.map((option) => ({
    id: String(option.option_id ?? option._id ?? option.option),
    value: String(option.value ?? option.selectedValue ?? option.choice)
  }));
  if (new Set(normalized.map((option) => option.id)).size !== normalized.length) {
    throw new HttpError(400, 'An option may only be selected once', 'DUPLICATE_OPTION');
  }

  const { data, error } = await supabaseAdmin
    .from('request_options')
    .select('id, key, label, extra_cost, applies_to, service_types, choices')
    .in('id', normalized.map((option) => option.id));
  if (error) throw new HttpError(400, error.message, 'OPTION_LOOKUP_FAILED');
  const rows = (data ?? []) as OptionRow[];
  if (rows.length !== normalized.length) {
    throw new HttpError(400, 'One or more options do not exist', 'OPTION_INVALID');
  }

  return normalized.map((selection) => {
    const row = rows.find((candidate) => candidate.id === selection.id)!;
    if (!stringArray(row.applies_to).includes(subtypeId) || !stringArray(row.service_types).includes(serviceTypeId)) {
      throw new HttpError(400, 'Option does not apply to the selected service', 'OPTION_NOT_APPLICABLE');
    }
    const choices = objectArray(row.choices);
    const choice = choices.find((candidate) => String(candidate.value) === selection.value);
    if (!choice && choices.length) {
      throw new HttpError(400, 'Selected option value does not exist', 'OPTION_VALUE_INVALID');
    }
    return {
      option_id: row.id,
      key: row.key,
      label: row.label,
      value: selection.value,
      selected_label: String(choice?.label ?? selection.value),
      extra_cost: Number(choice?.extraCost ?? choice?.extra_cost ?? row.extra_cost ?? 0)
    };
  });
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
}

function zonedDateTime(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric'
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = value('hour') === '24' ? '00' : value('hour');
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${hour}:${value('minute')}`
  };
}
