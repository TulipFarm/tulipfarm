# Shared model configuration

[catalog/models.json](catalog/models.json) is the shipped model catalog: every
model a deployment serves, its provider routes, limits, capabilities, prices,
the default model and the model of each role. Its format is
`modelCatalogFileSchema` in [src/model-catalog-file.ts](src/model-catalog-file.ts),
published as the JSON Schema
[schemas/model-catalog.v1.json](schemas/model-catalog.v1.json)
(`https://tulipfarm.ai/schemas/model-catalog.v1.json`). `pnpm config:docs`
regenerates the schema; [schemas/model-catalog.example.json](schemas/model-catalog.example.json)
is a small example. Prices were inspected on 28 September 2026.

## Provider cost, not credit pricing

The catalog records what providers charge, in USD per million tokens. It is used for
metering: `calculateModelCost` turns usage into exact provider cost. It carries no
credit price, markup, or rounding.

Converting provider cost to credits is the `creditPricing` slot of
[`@tulipfarm/extensions`](../extensions/README.md#credit-pricing). The default is one
credit per $0.01 of provider cost, with no markup and no rounding. A deployment can
register its own rate and rounding.

## Model entries

Each model lists its routes (provider and deployment or model ID) in order of
preference, its limits and its rate periods; `notes` keeps the pricing source and
deployment scope. A route does not establish that an Azure deployment exists.

Claude uses the direct Anthropic API at standard global pricing. Gemini uses the
Google Gemini API paid standard tier. Other models use Azure rates. The GPT and
Grok models also have a direct OpenAI or xAI route after their Azure route,
charged at the same rates. Kimi K2.6 and Kimi K2.7 Code use
Azure Global rates. GLM is excluded from the current catalog.

Rates cover model tokens and published cache token categories. Provider-billed
reasoning tokens belong in output usage without double-counting them. Cached
reads, cache writes, and uncached input must be mutually exclusive token counts.
Missing cache categories are unknown, not free. Image support means image input
capability, not image generation. Provider-reported image tokens use the applicable
input rate. This catalog does not convert images or media duration into tokens.

Charges outside this token catalog are not priced. Search, tools,
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

`limits.maxInputTokens` and `limits.maxOutputTokens` are separate provider
limits, taken from LiteLLM's metadata. They do not promise that both maxima can be
used together.

## Source evidence

Limits come from [LiteLLM's metadata snapshot](https://github.com/BerriAI/litellm/blob/b79fc9f1b0249cb533391dd7c941082f0cd6ddb1/model_prices_and_context_window.json).
Prices were checked against the Anthropic and Google pricing pages, Azure's East
US retail API, and Azure's Grok pricing page on 28 September 2026.

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
Its Azure retail meter IDs are recorded in its catalog `notes`.

For Grok 4.6, the user selected Azure's retail input rate of $2 per million tokens.
Azure's pricing page and LiteLLM report $1.25. The JSON records the discrepancy
and retail meter ID in its `notes`. The catalog also retains LiteLLM's reported Kimi K2.7 Code
deprecation date of 3 October 2026 without claiming independent confirmation.

## Updates and verification

Edit `catalog/models.json`, then rebuild and redeploy consumers.
`pnpm --filter @tulipfarm/config test` validates the shipped catalog and checks
that the bundles stored before the catalog file still verify.

## Configuration

The api and worker read one catalog at startup and validate it with
`modelCatalogFileSchema`:

- `MODEL_CATALOG_FILE`, a path to a catalog file, or
- `MODEL_CATALOG`, the same JSON inline (`$schema` optional), for container hosts
  that cannot mount files.

Either replaces the shipped catalog entirely; setting both fails. An invalid
catalog stops startup with `Invalid model catalog (<source>): <field>: <problem>`,
where the source is `MODEL_CATALOG_FILE=<path>`, `MODEL_CATALOG` or `shipped
catalog`. `loadModelCatalog(env)` returns the served catalog and
`readModelCatalog(env)` only the validated file.

- **Keys.** The file holds environment variable names, never values. The built-in
  providers (`modelProviderDefaults`) use their standard variables, such as
  `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`. A `providers` entry names other
  variables with `apiKeyEnv` and `endpointEnv`. A name with a public prefix
  (`VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`) is rejected.
- **Listed is enabled.** A model is served by its first route whose key (and
  endpoint, where required) is set. With `"missingKeys": "fail"` (the default), a
  model without one stops startup. With `"skip"` (the shipped catalog), it is left
  out with a startup warning. When the default is skipped, the first remaining
  selectable, unpaused model is the default. Startup fails when no model remains.
- **Default.** The `"default": true` model serves new chats, new agents, agent
  instruction improvements, messages without a model, and chats and agents whose
  model the catalog no longer lists. The web app tells a person whose saved model
  was removed which model new messages use.
- **Paused and hidden.** A `paused` model keeps serving existing chats and agents
  (or their workspace fallback target) but cannot be chosen for new work. A
  `"selectable": false` model is hidden from the model picker and cannot be
  chosen, but serves its roles and the chats already on it.
- **Roles.** Each role is on at most one model. Without a `title` model, the
  chat's own model titles the chat. Without a `table-search` or `recommendation`
  model, that feature is off. `compaction`, `review`, `plan`, `heartbeat` and
  `public-guide` use the default model; the public guide still needs an Azure
  chat-completions route.
- **Context window.** `limits.maxInputTokens` is the window a chat reply fits
  in. Fit is estimated in tokens (the provider's reported prompt tokens, or a
  quarter of the request bytes). A reply never fails on its size: at the
  workspace compaction trigger it summarises its older tool results, and each
  tool result is cut to 10% of the window with the rest readable by call ID.
  If the provider still rejects a round as too long, the reply counts that
  request as at least the window, compacts every result but the latest round
  (then the latest round too) toward the target, and retries the round at most
  twice; the rejected call is not charged. Slack and external-context replies
  use the same workspace policy and summary models. The completion check's
  evidence is trimmed, oldest first, to fit its model's window.

- **Document vision.** The optional `document-vision` role reads the images in
  Knowledge documents: every visible word and a description of what each image
  shows. Its model must declare `"imageInput": true` in `capabilities`, or the
  catalog is invalid. Without it, images in Knowledge documents are left out
  and reported as coverage gaps. Calls are billed to the document's workspace.
  With the workspace `images` flag on, Knowledge, chat and tasks all read
  images with the workspace's chosen image reader instead (falling back to
  this role), and share its cached recognitions.
- **Image input.** A model with `"imageInput": true` may set
  `limits.imageInputTokens` (the most input tokens one image may cost, used to
  reserve credits; default 1600) and `limits.maxImageBytes` (larger images are
  downscaled before sending; default 5 MiB). Other models reject both. A
  workspace admin chooses the image reader that describes images for models
  without image input; it defaults to the `document-vision` model.
- **Image models.** `imageModels` lists the models that generate images. Each
  has `routes` (chosen like a model's, with an `api` of `openai-images`,
  `xai-images` or `gemini-images` that the route's provider type must serve),
  the provider size for each of `aspects.square`, `portrait` and `landscape`,
  `edits` and `maxSources` for source images, and `pricing`: `"unmetered"`,
  `usdPerImage` by quality (`standard`, `high`) and shape, or token rates. With
  token rates, `maxTokens.input` and `maxTokens.output` (default 32768 and 16384) bound what one image request is held for before the provider answers;
  a request reporting more is charged its hold. At most one is `"default": true`, and the default cannot be paused. A model's
  `imageModel` pairs it with one image model; without a pair, work on it uses
  the workspace's chosen image model, then the catalog default. A pair that is
  unavailable falls back the same way. Without any served image model, image
  generation is off.
- **Completion checks.** The optional `completion-check` role checks whether a
  tool-using chat reply is a sufficient stopping point. Without it, checks keep
  using the active chat model (including a chat fallback). Assign the role to
  a model in your catalog to choose another provider-neutral route; no new
  environment variable is needed. Calls keep source authorization, credit
  admission and usage billing for that model. Check output is capped at 384
  tokens, or the model's smaller limit. Reasoning is disabled only where the
  existing `reasoningOffForTools` capability permits it; qualify a model's
  decisions and output budget before assigning it this role.
- **Fallback.** The `fallback` role is off unless a model has it. Then a chat
  model call that fails before producing any output, with a failure another
  model can fix (`not_found`, `auth`, `quota_exceeded`, `rate_limited`,
  `server_error`, `timeout` or `network`), retries once on that model. It never
  retries after streamed output or on `content_filtered`, `context_too_long` or
  `bad_request`, and a paused fallback model or the chat's own model is not
  used. The reply notes and bills the model that answered; the chat keeps its
  selected model. Each decision is counted as `gen_ai_model_fallback` with a
  bounded `model_fallback` outcome (`used`, `not_configured`, `not_eligible`,
  `failed`).
- **Usage.** Chat-completions usage is read from any streamed chunk, including a
  final usage-only chunk, and tolerates null or missing detail objects and
  `total_tokens`. When `total_tokens` is reported, it decides whether reasoning
  tokens are already in the completion count. Every successful chat call is
  counted as `gen_ai_model_usage` with a bounded `model_usage` outcome
  (`reported`, `unknown`). Unknown usage also logs a `chat.model-usage`
  `usage-unknown` warning with `usage.unknown_reason` (`missing`, `invalid`) and
  `usage.shape`, the provider's usage field names and numbers without text.
- **Endpoints.** `model-endpoints.ts` checks every endpoint at startup and before
  each request: built-in provider and Azure Foundry hosts are implicit, every
  other host must be in `MODEL_ENDPOINT_HOSTS`, and http is allowed only on
  loopback outside `NODE_ENV=production`.
- **Removed settings.** `MODEL_FAMILIES`, `MODEL_PAUSED_FAMILIES`,
  `MODEL_DEFAULT_FAMILY`, `MODEL_CATALOG_MODE` and the `*_MODEL_FAMILY` role
  settings stop startup, naming what replaces each in the catalog
  (`removedModelSettings`).

A model's optional `capabilities` override the provider defaults
(`providerModelCapabilities`). They pick the wire behaviour inference uses, never
a model ID:

| Capability                | Values                                                                                                      | Default            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------ |
| `api`                     | `chat-completions` or `responses` (Azure, OpenAI, xAI), `anthropic-messages` (Anthropic), `gemini` (Google) | the provider's API |
| `toolChoice`              | `forced` makes structured decisions select `select_action`; `auto` also accepts a text answer               | `forced`           |
| `reasoningOffForTools`    | sends reasoning effort `none` for deployments that reject tools while reasoning                             | `false`            |
| `reasoningTokensInOutput` | adds reported reasoning tokens to completion tokens when the response omits `total_tokens`                  | `false`            |
| `streaming`               | chat steps stream the response                                                                              | `true`             |
| `imageInput`              | the model accepts images in user messages; the `document-vision` model needs it                             | `false`            |
| `responseModelAliases`    | other model IDs the provider may report                                                                     | `[]`               |

An `api` the provider does not serve is rejected. Capabilities do not change
mapping or price revisions. `"pricing": "unmetered"` marks a model whose usage
costs zero.

The [self-hosted models guide](https://docs.tulipfarm.ai/self-hosting/models/) is
the operator reference. The web app does not load the catalog; it reads the
server's `/model-catalog` route.

## Continuity contracts

[src/legacy-models-2026-10-19.json](src/legacy-models-2026-10-19.json) is a frozen
record of the models, families and prices served before the catalog file
(`legacyModels`, `initialModelMapping`, `initialBundleModels`; mapping revision
`families-2026-10-19.1`, prices `prices-2026-10-19.1`). It is never
configuration. It keeps the receipts, runs and server bundles that earlier
releases stored verifiable: `resolvedModelSchema` and `resolveModelFamily` check
the initial mapping against it. Never edit it.

`servedModelBundle` builds the server bundle of the served models. A served model
that matches a frozen model (same family, vendor, provider and deployment) keeps
its bundle model ID. Prices keep the `prices-2026-10-19.1` revision while every
model matches the frozen record, so an unchanged catalog produces the same bundle
id as earlier releases. Other prices get a revision derived from their content.
The bundle id is the SHA-256 of the bundle content, so a stored bundle is checked
against the id its runs recorded (`verifyServerModelBundle`).

Each resolution copies the concrete version, mapping revision, route, and complete
price schedule. Persist it with run admission and keep it unchanged across
attempts.

`calculateModelCost` accepts disjoint token categories and returns exact provider
cost in trillionths of a US dollar, encoded as a decimal integer string. Unknown
usage remains unknown. Missing rates fail rather than becoming zero; only
unmetered models cost zero. Context tiers include cached prompt tokens and select
the rate for the whole request. A price change to a served model gives its bundle
a new price revision; existing run snapshots keep theirs.

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
`initialBundleModels` supplies the frozen record's metadata, not qualified
deployments. The server builds its bundle from its model catalog.

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
