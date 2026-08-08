# context

System-prompt assembly for the chat turn. One pure function builds the agent system prompt from
durable stores every turn.

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
<current-context>         current date / day / time / timezone — renders LAST, no budget (see below)
```

Each block renders to a string or `""`. Empty blocks are **omitted entirely** (filtered before
the `\n` join), matching `buildGovernanceBlock`'s precedent — so the prefix stays byte-identical
across turns when soul/memory don't change. No `<harness-typed-state>` block is ever emitted
(deferred MEM-V1-005).

Both Skill blocks are fed by the **SkillRegistry** (`../soul/skills/registry.ts`), which merges the
read-only bundled tree with Soul overrides by name before projecting eager Skills to
`{ name, body }` and lazy Skills to their sorted L1 index. Bundled categories group the lazy index.
The sets are disjoint. A lazy Skill's body (L2) and reference files (L3) load on demand via the
`load_skill` / `load_skill_reference` platform Tools; per-Agent eager-Skill election stays deferred
post-V1.

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

## `<current-context>` — the one block that changes every turn

Without it an agent has no idea what *now* is, so "next Tuesday" or "is this overdue?" is answered
against the model's training cutoff — while `<memory-instructions>` already tells it to render
dates in the user's timezone.

Three rules keep it from costing anything the other blocks paid for:

- **It renders last.** Every block above stays byte-identical across turns, so a per-turn timestamp
  truncates the cacheable prefix instead of invalidating it.
- **The instant is passed in, never read from the clock here.** `assembleSystemPrompt` stays pure —
  the same `AssembleContext` renders the same prompt. Both callers already hold an injected
  `now: () => Date` (`ChatTurnContextResolver`, `BundleRoutineAgentPort`), which is also what makes
  the block testable at a fixed instant.
- **No char budget.** Output is two lines fixed by construction, unlike the list-shaped blocks. An
  `Invalid Date` omits the block rather than rendering as a fact about now.

Timezone comes from the user's free-text `timezone` working-memory entry, so anything can arrive;
`Intl` is the only real validator and an unusable value falls back to UTC rather than failing the
turn. `Intl` is broader than strict IANA — it resolves legacy abbreviations like `PST` — and those
are kept, since the rendered offset is explicit either way. A Routine's `agent` State has no
participant and therefore no preference to read, so it renders UTC.

`formatTemporalContext` is exported because the `get_current_time` platform Tool answers with the
same text: the block is a turn-start snapshot, and a fresh mid-loop reading that disagreed in format
would read as a different kind of fact. That Tool is chat-only — a Routine's `agent` State exposes
no Tools — which is why the block's own text never mentions it.

## Acceptance criteria

- Two consecutive turns with no soul/memory change → byte-identical cacheable prefix
  (everything above `<current-context>`, which carries the per-turn timestamp).
- No typed-state block in the assembled prompt.

## Tests

`assemble.test.ts` — pure unit coverage (order, determinism, skip, omit-empty, budgets,
no-typed-state, plus the `<soul-context>` and `<available-tools>` blocks). The catalogue projection
is covered in `../soul/catalogue.test.ts`, and the wiring in `chat/routes.test.ts` (working memory,
the lazy `<available-skills>` list, and the eager `<skills>` block).
