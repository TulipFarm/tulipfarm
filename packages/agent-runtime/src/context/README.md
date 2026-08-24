# context

System-prompt assembly for the chat turn. One pure function builds the agent system prompt.

## `assembleSystemPrompt(ctx)` — `assemble.ts`

Pure, synchronous, no IO. It renders two blocks and nothing else:

```
<platform-instructions>   built-in law; overridable, omitted only when skipPlatformPrompt
<agent-personality>       AGENT.md body
```

Each block renders to a string or `""`, and an empty block is omitted entirely (filtered before the
`\n` join), so the prompt stays byte-identical across turns when the Agent does not change.

## Why there is nothing else here

Everything that used to render as a block — the business manifest, Memory, governance pages, the
Skill index, eager Skill bodies, the Soul catalogue, pinned Knowledge, tagged Resource schemas, the
Tool index, the Surface catalog, the clock — is now reached through a Tool.

A prompt block and a Tool answer the same question, but only one of them can be wrong. A block is
assembled once at turn start and then cannot change, so it goes stale the moment the turn acts on
it: `<available-tools>` lied as soon as `narrowToolsToSkill` shrank the real set mid-Turn (see
`../loop/narrowing.ts`), and `<current-context>` dated a Turn from its first instant. A block is
also paid for on every turn whether or not the Agent needed it. A Tool is paid for when it is
called and answers as of when it is called.

Tools reach the model as native declarations on the provider's `tools` parameter (`toToolSet` in
`@tulipfarm/model-adapter`), which carries each `inputSchema` a prompt never could.

Retired fields are not silently dropped. `AssembleContext` no longer accepts them, and the eval
Corpus loader refuses a Case that sets one (`RETIRED_CONTEXT` in `apps/eval/src/corpus.ts`) —
because a fact left in a retired field still reads as given to the model while the assembler
ignores it.

## Also exported from here

- `formatTemporalContext` / `TemporalContext` — the `get_current_time` platform Tool answers with
  this text. It lives here because the format is the contract, not because a block renders it.
- `MAX_CUSTOM_INSTRUCTIONS_CHARS` — the storage cap the API and web settings screen enforce on
  user-authored standing instructions. Those instructions no longer render as a prompt block.
- `PLATFORM_INSTRUCTIONS_TEXT` — the built-in law, exported so a caller can inspect or override it.

## Tests

`assemble.test.ts` — order, determinism, skip, omit-empty, and a `RETIRED` list asserting that none
of the removed tags can render again.
