# Schema — Agent Conventions

`@tulipfarm/schema` — single source of truth for all config data shapes: TypeBox schemas +
`Static<>`-derived types + thin `validate*` wrappers, plus declarative resource transforms.
See root `AGENTS.md` for commands/lint.

**Every schema is built with TypeBox and every type is derived from it** — see
[Schemas are TypeBox](#schemas-are-typebox). Read that before editing anything under
`src/definitions/`.

## Public API (`src/index.ts`)

- **`validate(boundary, schema, data)`** — compiles the JSON Schema with AJV and asserts; throws
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
- **`ARTIFACT_LAYOUTS`** (+ `classifySoulPath`, `definitionPath`, `companionPath`,
  `temporalClassOf`) — the single registry for where Soul artifacts live, which companion files
  belong to them, and whether runtime reads use a pinned or live digest. Consumers must derive from
  this registry; never copy it into regexes or parallel tables.
- **`canonicalize` + `canonicalHash`** — deterministic canonical JSON and lowercase SHA-256 hex
  over parsed data; rejects values that JSON would silently erase or change.
- **Schema contract errors** — stable error codes for invalid/unknown/duplicate schemas, validation,
  YAML parsing, and canonicalization without protected payload values.
- **`SECRET_REFERENCE_PATTERN`** (+ `secretReferenceSchema`, `isSecretReference`) — the one
  canonical shape for opaque Secret references. Trigger schemas, Integration schemas, and bundle
  compilation must use this export so authoring and publication cannot disagree.
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

## Schemas are TypeBox

Every schema in this package is built with **TypeBox**, and every type describing a validated value
is derived from its schema with `Static<>`. A schema and its type are never both written by hand.

```ts
const agentSpecSchema = Type.Object({ /* ... */ }, { additionalProperties: false });

export const AgentDefinitionSchema = definitionSchema("Agent", agentSpecSchema);
export const AGENT_DEFINITION = definitionRegistration("Agent", AgentDefinitionSchema);

export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export type AgentSpec = AgentDefinition["spec"];
```

### Why this rule exists

Nine of these files used to declare a plain JSON Schema object literal *and* a separate
hand-written `interface` for the same shape, with **nothing binding the two**. Editing one and not
the other compiled cleanly and shipped a type that lied about what validation accepted. Deriving
the type removes the possibility rather than relying on review to catch it.

`definitionSchema()` is generic over `TSchema` specifically so a plain literal is a **compile
error**, not a silent downgrade. Do not defeat that with a cast.

### Patterns

- Optional property → `Type.Optional(...)`. Never hand-write a `required` array: TypeBox derives it
  from which properties are not optional.
- **Enums are the trap.** `Type.Union([Type.Literal("a"), ...])` emits `anyOf`, which is a
  *different schema*. To keep the `enum` form, use `Type.Unsafe` over a literal, deriving both the
  type argument and the array from the same `as const` array so there is still one source of truth:

  ```ts
  Type.Unsafe<MemoryScope>({ type: "string", enum: [...MEMORY_SCOPES] })
  ```

- `Type.Unsafe<T>` is the escape hatch for shapes TypeBox has no constructor for (`if`/`then`,
  hand-assembled `allOf`). It asserts rather than derives, so keep its scope as small as possible
  and always base `T` on the same constants the literal uses.

### The safety net

`src/definitions/__schemas__/<Kind>.json` records the exact JSON Schema each kind registers, one
file per kind, plus `_kinds.json` guarding the set itself (a dropped kind would otherwise take its
`it.each` case with it and "pass" by never running). `schema-snapshot.test.ts` regenerates from the
TypeBox source and asserts against them on every run.

**These are vitest file snapshots, not build output.** Nothing imports them; they are not in the
shipped package. Never hand-edit one — edit the TypeBox schema and re-lock.

They exist because the emitted JSON does not always follow obviously from the source: `Type.Union`
emits `anyOf` where `Type.Unsafe<T>({type:"string",enum:[...]})` emits `enum`, and `Type.Literal`
adds a `type` alongside `const`. A source diff can look innocuous while the wire contract moves.

That matters because these schemas are not internal implementation — operators' Soul repositories
already hold artifacts validated against them, with digests recorded. **A diff here is a
compatibility event**, to be justified in review, not regenerated away:

```bash
pnpm --filter @tulipfarm/schema test -u    # re-lock, then read the diff before accepting it
```

## Boundaries

7 error-tagging contexts: `soul`, `resource`, `api`, `agent`, `llm`, `event`, `integration`.

## Resource transforms (`transforms/`)

`applyTransforms` runs them in order: **`x-id-strategy`** → **`x-normalize`** → **`x-computed`**.

- Normalizers (closed set — `NORMALIZER_KEYS`): `trim`, `lowercase`, `uppercase`, `slugify`,
  `phone-e164`, `email-normalize`.
- Computed fns (closed set — `COMPUTED_FN_KEYS`): `sha256`, `uuid`, `sequence`
  (`sequence` needs an injected `CounterFn`).

## How to extend

- **New definition kind:** add `src/definitions/<kind>.ts` following the TypeBox pattern above,
  register it in `definitions/index.ts`, then re-lock the snapshots with `test -u` (this writes a
  new `__schemas__/<Kind>.json` and updates `_kinds.json`).
- **New Soul artifact kind or file layout:** add it to `ARTIFACT_LAYOUTS` in `src/artifacts.ts`.
  Include companions and `temporalClass`. The tree reader, writers, validators, and bundle compiler
  must derive from that registry; "write a better regex" is the defect pattern, not the fix.
- **New Secret-bearing field:** use `secretReferenceSchema` or `SECRET_REFERENCE_PATTERN`; do not
  redeclare a local pattern. A value accepted by schema but rejected by the bundle compiler wedges
  auto-publication for the business.
- **New normalizer:** add the key to `NORMALIZER_KEYS` *and* its fn to the map in
  `transforms/normalizers.ts`.
- **New computed fn:** add the key to `COMPUTED_FN_KEYS` *and* its async fn in
  `transforms/computed.ts`.
- Call `validateResourceSchema()` when loading a resource schema so unknown `x-*` keys/fns are
  rejected up front (AJV runs `strict: false`, so it won't flag them for you).

## Tests

Vitest, colocated (`validate.test.ts`, `transforms/apply.test.ts`). Cover each normalizer/computed
fn, the apply order, and rejection of unknown schema keys.
