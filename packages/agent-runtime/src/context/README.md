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

## The Soul reminder — `soul-reminder.ts`

The one exception to the rule below, and it is not a system-prompt block. It is a `user` message
rebuilt every Turn, carrying what the Agent would otherwise have to guess at or spend Tool calls
discovering:

```
<system-reminder>
  <business-details>            soul.yaml — name, description, website
  <soul>
    <available-skills>          name: description
    <available-agents>
    <available-resources>
    <available-routines>
    <available-integrations>
  <user-memory>                 the Memory Document, Markdown, whole
  <custom-instructions>         the user's own standing instructions
</system-reminder>
```

It exists because "reach it through a Tool" has one failure mode a Tool cannot fix: an Agent that
does not know a Skill exists never calls `skill_list` to discover it, so the capability stays
invisible until the participant happens to name it. The same holds for a person — an Agent that
does not know Memory has anything in it opens a conversation as a stranger.

`<soul>` holds only what the Soul repo defines. The business, Memory and standing instructions are
facts about the world the Agent works in rather than artifacts it can load, extend or call, so they
sit alongside it. The business comes first because every other block reads differently once you
know whose business it is.

Three functions, all pure:

- `filterSoulCatalogue(catalogue, layers, now)` — narrows to what this Turn's subject may reach,
  through `decideEffectivePermission`, using the actions the owning Tool families declare
  (`SOUL_REMINDER_SECTIONS`). The artifact name travels as `recordId`, so a grant scoped with
  `recordSelector` can hide exactly one Agent. The business is gated separately on
  `soul.business_profile.read`, with no `recordId` — it names no artifact to scope against.
  No layers denies everything.
- `filterSoulPersonal(personal, layers, now)` — gates both personal blocks on
  `memory.document.read`, the single action `get_memory` already returns them both under.
- `renderSoulReminder(catalogue, personal)` — renders every block, always. An empty one says
  `(none)` rather than being omitted, because an Agent reads an absent block as "unknown" and
  resolves unknown with the very Tool call this message exists to save.

Authored text is the one part an attacker chooses, so all of it is sanitized. Names and
descriptions are stripped of angle brackets *and* newlines and capped (`line`). Memory and
instructions keep their newlines — the Memory Document's heading and one-fact-per-line grammar is
load-bearing, and `update_memory`'s `remove` matches those lines verbatim — so `blockText` strips
only the angle brackets that could close a tag and continue as the platform.

### Why this does not reintroduce what was retired

`<business-context>`, `<memory>` and `<custom-instructions>` are all on the `RETIRED` list in
`assemble.test.ts`, and that list still holds: `assembleSystemPrompt` renders exactly two blocks
and none of these. The retirement argument was staleness, and it is answered per block, not waved
away:

| Block | Can it go stale mid-Turn? |
| --- | --- |
| `<business-details>`, the five catalogue sections | No. They change only when the Soul is written, which is a durable event. || `<custom-instructions>` | No. Changed only from the settings screen, never mid-Turn. |
| `<user-memory>` | **Yes** — `update_memory` is a Tool the Agent can call during the Turn. |

Memory is admitted anyway, because the Agent that staled it is the one that wrote it and therefore
knows the delta, and because carrying the document is what makes `remove`'s verbatim matching
usable at all. `get_memory` remains the way to re-read it as of now.

The catalogue arrives as a structural shape, not `SoulCatalogue`: this package may not import
`@tulipfarm/soul`. `apps/api/src/soul/reminder.ts` composes the pieces, resolves the subject
layer, reads `soulLoader.manifest`, Memory and instructions, and is shared by the Turn resolver and
`/chats/:id/debug-context` so the debug view cannot drift from what was sent.
`apps/api/src/internal/turn-context.ts` registers the result as a `skill_instructions` Context
candidate so it is budgeted, digested and dropped whole like every other source.

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

The Soul reminder is admitted against that argument, not exempt from it: a name list cannot go
stale mid-Turn the way a narrowed Tool set or a clock can, and it buys the one thing a Tool cannot
— knowing that there is something worth calling a Tool about.

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
  user-authored standing instructions, and the cap `renderSoulReminder` applies to the
  `<custom-instructions>` block. Those instructions do not render as a *prompt* block.
- `PLATFORM_INSTRUCTIONS_TEXT` — the built-in law, exported so a caller can inspect or override it.

## Tests

`assemble.test.ts` — order, determinism, skip, omit-empty, and a `RETIRED` list asserting that none
of the removed tags can render again. The Soul reminder does not reintroduce a retired tag: it is
a message, not a system-prompt block, and `assembleSystemPrompt` still renders exactly two blocks.

`soul-reminder.test.ts` — authorization narrowing (scoped deny, scoped allow, layer intersection,
expiry, no layers), the singleton gates for the business and the personal blocks, rendering, the
`(none)` marker, sanitising of both the one-line and the multi-line kind, truncation, and
determinism.
