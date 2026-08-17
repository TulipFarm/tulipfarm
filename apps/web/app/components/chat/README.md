# Layer-1 chat UI

The product's primary surface (route `/`, `_app._index.tsx`): streaming Chat with native trusted
Tulip Surface Protocol React components. Components are hand-authored (shadcn-style, modeled on AI
SDK Elements) and fed by the custom fetch-SSE client in `app/lib/chat/` — **not** the Vercel `ai` SDK.

## Data flow

```
POST /api/v1/chat ─SSE→ lib/chat/sse-client.ts (parse frames → ChatEvent)
                          → lib/chat/reducer.ts  (fold events → ordered TimelinePart[])
                          → lib/chat/use-chat-stream.ts (hook: messages, status, send, approve)
                          → chat-panel.tsx → transcript.tsx → parts.tsx (+ approval-card)
```

`chat-panel.tsx` owns the hook and switches the empty state (welcome + Suggested prompts) to the live
transcript on first send. `composer.tsx` is a **Tiptap rich-text editor** (see below) + model selector,
with **no attachment affordance** (no blob storage in V1). User messages render as markdown in their own
bubble (`transcript.tsx` → `MarkdownView`), so formatting + the literal mention tokens show.

The composer uses the design-system interaction language precisely: a **Suggested prompt** drafts
editable text and never sends on selection; an **Action** is explicitly started by the person; an
**Auto action** is Agent-started work operating within configured authority. Adaptive onboarding
items are Suggested prompts and sit directly below the prompt surface.

Normal Chat uses the default harness and does not label it as an Agent. The Agent indicator appears
only when a user-created Agent is explicitly selected or takes over the Chat. Product identity,
business identity, and Agent identity are separate UI layers and must not reuse the TulipFarm name.

## Composer editor (`composer.tsx` + `editor/`)

A Tiptap (`@tiptap/*` v3) editor replacing the old textarea. It supports markdown formatting
(bold/italic/code/link via Cmd shortcuts + a selection `BubbleMenu`) and four mention triggers, each a
separately-named ProseMirror node with its own suggestion `pluginKey`:

