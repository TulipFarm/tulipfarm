# @tulipfarm/model-adapter

Translation between the `ModelPort` contract in `@tulipfarm/agent-runtime` and the Vercel AI SDK's
prompt, tool and usage shapes. Pure functions: no provider client, no credential, no I/O.

## Read on / Skip

**Read on** when you are changing how a `ModelInvocationRequest` becomes an SDK prompt, how an SDK
result becomes a `ModelOutput`, how tool calls or tool results are parsed, or how token counts are
folded into `ModelUsage`.

**Skip** for provider selection, credentials, retries, budgets or routing — those live in
`packages/llm` (client construction) and `apps/worker/src/model.ts` (routing, gates, watchdog).

## Map

| Path | Owns |
| --- | --- |
| `src/prompt.ts` | Request → SDK prompt (`splitPrompt`, `toToolSet`, `withCacheBreakpoint`, `stablePrefixChars`), SDK result → `ModelOutput` (`toOutput`, `parseToolCalls`, `parseToolResult`) |
| `src/usage.ts` | `UsageAccumulator` and `tokenDetail` — folding SDK usage into `ModelUsage` |

## Rules

- **Stay pure.** Anything that needs a credential, a network call or a clock belongs in a caller.
  Two hosts depend on this staying free of them: the Worker and `apps/eval`.
- **Cache and reasoning token counts are a breakdown, never an addend.** `cacheReadTokens`,
  `cacheWriteTokens` and `reasoningTokens` are already inside `inputTokens`/`outputTokens`. Adding
  them again double-counts spend.
- **Never price a call here.** `priceCall` in `@tulipfarm/llm` is the enforced sole authority on
  cost (`scripts/llm-pricing-authority.test.ts`).
