import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type CatalogRows = Awaited<ReturnType<typeof readCatalogRows>>;

export async function readCatalogRows() {
  const [categories, serviceTypes, subtypes, pricingTiers, options, assets, timeSlots] = await Promise.all([
    readTable('catalog_categories'),
    readTable('service_types'),
    readTable('subtypes'),
    readTable('pricing_tiers'),
    readTable('request_options'),
    readTable('assets'),
    readTable('timeslots')
  ]);

  return { categories, serviceTypes, subtypes, pricingTiers, options, assets, timeSlots };
}

export function buildLegacyBookingCatalog(rows: CatalogRows) {
  const subtypes = rows.subtypes.map((subtype: any) => {
    const serviceIds = stringArray(subtype.service_options);
    const serviceOptions = rows.serviceTypes
      .filter((service: any) => serviceIds.includes(String(service.id)))
      .map((service: any) => {
        const pricing = rows.pricingTiers.filter(
          (tier: any) =>
            String(tier.subtype) === String(subtype.id) &&
            String(tier.service_type_id ?? tier.service_type) === String(service.id)
        );
        const tiers = (pricing.length ? pricing : [null]).map((tier: any) => {
          const tierKey = tier?.key ?? 'standard';
          const matchingAssets = rows.assets.filter(
            (asset: any) =>
              String(asset.subtype) === String(subtype.id) &&
              String(asset.service_type) === String(service.id) &&
              String(asset.tier) === String(tierKey)
          );
          const blueprint = matchingAssets.find((asset: any) => asset.kind === 'blueprint');
          return {
            _id: tier?.id ?? null,
            id: tier?.id ?? null,
            tier: tierKey,
            price: tier ? Number(tier.base_price) : -1,
            memo: tier?.memo ?? null,
            assets: {
              blueprint: blueprint?.url ?? null,
              parts: matchingAssets
                .filter((asset: any) => asset.kind === 'part')
                .map((asset: any) => ({
                  _id: asset.id,
                  label: asset.label,
                  partId: asset.part_id,
                  url: asset.url,
                  steps: asset.steps ?? []
                }))
            }
          };
        });

        const relatedOptions = rows.options
          .filter(
            (option: any) =>
              stringArray(option.applies_to).includes(String(subtype.id)) &&
              stringArray(option.service_types).includes(String(service.id))
          )
          .map(toLegacyOption);

        return {
          _id: service.id,
          id: service.id,
          name: service.key,
          key: service.key,
          label: service.label,
          tiers,
          options: relatedOptions
        };
      });

    return {
      _id: subtype.id,
      id: subtype.id,
      name: subtype.key,
      key: subtype.key,
      label: subtype.label,
      iconUrl: subtype.icon_url,
      category: subtype.category,
      serviceOptions
    };
  });

  return { subtypes, timeSlots: rows.timeSlots };
}

export function toLegacyServiceTypes(rows: CatalogRows) {
  return rows.serviceTypes.map((service: any) => ({
    ...service,
    _id: service.id,
    name: service.key
  }));
}

export function filterLegacyOptions(rows: CatalogRows, subtype?: string, serviceType?: string) {
  return rows.options
    .filter((option: any) => !subtype || stringArray(option.applies_to).includes(subtype))
    .filter((option: any) => !serviceType || stringArray(option.service_types).includes(serviceType))
    .map(toLegacyOption);
}

export function findLegacyPricing(rows: CatalogRows, subtype: string, serviceType: string) {
  return rows.pricingTiers
    .filter(
      (tier: any) =>
        String(tier.subtype) === subtype && String(tier.service_type_id ?? tier.service_type) === serviceType
    )
    .map((tier: any) => ({
      ...tier,
      _id: tier.id,
      tier: tier.key,
      price: Number(tier.base_price)
    }));
}

async function readTable(table: string) {
  const { data, error } = await supabaseAdmin.from(table).select('*');
  if (error) throw new HttpError(503, error.message, 'CATALOG_READ_FAILED', { table });
  return data ?? [];
}

function toLegacyOption(option: any) {
  return {
    ...option,
    _id: option.id,
    appliesTo: option.applies_to,
    serviceTypes: option.service_types,
    extraCost: Number(option.extra_cost ?? 0)
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}
