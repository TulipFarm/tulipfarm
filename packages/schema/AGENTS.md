# Schema (`@tulipfarm/schema`)

Config contract owner: TypeBox schemas, `Static<>` types, validators, Soul artifact layout,
Run event/request vocabularies, canonical hashes, Secret references, and resource transforms.

## Read on / Skip

- **Read on if** you change a schema, validator, Soul layout, Run event/request, or transform.
- **Skip if** you only consume validated config; read the consumer package's `AGENTS.md` instead.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/chat.ts` | Chat metadata and resumable Turn wire contracts. |
| `src/definitions/` | TypeBox Soul definition schemas and file snapshots. |
| `src/artifacts.ts` | `ARTIFACT_LAYOUTS`: Soul paths, companions, temporal class. |
| `src/registry.ts` | Strict `apiVersion`/`kind` dispatch and fail-closed YAML parsing. |
| `src/run-events.ts` | Channel-neutral Run event types, audiences, payload schemas. |
| `src/invocation.ts` | JSON Schemas for requests that mint Runs. |
| `src/llm.ts`, `src/model-catalog.ts` | LLM config schema and ModelProfile derivation. |
| `src/guardrails.ts` | Guardrail policy schema with strict per-stage guard unions. |
| `src/integration-manifest.ts` | Integration manifest and egress authoring schemas. |
| `src/canonicalize.ts` | Deterministic canonical JSON and lowercase SHA-256 hashing. |
| `src/transforms/` | `x-id-strategy`, `x-normalize`, `x-computed` handling. |
| `src/validate.ts`, `src/ajv.ts` | Shared AJV 2020 validation and tagged errors. |

## Rules

- Every schema is TypeBox; every validated type is derived with `Static<>`. Never hand-write both.
- `definitionSchema()` rejects plain JSON Schema literals. Do not defeat that with casts.
- Optional fields use `Type.Optional(...)`; never hand-write `required` arrays.
- Use `Type.Unsafe<T>` only for shapes TypeBox cannot express; derive `T` from the same constants.
- For enum wire shape, prefer `Type.Unsafe<T>({ type: "string", enum: [...] })`; `Type.Union`
  emits `anyOf`, which is a different contract.
- `src/definitions/__schemas__/` are Vitest file snapshots, not build output. Never hand-edit;
  edit TypeBox source, run `pnpm --filter @tulipfarm/schema test -u`, then review the diff.
- Any schema snapshot diff is a compatibility event for existing Soul repos and recorded digests.
- Consumers must derive Soul paths, companions, bundle membership, and temporal class from
  `ARTIFACT_LAYOUTS`; never copy it into regexes or parallel tables.
- Optional Run event fields must be omitted, never `undefined`; schemas reject extras.
- Run events pair by id (`callId`), not stream position; readers must not guess call/approval order.
- Secret-bearing fields must use `secretReferenceSchema` or `SECRET_REFERENCE_PATTERN`.
- Invocation gateways must compile `INVOCATION_REQUEST_SCHEMAS` and deny unregistered refs.
- `applyTransforms` order is `x-id-strategy` -> `x-normalize` -> `x-computed`; normalizer and
  computed keys are closed sets and must be added beside their implementation maps.
- Call `validateResourceSchema()` when loading resource schemas; AJV `strict: false` will not reject
  unknown `x-*` keys or functions for you.
