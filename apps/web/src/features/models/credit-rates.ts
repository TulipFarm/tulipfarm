import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';

export function creditRates(
  family: Pick<ModelCatalogFamily, 'inputCreditsPerMillionTokens' | 'outputCreditsPerMillionTokens'>,
) {
  const format = (rate: number | null) =>
    rate === null ? 'Not priced' : rate.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (family.inputCreditsPerMillionTokens === null && family.outputCreditsPerMillionTokens === null)
    return 'Not priced';
  return `${format(family.inputCreditsPerMillionTokens)} / ${format(family.outputCreditsPerMillionTokens)}`;
}
