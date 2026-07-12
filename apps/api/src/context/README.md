# context

System-prompt assembly for the chat turn. One pure function builds the agent system prompt from
durable stores every turn (specs/CONTEXT-ENGINE.md §1).

## `assembleSystemPrompt(ctx)` — `assemble.ts`

Pure, synchronous, no IO. The caller (`chat/turn.ts`) fetches every input from its store and
passes it resolved in `AssembleContext`; assembly only renders. Keeping inputs resolved (not
lazily fetched) makes the rendered prefix deterministic and therefore prompt-cacheable.

### Block order (fixed)

```
<platform-instructions>   omit when skipPlatformPrompt or no text
<agent-identity>          agentId / domain / tenantId lines
<agent-personality>       AGENT.md body
<memory-instructions>     static preamble: apply preference facts (language/tone/tz) — renders only with <memory>
<memory>                  per-user working memory, ≤ MAX_TOTAL_CHARS (drop whole on overflow)
<governance-knowledge>    alwaysLoadForAgents docs (reuses knowledge/governance.ts, 4k/16k caps)
<skills>                  eager skill bodies — `## name` + body per `eager: true` skill, 32k cap, drop-whole
<available-skills>        lazy skill L1 — one `- name: description` per soul skill, 8k cap, drop-whole
<soul-context>            repo catalogue L1 — `## Agents/Skills/Resource Types/Routines/Integrations`, 16k cap, drop-whole
<available-tools>         tool L1 — one `- name: description` per allowed tool, 8k cap, drop-whole
```

Each block renders to a string or `""`. Empty blocks are **omitted entirely** (filtered before
the `\n` join), matching `buildGovernanceBlock`'s precedent — so the prefix stays byte-identical
across turns when soul/memory don't change. No `<harness-typed-state>` block is ever emitted
(deferred MEM-V1-005).

Both skill blocks are fed by the **SkillRegistry** (`../soul/skills/registry.ts`): `listEagerSkills`
projects skills with `eager: true` to their full `{ name, body }` for `<skills>`, and `listAvailableSkills`
projects the rest to their sorted L1 `{ name, description }` for `<available-skills>` — the two sets are
disjoint. A lazy skill's body (L2) and reference files (L3) load on demand via the `load_skill` /
`load_skill_reference` platform tools; per-agent eager-skill election stays deferred post-V1.

`<soul-context>` and `<available-tools>` give the agent **ambient awareness** without a tool
round-trip. `buildSoulCatalogue` (`../soul/catalogue.ts`) projects every soul artifact — agents
(via `listAgents`, platform agents included), the full skill set (eager + lazy), resource types,
routines, integrations — to a sorted `{ name, description }` L1 catalogue; full bodies/schemas stay
L2 (pulled via `agent_get` / `load_skill` / `resource_type_schema`). `<available-tools>` lists the
tools the agent may actually call, scoped to its allowlist by `availableToolsFor` in
`chat/turn-helpers.ts` (the same allowed set used to build the toolset, so the two can't drift).

## Why deterministic order matters

The Anthropic prompt cache keys on the longest byte-identical prefix. A fixed block order +
deterministic per-block rendering = cache hits across turns = lower cost/latency. Budgeted blocks
drop **whole** on overflow (never half-rendered) so the prefix can't drift mid-block.

## Acceptance criteria

- **AC-V1-001** two consecutive turns with no soul/memory change → byte-identical cacheable prefix.
- **AC-V1-003** no typed-state block in the assembled prompt.

## Tests

`assemble.test.ts` — pure unit coverage (order, determinism, skip, omit-empty, budgets,
no-typed-state, plus the `<soul-context>` and `<available-tools>` blocks). The catalogue projection
is covered in `../soul/catalogue.test.ts`, and the wiring in `chat/routes.test.ts` (working memory,
the lazy `<available-skills>` list, and the eager `<skills>` block).
