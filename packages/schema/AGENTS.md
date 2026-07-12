# Schema — Agent Conventions

`@tulipfarm/schema` — single source of truth for all config data shapes: TypeBox schemas +
inferred types + thin `validate*` wrappers, plus declarative resource transforms.
Implements `specs/VALIDATION.md`. See root `AGENTS.md` for commands/lint.

## Public API (`src/index.ts`)

- **`validate(boundary, schema, data)`** — compiles (TypeBox → AJV) and asserts; throws
  `TulipFarmValidationError` carrying the `boundary` + the instance `path`.
- **`ajv`** — the shared `Ajv2020` instance (`strict: false`, `allErrors: true`).
- **`applyTransforms`** + **`validateResourceSchema`** — resource `x-*` keyword handling.
- **`BOUNDARIES`** (+ type `ValidationBoundary`), **`NORMALIZER_KEYS`**, **`COMPUTED_FN_KEYS`**,
  type `CounterFn`.
- **`validateGuardrailsConfig`** (+ types `GuardrailsConfig`, `PromptInjectionConfig`,
  `ToolBlocklistConfig`, `ContentFilterConfig`) — validates a guardrails policy
  (`soul/guardrails.yaml`): a TypeBox meta-schema with strict per-stage guard unions, so a
  wrong-stage/unknown guard or bad enum is rejected. Consumed by the API's `GuardrailsService`.
- **`validateLlmConfig`** (+ `LlmConfigSchema`, types `LlmConfig`, `ProviderEntry`, `ModelSpec`,
  `TierConfig`, `EmbeddingProviderEntry`, `EmbeddingsConfig`) — validates the soul LLM config
  (tiers + embeddings). Runtime consumed by `@tulipfarm/llm`.
- **LLM error classes** — `LlmConfigValidationError`, `LlmCredentialError`,
  `LlmNotConfiguredError`, `UnknownModelError`, `EmbeddingUnavailableError` (thrown by
  `@tulipfarm/llm` runtime).

## Boundaries

7 error-tagging contexts: `soul`, `resource`, `api`, `agent`, `llm`, `event`, `integration`.

## Resource transforms (`transforms/`)

`applyTransforms` runs them in order: **`x-id-strategy`** → **`x-normalize`** → **`x-computed`**.

- Normalizers (closed set — `NORMALIZER_KEYS`): `trim`, `lowercase`, `uppercase`, `slugify`,
  `phone-e164`, `email-normalize`.
- Computed fns (closed set — `COMPUTED_FN_KEYS`): `sha256`, `uuid`, `sequence`
  (`sequence` needs an injected `CounterFn`).

## How to extend

- **New normalizer:** add the key to `NORMALIZER_KEYS` *and* its fn to the map in
  `transforms/normalizers.ts`.
- **New computed fn:** add the key to `COMPUTED_FN_KEYS` *and* its async fn in
  `transforms/computed.ts`.
- Call `validateResourceSchema()` when loading a resource schema so unknown `x-*` keys/fns are
  rejected up front (AJV runs `strict: false`, so it won't flag them for you).

## Tests

Vitest, colocated (`validate.test.ts`, `transforms/apply.test.ts`). Cover each normalizer/computed
fn, the apply order, and rejection of unknown schema keys.
