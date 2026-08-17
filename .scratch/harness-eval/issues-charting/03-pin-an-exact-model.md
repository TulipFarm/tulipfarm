# Pin an exact model for a whole eval run

Type: research
Status: resolved
Blocked by: —

## Question

How does an eval force **one exact model** for every turn in a run, defeating every mechanism the
harness normally uses to choose one?

The harness deliberately does *not* let a caller pick a model. `selectModelProfile()`
(`packages/agent-runtime/src/models/profile.ts`) is documented as "the only product
model-selection path", Effort routing (`fast`/`balanced`/deep, plus `auto` with a classifier) picks
a profile, and `chainModel(ids)` in `packages/llm` must execute a **whole fallback chain** — the
package rules explicitly forbid collapsing fallback to the head.

Every one of those is a threat to attribution: if a case silently falls back from Sonnet to a
cheaper model on a 429, the score is garbage and nothing tells you.

Answer concretely, with file paths and the exact call shape:

1. What is the least invasive way to pin provider + model for an entire eval run? Options to
   assess: an eval-specific `soul.yaml#llm` config in the fixture Soul declaring exactly one
   provider entry and one profile; injecting a custom `ModelPort` that wraps a directly-built
   `LanguageModelV4` from `packages/llm/src/provider.ts` and bypasses `LlmService` entirely; or a
   pinned `profileId` fed through `chainModelFor([modelId], principal)`.
2. **Effort routing.** Can Effort be forced so `auto` never fires the classifier? What does the
   loop do if `EffortClassifierPort` is absent? Charting noted the worker injects it — confirm
   what happens when nothing does.
3. **Fallback.** How is a chain of length one expressed, and does anything reject it? If a
   pinned model errors, the eval must **fail the case loudly**, never silently substitute. Say how
   that is achieved without violating the "execute the whole chain" rule.
4. **Determinism knobs.** Does the `ModelPort` / `LanguageModelV4` path expose temperature, top-p
   or seed? Where would an eval set them? Report what is reachable, not what would be nice.
5. **Keys.** Trace `resolveApiKey()` in `packages/llm/src/provider.ts`. Exactly which env var
   names does an `env://VAR` ref need for anthropic and openai, and does anything require the
   `secrets` store to be initialised even when using `env://`?
6. **Prompt caching.** Does `decidePromptCache` fire on this path, and would it change results
   between runs (i.e. is a cached run scoring differently from a cold one)?

Read `packages/llm/src/llm-service.ts`, `src/provider.ts`, `src/model-spec.ts`,
`src/fallback.ts`, `src/prompt-cache.ts`, `packages/agent-runtime/src/models/`, and
`packages/agent-runtime/src/loop/contract.ts`.

The answer is a recommended pinning mechanism with the exact code shape, plus a list of every
place non-determinism or silent substitution can still enter.

## Answer

**Pin by injecting a custom `ModelPort` that wraps one directly-built `LanguageModelV4`.**
`AgentLoop` only ever sees `ModelPort` (`packages/agent-runtime/src/ports/model.ts:116-120`,
`src/loop/contract.ts:110-116`), so this bypasses `selectModelProfile()`, Effort routing and
`LlmService` in one move. The two alternatives both leak: a fixture `soul.yaml#llm` still runs
profile selection, which can pick among profile fallbacks
(`packages/agent-runtime/src/models/profile.ts:138-191`); and `chainModelFor([modelId], principal)`
takes **model** ids, not profile ids, and only applies after selection has already happened
(`packages/llm/src/llm-service.ts:219-237`).

```ts
const model = await createModel(
  { provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "env://ANTHROPIC_API_KEY" },
  secrets
);
const port: ModelPort = { invoke: (request) => /* wrap model.doGenerate */, stream: undefined };
```

**Effort can be pinned.** `route()` returns `options.pinned` immediately, so `auto` never reaches
the classifier (`packages/agent-runtime/src/models/effort-router.ts:99-107`). With no classifier
injected, `unsure` falls back to `balanced` with `usedClassifier: false` (`:117-122`) — deterministic,
but pin it explicitly rather than relying on that.

**A one-model chain is legal and fails loudly.** Nothing rejects a single-element array;
`chainModel()` returns the model directly when `built.length === 1`
(`packages/llm/src/llm-service.ts:231-235`). With one entry, a hard error rethrows immediately and
a transient error exhausts the chain and rethrows the last error
(`packages/llm/src/fallback.ts:31-37, 80-83`). Hard = `AbortError`, `LlmProviderError`,
`LoadAPIKeyError`, non-retryable `APICallError`. Transient = 429, 5xx, retryable AI SDK errors.

**Keys.** `resolveApiKey()` strips `env://` and reads `process.env[VAR]` verbatim
(`packages/llm/src/provider.ts:19-29`); no secrets store is touched on that branch. Repo convention
is `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. `.env.example`'s `LLM_API_KEY` is bootstrap seeding only
and is **not** an `env://` target.

### Two findings that change other tickets

**1. There is no temperature, top-p or seed knob anywhere on this path.**
`ModelInvocationRequest` carries only `requestId`, `modelProfileId`, messages, tools,
`outputSchema`, `maxOutputTokens`, `policy`, `principal`, `agentId`
(`packages/agent-runtime/src/ports/model.ts:8-34`), and `createModel()` takes only a
`ProviderEntry` plus secrets/timeout/principal/credentials/log (`packages/llm/src/provider.ts:85-105`).
So the eval **cannot run at temperature 0 today**. This was an open assumption in
[Measure the noise floor](12-noise-floor.md); it is now a known constraint, and it spawned
[Decide whether ModelPort gets sampling controls](14-sampling-controls.md).

**2. `decidePromptCache()` is never called on the `AgentLoop`/`ModelPort` seam.**
No invocation exists in `agent-runtime` or `llm-service`. `cacheAllowed` is
`primary.allowCaching && !requirements.sensitive` from profile selection
(`packages/agent-runtime/src/models/profile.ts:184-190`), and `undefined` means no profile decided,
so caching is skipped (`packages/llm/src/prompt-cache.ts:37-50`). Caching is therefore **not** a
confound today — and equally, the map's hoped-for "prompt caching could cut the L2 bill" saving is
**not available for free** on this path.

### Non-determinism inventory

Everything that can still move a pinned run, in rough order of danger:

- **Provider-side sampling.** Unavoidable today — no knob exists (see finding 1). This is the
  dominant term and the reason the noise floor must be measured before any gate.
- **Principal credential fallback.** If a principal has no usable credential, `principalModel()`
  silently falls back to the shared deployment credential for the same model
  (`packages/llm/src/provider.ts:73-79`, `llm-service.ts:239-273`). Silent, and it changes which
  account and rate-limit bucket serves the request.
- **Fallback substitution** — only if a chain longer than one is ever built. Keep it at one.
- **Effort classifier variance** — only if a classifier is injected and `route()` hits `unsure`.
  Pinning Effort removes this.
- **Streaming commit point.** In fallback streaming the first chunk commits the model, so upstream
  timing can shift the success/failure boundary (`packages/llm/src/fallback.ts:85-131`). Prefer
  non-streaming for eval.
- **`LlmService.init()` config drift** — can skip providers or disable LLMs outright on differing
  config/credentials (`llm-service.ts:64-116`). Avoided entirely by the recommended approach.
- **Env drift.** `env://VAR` hard-fails on a missing var, which is at least loud.
