# LLM (`@tulipfarm/llm`)

Provider-agnostic LLM and embedding access over the Vercel AI SDK, with fallback chains and
subscription-CLI model adapters.

## Read on / Skip
- **Read on if** you change provider build, fallback, embeddings, pricing, or CLI models.
- **Skip if** you change model selection or config schemas; read `../agent-runtime/AGENTS.md` or
  `../schema/AGENTS.md` instead.

## Map
| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/provider.ts` | Builds one `LanguageModelV4` from a configured provider entry. |
| `src/llm-service.ts` | Service init, model lookup, effort/profile resolution, chain execution. |
| `src/fallback.ts`, `src/provider-error.ts` | Fallback order and hard/transient failures. |
| `src/embeddings.ts`, `src/embedding-provider.ts` | Embedding providers and execution. |
| `src/model-spec.ts`, `src/pricing.ts` | Model metadata and cost helpers. |
| `src/prompt-cache.ts` | Whether a prompt prefix asks for provider-side caching. |
| `src/cli/` | Subscription Provider adapters, jail, transcripts, JSON mode, specs. |

## Rules
- This package does not select models; `selectModelProfile` in `@tulipfarm/agent-runtime` does.
- `tiers` remains only as authored LLM config shape; `@tulipfarm/schema` derives ModelProfiles.
- Import config schemas, validators, and LLM config/runtime error classes from `@tulipfarm/schema`.
- Config is validated at `LlmService.init`; never read partial or unvalidated config.
- Chain entries naming no provider or model are dropped at `init` with a warning, never fatal: an
  instance may still hold one from before the write gate rejected it, and failing the whole `llm:`
  block would take every working chain down with it and leave no page from which to delete it.
- `chainModel(ids)` must execute the whole selected chain; do not collapse fallback to the head.
- API-keyed providers read `entry.api_key_ref`: `env://VAR` from env, else `secrets.get(ref)`.
- Fallback hard failures propagate: auth, `404`, abort. `429`, `5xx`, timeout fall through.
- Bad Subscription Provider credentials throw `LlmProviderError("model_authentication_failed")`.
- CLI usage reports are running totals, not deltas; never sum them. A turn's totals come from the
  terminal `result` message where the CLI sends one: an `assistant` message carries the snapshot
  taken before the model wrote, so its output count is a placeholder, not an answer. Per-message
  snapshots remain the fallback for a turn cut short by a tool call, which never reaches a result.
- A Subscription Provider is addressed by an alias. Where the CLI names the model it resolved to,
  yield `model-version`; a caller otherwise cannot tell a vendor roll-forward from its own change.
- Embedding failover is width-scoped: a standby may answer only if it declares the *same*
  `dimension` as the active provider. A different width writes vectors the next query can never
  match, and nothing errors.
- Do not price inside this package's embedding path. `EmbeddingUsageSink` reports usage; the
  caller that holds the operator's overrides prices it, so there stays exactly one pricing site.
- No direct `console.*`: every notice goes through the injected `LlmLogger`/`EmbeddingLogger`, or
  it misses the log viewer and redaction.
- Cached input token semantics differ by vendor; report cache read as a breakdown, never an addend.
- Prompt caching is requested only through `decidePromptCache`, which fails closed: an absent
  `cacheAllowed` means no profile checked sensitivity, so it must never read as yes.
- Do not pass ambient vendor env credentials through the CLI jail; only saved credentials.
- Timed-out CLI turns must throw, not finish as a normal `stop`.
- Subscription Providers are models only: disable shell, file tools, web, and ambient capability.
- New CLI provider: implement `CliLanguageModel`, add a static `ModelSpec`, register provider id in
  `packages/secrets/src/registry.ts`, add `provider.ts` case, dependency, and Docker external.