| Trigger | Menu source | On send |
|---|---|---|
| `@agent` | `listAgents()` | first one → POST `agentId` (routes the turn; overrides the panel's active agent) |
| `/skill` | `listSkills()` | POST `skills: string[]` — eagerly injected into the agent's context for the turn |
| `#resource` | `listResourceTypes()` | POST `resources: string[]` — type schema injected for the turn |
| `~knowledge` | `searchKnowledge(query)` (async, per keystroke) | POST `knowledgePages: string[]` (pageIds) — full page content pinned into `<pinned-knowledge>` for the turn |

`editor/serialize.ts` is the pure, DOM-free core (unit-tested): `serializeDoc(editor.getJSON())` →
`{ text (markdown, mentions as literal `@/ / /# / ~` tokens), agentId, skills, resources, knowledge }`; link hrefs are
scheme-sanitized. Its block walk is **recursive** — pasted rich text nests blocks inside blocks
(`bulletList > listItem > paragraph`, `blockquote > paragraph`), so lists, quotes, fenced code and
rules round-trip to markdown and mentions buried in a list item still route the turn. A flat walk
silently sent only the top-level paragraphs. `editor/mentions.ts` builds the extensions + portals the `editor/mention-list.tsx`
dropdown via `ReactRenderer` (no tippy, mirrors `model-selector.tsx` positioning); `editor/use-mention-data.ts`
fetches the agent/skill/resource lists once (the `~knowledge` menu is server-searched per keystroke instead).
Enter sends (deferred to the suggestion menu while one is open); Shift+Enter
newlines. The backend eager-injection lives in `apps/api/src/chat/turn.ts` (`buildSystemFor`) +
`packages/agent-runtime/src/context/assemble.ts` (`<skills>` + `<eager-resources>` + `<pinned-knowledge>` blocks); the tags are ephemeral per turn.
Note: ProseMirror can't be driven under jsdom — the editor's behavior is covered by `serialize.test.ts`
(pure) + a mocked `composer.test.tsx`; the live flow is Playwright-verified.

## Persistence & history

Conversations persist server-side (UUID id, auto-created on the first turn). On that first turn the API
generates a **title** from the message via the `fast` effort preset (async, non-blocking — see
`apps/api/src/chat/title.ts`). The shell holds the list in `lib/conversations-context.tsx`
(`GET /api/v1/chats`, refetched on route change + on each turn via `onConversationChange`), which
`app-sidebar.tsx` renders below a clickable **Chats** header (the entry point to the `/chats` browse
page — there is no standalone "Chat" nav item). Clicking a row opens `/chat/:id` (`_app.chat.$id.tsx`),
whose loader fetches the conversation + messages and rehydrates the timeline via `lib/chat/hydrate.ts`
(`messagesToTimeline`) so `useChatStream({ initialMessages })` seeds a sealed transcript; follow-up turns
reuse the same id. "+ new chat" links back to `/`. The **Chats** page (`_app.chats.tsx`) lists every chat
with server-side title search (`?q=`), and a three-dots menu to **star** (pin) or **rename** a chat
inline (`PUT /api/v1/chats/:id` → `renameConversation` / `setConversationStarred`).

## Component → event

| Component | Driven by |
|---|---|
| `parts.tsx` Response (text) | `text` (live) |
| `tool-call.tsx` + `json-view.tsx` + `approval-card.tsx` | `tool-call`/`tool-result` + `approval-request`/`approval-resolved` (live) |
| `tool-call.tsx` `<ToolRun>` via `timeline-groups.ts` | groups consecutive Tool rows into one block, folding a long settled run; emits no events of its own |
| `parts.tsx` sources | `sources` (live) and restored conversations via `lib/chat/hydrate.ts` |
| `parts.tsx` reasoning / plan / task / agent-handoff / surface (`<SurfaceFrame>`) | **contract-only** — typed + rendered now, light up when the backend emits. No participant-audience event in `RUN_EVENT_TYPES` produces them today; `/design-guide` tags these specimens `contract-only` so they are not mistaken for shipped behaviour. |
| `model-selector.tsx` | sets POST `model` to an Effort Preset id — Auto/Fast/Balanced/Thorough in a portalled dropdown with signal-bar intensity icons. Auto is visible as the default path: the system balances effort, latency, and cost unless the participant deliberately overrides it. Fast, Balanced, and Thorough explain the tradeoff directly; the picker does not list provider model names because `GET /api/v1/llm-config` exposes legacy provider chains, not a per-preset display contract. |
| `autonomy-control.tsx` | sets POST `autonomy`; `approval-required` arms the live tool-approval gate |

## Tool calls (`tool-call.tsx`, `json-view.tsx`, `tool-summary.ts`)

A Tool row is the transcript's execution record, so it has to answer four questions on one line:
which kind of Tool ran, what it did, how long it took, and how it ended.

- **Collapsed:** a tier-tinted glyph (family chosen from the Tool's name by `toolFamily`), a human
  summary in verb-object form from `describeToolCall`, the Tool name in mono, a duration, and a
  status glyph. A `mutating` Tool carries a labelled write marker. A running row shows an
  indeterminate rail (`.run-rail-active`) rather than a decorative pulsing dot, because the motion
  reports live state.
- **Expanded:** separate **Input** and **Output** panes, each with its own copy control. The earlier
  row printed the same JSON twice and left the reader to guess which was which.
- **Metadata strip:** tier, agent, `callId`, and `argsDigest`, all copyable and in mono.

An attached approval renders outside the collapse, because it needs the reader to act.

### Grouping a run (`timeline-groups.ts`)

A turn that ran nine lookups should read as one block, not nine free-floating cards.
`groupTimelineParts` gathers **consecutive** Tool rows into a single `tool-run` node, which
`ToolRun` draws as one bordered container with `divide-y` rows. Grouping is unconditional: a run is
always one block, so the transcript never becomes a stack of identical boxes.

Folding is the separate decision. A run collapses to one `Ran N tools` line only when it is
`foldable`: at least `MIN_CLUSTER_SIZE` (3) members, and every member finished, successful, and
unattended. Anything that still wants attention keeps the whole run open:

| Never folded | Why |
|---|---|
| still running | it is happening now |
| awaiting an approval | it is an ask, not a record |
| failed | the error is the evidence |
| the trailing part while streaming | folding the live edge makes a turn look finished before it is |

Below three rows nothing folds — collapsing two costs a click and saves nothing. A failure does not
split the run; it keeps the run open, so `ok ok ok · error` renders as one block with four visible
rows. The folded line's green check is only ever as strong as the rows it hides: `isFoldable`
mirrors the row's own `runStateOf`, so a call that would show a check standalone is the only kind
that can be folded under one.

Rows hidden by `isHiddenToolPart` (`cite_sources`, successful presentation Tools) are dropped before
grouping, so they cannot split a run that should read as one.

### What a participant may see

The verbatim arguments never cross the participant boundary. The wire carries two things instead:

| Field | Meaning |
|---|---|
| `argsDigest` | Hash of the verbatim arguments. Stays the authority after redaction and truncation. |
| `argsPreview` / `resultPreview` | A `ToolPreview`: `{ json, redactedPaths?, truncated?, bytes? }`, already redacted and already bounded server-side. |

The preview is built at the dispatch boundary in `apps/worker/src/turn/tool-preview.ts`, which is
the only place that holds both the arguments and the authority to decide what a channel may see. The
agent-loop projection is not widened. Redaction works **by subtraction**: it walks the whole value
and removes credential material, so an unanticipated field is included by default while an
unanticipated secret is still caught.

The client never un-redacts. A withheld leaf renders as an explicit `••••••` chip tagged `redacted`,
and `PreviewNotice` names how many fields were withheld and how much was truncated. A reader who
cannot see a field is owed the difference between "withheld" and "absent".

A restored conversation is different: persisted messages carry the verbatim `args` and `result`, so
the same panes render full fidelity without a preview. On a live stream `args` holds only
`{ argsDigest }`, which is a receipt rather than an argument — it is shown in the metadata strip and
never rendered as an Input pane.

`json-view.tsx` replaces a regex highlighter that painted tokens with hardcoded palette classes. It
is collapsible, auto-collapses below depth 2 so a large payload opens as an outline, and takes every
colour from the `--code-*` token family so both themes work without a second set of rules.

### Why there is no "Load full"

An authorized inspect endpoint was considered and deliberately not built. Verbatim Tool arguments are
persisted **nowhere**: the operator-audience `tool.dispatched` record carries only `callId`, `name`,
`idempotencyKey`, `intentId`, `effect` and `outcome`, and no table stores arguments. An endpoint
would therefore have nothing to return that the preview does not already carry, and giving it
something would mean persisting secret-bearing arguments — a new retention, redaction-at-rest and
audit surface that contradicts the standing invariant that verbatim arguments never reach a reader.
No dead affordance is shipped in the UI.

## Run vocabulary tokens

Execution state is a different axis from content status and never borrows its tones:

- `--run-pending|active|ok|error|blocked|skipped` plus `--run-surface`, `--run-surface-hover`,
  `--run-border`, `--run-rail` — what a Run did.
- `--status-*` — what a Record is. Never substituted for the above.
- `--tool-tier-system|platform|integration`, `--tool-mutating` — which layer a Tool belongs to.
- `--code-*` — the inspect surface.
- `--data-1..8` — categorical encoding only; never chrome, status, or brand.

Live specimens of every state live at `/design-guide` under **Agent run vocabulary**.

## Try harder

Completed assistant replies that carry the model receipt can show a quiet **Try harder** action beside
that receipt. It replays the user turn that produced that reply as a new Turn, leaving the original
assistant Message in place for comparison. The replay uses the same `runStream` path as regenerate,
so it mints a fresh idempotency key and sends the same per-turn context (`agentId`, Skills,
Resources, and Knowledge pages) with only `model` changed to the next Effort Preset.

The escalation ladder is one step: Fast → Balanced → Thorough. Auto is not itself a ladder rung;
backend `resolveEffortPreset` anchors Auto on the declared default, which this UI treats as Balanced,
so Try harder from Auto targets Thorough. Thorough has no higher preset, so no action is rendered.
The affordance is user-driven only and is hidden while any turn is streaming.

## Approval round-trip (live)

Set the composer mode to **Approval** → a mutating tool suspends server-side and emits `approval-request`
→ `ApprovalCard` shows Approve/Deny + a countdown → the click POSTs `/api/v1/chat/approvals/:id/decide`
→ the stream resumes (runs the tool, or returns a denial the model sees). A denial is shown via
`approval.status` (the `approval-resolved` outcome), distinct from a genuine tool failure.

## Testing

Component tests fold synthetic `ChatEvent`s through the **real reducer** (no network); see
`transcript.test.tsx`, `composer.test.tsx`, `approval-card.test.tsx`. The live end-to-end round-trip is
covered in `apps/api/src/chat/routes.test.ts`.
