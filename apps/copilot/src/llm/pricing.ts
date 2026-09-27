// Cost accounting for LLM calls. Money is never a float: every result is an
// integer number of micro-USD (1 USD = 1,000,000 micro-USD) in a `bigint`.
//
// Pricing source: config/pricing.json, verified against Anthropic's
// published pricing page (see that file's `source`/`verifiedAt` fields).
import pricingData from '../../config/pricing.json';

interface ModelPricingEntry {
  inputPerMTok: number;
  outputPerMTok: number;
}

interface PricingFile {
  verifiedAt: string;
  source: string;
  currency: string;
  models: Record<string, ModelPricingEntry>;
}

const pricing = pricingData as PricingFile;

// Prices in config/pricing.json are USD per million tokens, which is
// numerically identical to micro-USD per token (1 USD / 1e6 tokens = 1e-6
// USD/token = 1 micro-USD/token). So `tokens * pricePerMTok` is already the
// exact cost in micro-USD — no division is needed for whole-number prices.
// For generality (a future fractional price, e.g. a $0.25/MTok cache rate),
// we scale prices up by PRICE_SCALE into integers, do the multiplication in
// BigInt, then ceil-divide back down — integer arithmetic throughout, and
// the result is always rounded UP to the next whole micro-USD.
const PRICE_SCALE = 10_000n;

function scalePrice(price: number): bigint {
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}

function getModelPricing(modelId: string): ModelPricingEntry {
  const entry = pricing.models[modelId];
  if (!entry) {
    throw new Error(`Unknown model id for pricing: "${modelId}"`);
  }
  return entry;
}

/** True when config/pricing.json has a price for this model. */
export function isPriced(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(pricing.models, modelId);
}

/** Integer micro-USD cost for a call, rounded up to the next whole micro-USD. */
export function costUsdMicro(modelId: string, tokensIn: number, tokensOut: number): bigint {
  const entry = getModelPricing(modelId);

  const tokensInBig = BigInt(Math.max(0, Math.trunc(tokensIn)));
  const tokensOutBig = BigInt(Math.max(0, Math.trunc(tokensOut)));

  const scaledCost =
    tokensInBig * scalePrice(entry.inputPerMTok) + tokensOutBig * scalePrice(entry.outputPerMTok);

  if (scaledCost <= 0n) return 0n;
  return (scaledCost + PRICE_SCALE - 1n) / PRICE_SCALE;
}

export function pricingMetadata(): { verifiedAt: string; source: string; currency: string } {
  return { verifiedAt: pricing.verifiedAt, source: pricing.source, currency: pricing.currency };
}
