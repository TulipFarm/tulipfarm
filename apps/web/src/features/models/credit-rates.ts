import type { ModelCatalogFamily, ModelCatalogImageModel } from '@tulipfarm/config/model-catalog';

export function creditRates(
  family: Pick<ModelCatalogFamily, 'inputCreditsPerMillionTokens' | 'outputCreditsPerMillionTokens'>,
) {
  const format = (rate: number | null) =>
    rate === null ? 'Not priced' : rate.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (family.inputCreditsPerMillionTokens === null && family.outputCreditsPerMillionTokens === null)
    return 'Not priced';
  return `${format(family.inputCreditsPerMillionTokens)} / ${format(family.outputCreditsPerMillionTokens)}`;
}

export function imageCreditRates(
  image: Pick<ModelCatalogImageModel, 'creditsPerImage' | 'outputCreditsPerMillionTokens'>,
) {
  const format = (rate: number) => rate.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (image.creditsPerImage) {
    const prices = Object.values(image.creditsPerImage.standard);
    const low = Math.min(...prices);
    const high = Math.max(...Object.values(image.creditsPerImage.high));
    return `${format(low)}–${format(high)} per image`;
  }
  if (image.outputCreditsPerMillionTokens !== null)
    return `${format(image.outputCreditsPerMillionTokens)} per 1M image tokens`;
  return 'Not priced';
}
