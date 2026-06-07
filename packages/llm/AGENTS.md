# LLM — Agent Conventions

`@tulipfarm/llm` — provider-agnostic LLM access with tiered fallback chains, wrapping the
Vercel AI SDK (`ai` + `@ai-sdk/*`). Implements `specs/LLM-STRATEGY.md`. See root `AGENTS.md`
for commands/lint.

## Public API (`src/index.ts`)

- **`LlmService`** — entry point: `init`, `getModel`, `getModelById`, `select(req)`.
- **`createModel(entry, secrets)`** — builds one `LanguageModelV1` from a `ProviderEntry`.
- **`FallbackModel`** + **`isHardFailure()`** — the fallback chain (itself a `LanguageModelV1`).
- **`resolveTier(ctx)`** — deterministic auto-tier selection.
- **`validateLlmConfig()`** + errors `LlmConfigValidationError` / `LlmNotConfiguredError` /
  `UnknownModelError`.
- Types: `LlmConfig`, `ProviderEntry`, `TierConfig`, `Tier`, `SelectRequest`, `Autonomy`,
  `ModelSelector`, `SelectionContext`, `FallbackLogger`.

## File map

| File | Role |
| --- | --- |
| `config.ts` | TypeBox schema + `validateLlmConfig`. 3 tiers (`quick`/`standard`/`complex`), ≥1 provider each. |
| `provider.ts` | `createModel` — routes on `entry.provider` → `@ai-sdk/anthropic` \| `openai` \| `openai-compatible`. |
| `selection.ts` | `resolveTier` — maps `autonomy` → tier, bumps `quick`→`standard` when tools are present. |
| `llm-service.ts` | `LlmService`; `select` precedence: per-request `sessionModel` → caller `model` → `"auto"`. |
| `fallback.ts` | `FallbackModel` tries providers in order; `isHardFailure` decides propagate vs. fall through. |

## How to extend

- **Add a provider:** add the `@ai-sdk/<x>` dep, then a case in `provider.ts`. Resolve the key
  from `entry.api_key_ref` — `env://VAR` reads `process.env`, otherwise `secrets.get(ref)`
  (`@tulipfarm/secrets`).
- **Tune fallback:** classify errors in `isHardFailure()` — auth / `404` / abort propagate
  immediately; `429` / `5xx` / timeout fall through to the next provider (logged via `FallbackLogger`).
- **Tier rules:** keep `resolveTier` pure and deterministic — it's covered by `selection.test.ts`.
- Config is validated (TypeBox → AJV) at `init`; never read partial/unvalidated config.

## Tests

Vitest, colocated `*.test.ts` (`config` / `provider` / `selection` / `llm-service` / `fallback`).
Use fake `LanguageModelV1` stubs; assert fallback order and hard-vs-transient handling.
