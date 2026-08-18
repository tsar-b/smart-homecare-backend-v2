import { HttpError } from '../../core/errors.js';
import { supabaseAdmin } from '../../db/supabaseAdmin.js';

type PricingInput = {
  optionIds: string[];
  pricingTierId?: string;
};

export async function calculateRequestPrice(input: PricingInput) {
  const [tierPrice, optionTotal] = await Promise.all([
    input.pricingTierId ? readTierPrice(input.pricingTierId) : Promise.resolve(0),
    input.optionIds.length ? readOptionTotal(input.optionIds) : Promise.resolve(0)
  ]);

  return tierPrice + optionTotal;
}

async function readTierPrice(id: string) {
  const { data, error } = await supabaseAdmin.from('pricing_tiers').select('base_price').eq('id', id).single();
  if (error) throw new HttpError(400, error.message, 'PRICING_TIER_READ_FAILED');
  return Number(data?.base_price ?? 0);
}

async function readOptionTotal(ids: string[]) {
  const { data, error } = await supabaseAdmin.from('request_options').select('extra_cost').in('id', ids);
  if (error) throw new HttpError(400, error.message, 'REQUEST_OPTIONS_READ_FAILED');
  return (data ?? []).reduce((sum, row) => sum + Number(row.extra_cost ?? 0), 0);
}
