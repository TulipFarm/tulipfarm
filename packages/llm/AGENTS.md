# LLM — Agent Conventions

`@tulipfarm/llm` — provider-agnostic LLM access with fallback chains, wrapping the
Vercel AI SDK (`ai` + `@ai-sdk/*`). See root `AGENTS.md`
for commands/lint.

**This package no longer selects models.** Routing is decided by `selectModelProfile`
(`@tulipfarm/agent-runtime`) over a ModelProfile catalog; this package builds providers and runs
the chain it is handed. The tier primitive and its autonomy-to-capability map are retired — that
map gave a `full`-autonomy Run the *weakest* model, coupling oversight to capability backwards.
`tiers` survives only as the shape `llm.config` is still authored in, and
`@tulipfarm/schema`'s `model-catalog.ts` derives ModelProfiles from it.

## Public API (`src/index.ts`)

- **`LlmService`** — entry point: `init`, `effortModel(preset)`, `chainModel(ids)`,
  `getModelById`, `hasModelId`, `specFor`.
- **`createModel(entry, secrets)`** — builds one `LanguageModelV4` from a `ProviderEntry`.
- **`FallbackModel`** + **`isHardFailure()`** — the fallback chain (itself a `LanguageModelV4`).
- Types: `ResolvedModelEntry`, `FallbackLogger`.

> Config schemas/validators + LLM error classes (`LlmConfig`, `ProviderEntry`, `TierConfig`,
> `validateLlmConfig`, `LlmConfigValidationError`, `LlmNotConfiguredError`, `UnknownModelError`,
> `LlmCredentialError`, `EmbeddingUnavailableError`) live in `@tulipfarm/schema` — import them
> from there, not from here.

## File map

| File | Role |
| --- | --- |
| `provider.ts` | `createModel` — routes on `entry.provider` → `@ai-sdk/anthropic` \| `openai` \| `openai-compatible`. |
| `llm-service.ts` | `LlmService`; `effortModel` resolves an effort preset through the derived ModelProfile catalog, `chainModel` runs a chain the router already chose. |
| `fallback.ts` | `FallbackModel` tries providers in order; `isHardFailure` decides propagate vs. fall through. |

## How to extend

- **Add an API-keyed provider:** add the `@ai-sdk/<x>` dep, then a case in `provider.ts`. Resolve
  the key from `entry.api_key_ref` — `env://VAR` reads `process.env`, otherwise `secrets.get(ref)`
  (`@tulipfarm/secrets`).
- **Add a Subscription Provider** (a coding-agent CLI run as the model against a personal
  subscription instead of an API key — `claude-code`, `codex`): implement `CliLanguageModel`
  (`src/cli/base.ts`) — it owns the `LanguageModelV4` plumbing (`doGenerate`/`doStream`, timeout,
  abort, usage), the subclass only supplies a `runTurn` async generator. Reuse `src/cli/jail.ts`
  (HOME jail + env allowlist), `src/cli/transcript.ts` (prompt → replayed text; skip it if the CLI
  accepts structured history, as Codex does), and `src/cli/structured.ts` (JSON-mode emulation).
  Register a static `ModelSpec` in `src/cli/specs.ts` — these models never resolve against the
  LiteLLM catalog, so `validateRoutingCapacity` (`apps/api/src/soul/llm-config/routes.ts`) needs
  this fallback to get a `max_input_tokens`. Add the provider id to
  `packages/secrets/src/registry.ts`'s `LlmProviderId` + `LLM_PROVIDERS` (reuse `role: "api_key"`
  for the single credential field), then a case in `provider.ts`. Seven things are easy to get
  wrong and all are covered by tests — read them before writing a third one:
  - **Reject a bad credential as a hard failure.** Throw `LlmProviderError`
    (`"model_authentication_failed"`), or `isHardFailure` stays false and one expired token burns
    the entire fallback chain. Read whatever structured status the CLI carries *before* its prose:
    both vendors report auth failures behind retry-flavoured messages.
  - **Never sum usage.** Both CLIs report running totals, not deltas.
  - **Check whether the vendor's input count already includes cached tokens — they disagree.**
    Anthropic's `input_tokens` *excludes* `cache_read_input_tokens`; Codex's `input_tokens`
    *includes* `cached_input_tokens` (it emits a separate `non_cached_input_tokens` to prove it).
    Adding the cached figure to the input figure is correct for one vendor and double-counts for
    the other, inflating every budget and metric downstream. Report the cache read as a breakdown
    of the total, never as an addend.
  - **Pass no vendor credential through the jail's env allowlist.** An ambient `ANTHROPIC_API_KEY`
    or `OPENAI_API_KEY` on the host lets the CLI answer on the *operator's metered account* while
    the turn is still reported as unpriced. The saved subscription credential is the only one that
    may reach the child.
  - **A timed-out turn must throw, not finish.** If the abort is allowed to surface as a normal
    `stop`, a truncated turn is indistinguishable from a complete one and the fallback chain never
    engages. `CliLanguageModel` handles this — do not bypass it.
  - **Externalize the package in the `Dockerfile`** and depend on it from `apps/api/package.json`,
    or the native binary is pruned from the deploy closure and only fails at the first chat turn.
  - **Ship no ambient capability.** A Subscription Provider is a *model*: the CLI's own shell, file
    tools, and web access must be turned off, or a turn reaches past the Tool Broker.

  See `docs/plans/cli-agent-providers.md`; `claude-code.ts` (in-process SDK) and `codex.ts` (JSON-RPC
  to a subprocess) are the two worked examples.
- **Tune fallback:** classify errors in `isHardFailure()` — auth / `404` / abort propagate
  immediately; `429` / `5xx` / timeout fall through to the next provider (logged via `FallbackLogger`).
- **Do not add a second selector here.** A capability decision belongs in `selectModelProfile`,
  where the constraints, the denial reasons, and the routing evidence live. `chainModel` exists so
  the whole selected chain executes — a chain collapsed to its head is not a fallback chain, which
  is the bug this arrangement replaced.
- Config is validated (TypeBox → AJV, via `@tulipfarm/schema`) at `init`; never read partial/unvalidated config.

## Tests

Vitest, colocated `*.test.ts` (`provider` / `llm-service` / `fallback`).
Use fake `LanguageModelV4` stubs; assert fallback order and hard-vs-transient handling.
