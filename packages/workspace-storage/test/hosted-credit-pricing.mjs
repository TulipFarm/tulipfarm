// A billing extension's price for tests that assert whole-credit balances:
// 150 credit units per pico-USD (one credit per $0.01 with a 50% markup), each aggregate rounded up to a whole credit.
const credit = 1_000_000_000_000n;

export const hostedCreditPricingExtension = {
  name: 'test-hosted-credit-pricing',
  register(slots) {
    slots.creditPricing({ unitsPerPicoUsd: 150n, round: units => ((units + credit - 1n) / credit) * credit });
  },
};
