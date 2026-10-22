import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';

/** Input plus output credits per million tokens, for the model picker's cost meter; undefined when unmetered or unknown. */
export function familyCost(family: ModelCatalogFamily) {
  const { inputCreditsPerMillionTokens: input, outputCreditsPerMillionTokens: output } = family;
  return input === null || output === null ? undefined : input + output;
}
