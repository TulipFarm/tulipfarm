# Schema — Agent Conventions

`@tulipfarm/schema` — single source of truth for all config data shapes: TypeBox schemas +
inferred types + thin `validate*` wrappers, plus declarative resource transforms.
See root `AGENTS.md` for commands/lint.

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
- **`SchemaRegistry`** — strict `apiVersion`/`kind` dispatch with explicit unknown-property
  behavior, fail-closed YAML parsing, deterministic validation issues, and immutable validated
  documents.
- **`canonicalize` + `canonicalHash`** — deterministic canonical JSON and lowercase SHA-256 hex
  over parsed data; rejects values that JSON would silently erase or change.
- **Schema contract errors** — stable error codes for invalid/unknown/duplicate schemas, validation,
  YAML parsing, and canonicalization without protected payload values.
- **`INVOCATION_REQUEST_SCHEMAS`** (+ `CHAT_REQUEST_SCHEMA_REF`, `MANUAL_REQUEST_SCHEMA_REF`,
  `INTEGRATION_REQUEST_SCHEMA_REF`) — plain JSON Schemas for every request that mints a Run; the
  chat entry is the API's Fastify body schema, so the route and the request Artifact cannot drift.
  Compiled by the API's invocation gateway, which denies an unregistered ref.
- **`RUN_EVENT_DEFINITIONS`** (+ `RUN_EVENT_SCHEMAS`, `RUN_EVENT_TYPES`, `runEventDefinition`,
  `runEventSchemaRef`, types `RunEventAudience`, `RunEventDefinition`, `RunEventGuardrailStage`,
  `RunEventPayloads`, `RunEventSchema`,
  `RunEventType`) — the channel-neutral vocabulary a Run emits while it executes, each type bound
  to its audience (`participant` vs. operator-only evidence) and a payload schema. It lives here
  because the writer (the Worker) and the readers (the API's stream adapter, channel renderers)
  sit on opposite sides of an application boundary; adding an event means adding a definition, so
  no writer can invent a shape a reader was never built to parse. `RunEventPayloads` binds the two
  sides at compile time; a writer still validates, since a payload built from runtime data can be
  wrong in ways a type cannot catch. Optional fields must be **omitted**, never set to `undefined` —
  the schemas are `additionalProperties: false`. Events pair by id, not by position: a reader ties
  `tool.result` to its `tool.call` by `callId`, and `approval.requested` to the call it is holding
  by the same `callId` — so a turn with several calls in flight can be rendered from the stream
  alone, without a reader guessing which one an approval is about.

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
