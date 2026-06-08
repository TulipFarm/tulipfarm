# context

System-prompt assembly for the chat turn. One pure function builds the agent system prompt from
durable stores every turn (specs/CONTEXT-ENGINE.md §1).

## `assembleSystemPrompt(ctx)` — `assemble.ts`

Pure, synchronous, no IO. The caller (`chat/routes.ts`) fetches every input from its store and
passes it resolved in `AssembleContext`; assembly only renders. Keeping inputs resolved (not
lazily fetched) makes the rendered prefix deterministic and therefore prompt-cacheable.

### Block order (fixed)

```
<platform-instructions>   omit when skipPlatformPrompt or no text
<agent-identity>          agentId / domain / tenantId lines
<agent-personality>       AGENT.md body
<memory>                  per-user working memory, ≤ MAX_TOTAL_CHARS (drop whole on overflow)
<governance-knowledge>    alwaysLoadForAgents docs (reuses knowledge/governance.ts, 4k/16k caps)
<skills>                  "" — deferred (Skills v0.10)
<available-skills>        "" — deferred (Skills v0.10)
<soul-context>            "" — deferred (soul L1 snapshot builder)
<available-tools>         "" — deferred (Tools v0.8)
```

Each block renders to a string or `""`. Empty blocks are **omitted entirely** (filtered before
the `\n` join), matching `buildGovernanceBlock`'s precedent — so the prefix stays byte-identical
across turns when soul/memory don't change. No `<harness-typed-state>` block is ever emitted
(deferred MEM-V1-005).

## Why deterministic order matters

The Anthropic prompt cache keys on the longest byte-identical prefix. A fixed block order +
deterministic per-block rendering = cache hits across turns = lower cost/latency. Budgeted blocks
drop **whole** on overflow (never half-rendered) so the prefix can't drift mid-block.

## Acceptance criteria

- **AC-V1-001** two consecutive turns with no soul/memory change → byte-identical cacheable prefix.
- **AC-V1-003** no typed-state block in the assembled prompt.

## Tests

`assemble.test.ts` — pure unit coverage (order, determinism, skip, omit-empty, budgets,
no-typed-state). The wiring is covered in `chat/routes.test.ts` ("prepends the assembled system
prompt carrying working memory").
