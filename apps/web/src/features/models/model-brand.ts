import type { Brand } from '@tulipfarm/sprout/brand-icon';

const vendorBrands = {
  anthropic: 'claude',
  openai: 'openai',
  deepseek: 'deepseek',
  xai: 'grok',
  moonshot: 'kimi',
  google: 'google',
} as const satisfies Record<string, Brand>;
export type ModelBrand = (typeof vendorBrands)[keyof typeof vendorBrands];

/** The logo for a catalog vendor; null for vendors without one, which show a neutral logo. */
export function modelBrand(vendor: string | undefined): ModelBrand | null {
  return vendor && Object.hasOwn(vendorBrands, vendor) ? vendorBrands[vendor as keyof typeof vendorBrands] : null;
}

export function matchesModel(name: string, query: string) {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}
