# Shared model pricing configuration

[src/model-pricing.json](src/model-pricing.json) contains the provider-cost policy
and 20 model entries. Inspected on 28 September 2026. The package exports
`modelPricing` and the `@tulipfarm/config/model-pricing.json` subpath.

## Provider cost, not credit pricing

The catalog records what providers charge, in USD per million tokens. It is used for
metering: `calculateModelCost` turns usage into exact provider cost. It carries no
credit price, markup, or rounding.

Converting provider cost to credits is the `creditPricing` slot of
[`@tulipfarm/extensions`](../extensions/README.md#credit-pricing). The default is one
credit per $0.01 of provider cost, with no markup and no rounding. A deployment can
register its own rate and rounding.

## Model entries

Each entry records its provider model ID, LiteLLM metadata key, pricing source,
deployment pricing scope, and rate periods. A catalog entry does not establish
that an Azure deployment exists or that a model is selectable in the app.

Claude uses the direct Anthropic API at standard global pricing. Gemini uses the
Google Gemini API paid standard tier. Other models use Azure rates, with the
region and deployment scope recorded per entry. The GPT and Grok families also
list a direct OpenAI or xAI entry (`provider` `openai` or `xai`) recorded at the
same rates as their Azure entry. Kimi K2.6 and Kimi K2.7 Code use
Azure Global rates. GLM is excluded from the current catalog.

Rates cover model tokens and published cache token categories. Provider-billed
reasoning tokens belong in output usage without double-counting them. Cached
reads, cache writes, and uncached input must be mutually exclusive token counts.
Missing cache categories are unknown, not free. Image support means image input
capability, not image generation. Provider-reported image tokens use the applicable
input rate. This catalog does not convert images or media duration into tokens.

`policy.excludedCharges` lists charges outside this token catalog. Search, tools,
cache storage, compute, and tax need separate pricing before a billing consumer
can claim to charge the full provider cost. Batch, priority, flex, Anthropic fast
mode, and US-only Anthropic inference are not priced by these standard rates.

### Context and dates

The matching date period uses an inclusive `validFrom` and an exclusive
`validUntilExclusive`, interpreted as UTC dates. A null endpoint is unspecified,
not evidence of historical pricing. This is a snapshot for use from its review date.

Within that period, use the highest `promptTokensAbove` strictly below the request's
total prompt tokens, including cached tokens. A null threshold is the base rate.
The selected tier applies to all applicable input, cache, and output tokens in that
request, not just tokens over the threshold. Tier selection precedes aggregation.

- GPT-6 models retain full published input and output limits. Their higher rates start above 272,000 prompt tokens.
- Gemini 3.1 Pro Preview uses higher rates above 200,000 prompt tokens.
- Gemini 3.8 Flash records both the promotion through December 2026 and the announced January 2027 rates.
- Grok 4.6 retains a source inconsistency: LiteLLM lists a 200,000 input limit and a price tier above that limit. The tier does not authorize longer requests.

`metadata` preserves selected LiteLLM field names and values at the pinned source
commit. Absent capability fields mean unknown, not false. `max_input_tokens` and
`max_output_tokens` are separate provider limits. They do not promise that both
maxima can be used together. LiteLLM's `max_tokens` often duplicates the output
limit, so it is not presented as the combined context window.

## Source evidence

The JSON pins [LiteLLM's metadata snapshot](https://github.com/BerriAI/litellm/blob/b79fc9f1b0249cb533391dd7c941082f0cd6ddb1/model_prices_and_context_window.json).
Prices were checked against the linked Anthropic and Google pricing pages,
Azure's East US retail API, and Azure's Grok pricing page on 28 September 2026.
The source URLs are stored in the JSON.

The user confirmed these name mappings: GPT-6 Soul to Sol, GPT-6 Extra to Astra,
Kimi K2.7 to K2.7 Code, and Gemini 3.1 Pro to Pro Preview. On 29 September 2026,
the user selected the deployed Azure Grok 4.6 and 4.3 models, replaced Kimi K3 with
Kimi K2.6, and removed both GLM families.

Live requests on 29 September 2026 used the imported Foundry credential in
`tulipfarm-cloud` and returned HTTP 200, generated text, and matching identities
for `Kimi-K2.6` and `Kimi-K2.7-Code`. These checks establish basic provider access,
not tool-call qualification or application activation. Credential ownership is
documented in [the secrets guide](../../docs/secrets.md). Kimi K2.6 limits follow
[Microsoft's Moonshot catalog](https://github.com/microsoftdocs/azure-ai-docs/blob/main/articles/foundry/foundry-models/includes/models-azure-direct-others.md).
Its Azure retail meter IDs and inspection date are recorded in
`src/model-pricing.json`.

For Grok 4.6, the user selected Azure's retail input rate of $2 per million tokens.
Azure's pricing page and LiteLLM report $1.25. The JSON records the discrepancy
and retail meter ID. The catalog also retains LiteLLM's reported Kimi K2.7 Code
deprecation date of 3 October 2026 without claiming independent confirmation.

## Updates and verification

Edit the JSON policy and model rates together, then rebuild and redeploy consumers.
`pnpm --filter @tulipfarm/config test` checks rate-period coverage and that no
credit pricing has crept back into the catalog.

## Continuity contracts

`model-families.json` owns the stable family ID, display name, vendor, initial
current version, and explicit `modelIds` membership. `modelFamilyCatalogSchema`
requires each concrete pricing entry to belong to exactly one family and the
current version to belong to that family. Parsed membership lists are immutable.
These are curated assignments, not provider availability claims. New successors
belong in trusted bundles, not edits to the initial mapping or price revision.

A family may list one model per provider. `familyProviderModels(familyId)` returns
them with the current version's provider first; a server picks the first provider
it has a credential for.

A family's optional `capabilities` override the provider defaults
(`providerModelCapabilities`) for every model in the family. They pick the wire
behaviour inference uses, never a model ID:

| Capability                | Values                                                                                                      | Default            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------ |
| `api`                     | `chat-completions` or `responses` (Azure, OpenAI, xAI), `anthropic-messages` (Anthropic), `gemini` (Google) | the provider's API |
| `toolChoice`              | `forced` makes structured decisions select `select_action`; `auto` also accepts a text answer               | `forced`           |
| `reasoningOffForTools`    | sends reasoning effort `none` for deployments that reject tools while reasoning                             | `false`            |
| `reasoningTokensInOutput` | adds reported reasoning tokens to completion tokens                                                         | `false`            |
| `streaming`               | chat steps stream the response                                                                              | `true`             |
| `responseModelAliases`    | other model IDs the provider may report                                                                     | `[]`               |

`modelCapabilities(provider, providerModelId, ...overrides)` resolves the defaults,
the catalog entry and then each override layer, such as an inference route's own
`capabilities`. An `api` the provider does not serve is rejected. Capabilities do
not change mapping or price revisions.

`resolveModelFamily` resolves a curated family through an explicit mapping and a
trusted qualified route. A pricing entry alone is not an available model. Missing,
retired, ambiguous, or restricted routes fail resolution. The caller must provide
allowed providers and data locations. Route configuration contains no credentials.

Each result copies the concrete version, mapping revision, route, and complete
price schedule. Persist this result with run admission. Keep it unchanged across
attempts. Changing an application replica's mapping is not atomic promotion.
Platform activation and cohort admission remain separate delivery work.

`calculateModelCost` accepts disjoint token categories and returns exact provider
cost in trillionths of a US dollar, encoded as a decimal integer string. Unknown
usage remains unknown. Missing rates fail rather than becoming zero; only models of
an unmetered catalog family cost zero (see below). Context tiers
include cached prompt tokens and select the rate for the whole request.

The current bootstrap price revision is `prices-2026-10-19.1`. Any price correction
requires a new revision and preservation of existing run snapshots. Provider
qualification, durable receipts, admission, and UI integration are not established
by this module's tests.

## Operator catalog

The shipped JSON files are the default catalog. Operators add or replace families
and models with `MODEL_CATALOG_FILE` (a JSON file path) or `MODEL_CATALOG` (the
same JSON inline), never both. The JSON is `{ "families": [...], "models": [...] }`
in the shape of `model-families.json` and the `models` array of
`model-pricing.json`. `MODEL_CATALOG_MODE=extend` (default) adds entries and lets
an entry with a shipped id replace that entry whole; `replace` uses only the
operator's entries. `MODEL_FAMILIES` still chooses which families are enabled.

The [self-hosted models guide](https://docs.tulipfarm.ai/self-hosting/models/) is
the operator reference: providers and credentials, a full catalog example,
`capabilities`, `roles`, `"pricing": "unmetered"`, contract prices,
`openai-compatible` models with `endpoint` and `credentialEnv`, base URLs,
`MODEL_ENDPOINT_HOSTS`, credits, and what happens to running work after a change.

What this package guarantees:

- The catalog is parsed when `@tulipfarm/config` loads. An invalid catalog throws
  `ModelCatalogError` naming the entry, so the api and worker exit at startup.
- `modelCapabilities` and `modelRoleDefault` read the effective catalog. A role
  setting such as `CHAT_TITLE_MODEL_FAMILY` overrides the catalog `roles`, and
  `modelRoleWarnings` reports roles that fall back to the default chat family.
- Endpoints are checked by `model-endpoints.ts` at startup and before each
  request: built-in provider and Azure Foundry hosts are implicit, every other
  host must be in `MODEL_ENDPOINT_HOSTS`, and http is allowed only on loopback
  outside `NODE_ENV=production`.
- When the effective families or models equal the shipped ones, the published
  revisions (`families-2026-10-19.1`, `prices-2026-10-19.1`) are kept. Otherwise
  the revision is `families-` or `prices-` and 32 hex characters of a SHA-256
  digest of the canonical content. Families and prices hash separately, and a
  family's `capabilities` and `roles` and a model's `endpoint` and
  `credentialEnv` are left out of the hash.
- The web app does not load the operator catalog. Browser code reads the shipped
  names.

## Trusted versioned bundles

`modelBundleSchema` validates an immutable mapping, its price revision, explicit
model-to-family and vendor assignments, price schedules, and qualified routes.
Successors may introduce new concrete IDs within curated families. Existing
catalog IDs cannot change family or vendor. Provider changes require separate
work. Unknown bundle formats, adapters, overlapping price intervals, duplicate
identities, and unqualified routes are rejected.

`resolveModelBundle({ bundle, familyId, allowedProviders, allowedLocations })`
returns the existing resolution shape from one trusted bundle. It does not infer
membership from deployment names or select a route from pricing alone.
`initialBundleModels` supplies initial catalog metadata, not qualified deployments.
No production bundle or route is enabled by this package. The server builds its
bundle from the [server model configuration](https://docs.tulipfarm.ai/self-hosting/models/).

`parseModelResolution(receipt, trustedBundle)` validates the entire receipt against
its historical bundle. `calculateModelCost` accepts the same `trustedBundle` input.
It preserves unknown usage and uses historical prices even after later bundles
become current. Without a bundle, both functions retain initial-price validation.
That compatibility path checks curated family membership and rejects a concrete
version that contradicts the initial mapping revision. It cannot authenticate an
arbitrary noninitial mapping revision or deployment. Use a retained trusted bundle
for historical identity authentication, even when its rates match initial prices.
`resolvedModelShapeSchema` checks structure only. It does not authenticate prices.

Trusted bundles must come from reviewed platform configuration. Do not accept a
workspace-supplied bundle as authority to validate that workspace's receipts.
Platform storage must preserve bundle, mapping, and price revision identities,
and new concrete-model and route identities across successive bundles. This
stateless validator cannot detect reuse of a noninitial revision with new content.
Runtime admission must retain the bundle ID alongside each resolved run binding.
