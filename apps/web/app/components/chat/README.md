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

Both `composer.tsx` and `transcript.tsx` are **code-split**. Tiptap/ProseMirror and the markdown
renderer are the two heaviest chunks in the app and sat on the landing route's critical path, where —
because a SPA-mode `clientLoader` lives inside its route module — they delayed the first API call.
`composer.tsx` is a thin lazy wrapper whose fallback is a *working* plain-text box, not a skeleton;
the real editor lives in `composer-editor.tsx` and is tested directly as `composer-editor.test.tsx`.
`chat-panel.tsx` warms the transcript chunk on mount, and `_app.chat.$id`'s `clientLoader` warms it
alongside its data fetch, so neither surface waits on a discovery round trip. Tests that assert on
composer or transcript output must use `findBy*`, not `getBy*`.

The composer uses the design-system interaction language precisely: a **Suggested prompt** drafts
editable text and never sends on selection; an **Action** is explicitly started by the person; an
**Auto action** is Agent-started work operating within configured authority. Adaptive onboarding
items are Suggested prompts and sit directly below the prompt surface.

Normal Chat uses the default harness and does not label it as an Agent. The Agent indicator appears
only when a user-created Agent is explicitly selected or takes over the Chat. Product identity,
business identity, and Agent identity are separate UI layers and must not reuse the TulipFarm name.

## Composer editor (`composer-editor.tsx` + `editor/`)

A Tiptap (`@tiptap/*` v3) editor replacing the old textarea. It supports markdown formatting
(bold/italic/code/link via Cmd shortcuts + a selection `BubbleMenu`) and four mention triggers, each a
separately-named ProseMirror node with its own suggestion `pluginKey`:

| Trigger | Menu source | On send |
|---|---|---|
| `@agent` | `listAgents()` | first one → POST `agentId` (routes the turn; overrides the panel's active agent) |
| `/skill` | `listSkills()` | POST `skills: string[]` — named in the turn's `<participant-pinned>` block |
| `#resource` | `listResourceTypes()` | POST `resources: string[]` — named in the turn's `<participant-pinned>` block |
| `~knowledge` | `searchKnowledge(query)` (async, per keystroke) | POST `knowledgePages: string[]` (pageIds) — named in the turn's `<participant-pinned>` block |

A pin **points, it does not grant.** The three lists are narrowed against the Soul reminder's
already-authority-filtered catalogue and then named back to the agent, which opens what it needs
with the matching tool. A pinned skill an agent's `capabilityRestrictions.skills` forbids never
reaches the block, and would still be refused at dispatch if it did. No pin injects content.

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
(pure) + a mocked `composer-editor.test.tsx`; the live flow is Playwright-verified.

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

**Rename and delete** are reachable from three places, all sharing
`chat/chat-title-actions.tsx` — `ChatTitleInput`, `ChatActionsMenu`, `DeleteChatModal`, the
`useChatTitleActions` state machine, and `ChatCrumbTitle` itself: the Chats page rows, the sidebar's
Recent chats rows, and the open chat's name in the top bar. All three go through `renameChat` /
`removeChat` on `conversations-context.tsx`, so one edit updates every surface without a refetch, and
deleting the chat on screen routes back to `/`. Keep the state machine in the hook — the three
surfaces each kept their own copy once and the copies drifted.
Titles are capped at `CHAT_TITLE_MAX_LENGTH` from `@tulipfarm/schema/chat` (the subpath, never the
barrel — see `scripts/client-bundle-safety.test.ts`) — the same ceiling `PUT /api/v1/chats/:id`
enforces, so the field can never submit something the API will reject.
`DELETE /api/v1/chats/:id` answers 409 while a Turn is pending or running; that message is surfaced
verbatim **inside** the confirm dialog, because `<dialog>.showModal()` makes everything behind it
inert. `ChatActionsMenu` owns its own hover reveal and stays visible at a 44px target below `sm`;
callers pass positioning only, or the actions vanish on touch.

A rename issued from the top bar can race the async titler, so `buildAndStoreTitle` writes through
`setTitleIfUnset` — it names an untitled chat and loses to anything the user typed.

## Component → event

| Component | Driven by |
|---|---|
| `parts.tsx` Response (text) | `text` (live) |
| `tool-inspector.tsx` + `json-view.tsx` + `approval-card.tsx` | `tool-call`/`tool-result` + `approval-request`/`approval-resolved` (live) |
| `tool-trace.tsx` `<ToolTrace>` via `timeline-groups.ts` | groups consecutive Tool rows into one `tool-run` node and draws it — live and sealed alike; emits no events of its own |
| `parts.tsx` sources | `sources` (live) and restored conversations via `lib/chat/hydrate.ts` |
| `parts.tsx` reasoning / plan / task / agent-handoff / surface (`<SurfaceFrame>`) | **contract-only** — typed + rendered now, light up when the backend emits. No participant-audience event in `RUN_EVENT_TYPES` produces them today; `/design-guide` tags these specimens `contract-only` so they are not mistaken for shipped behaviour. |
| `model-selector.tsx` | sets POST `model` to an Effort Preset id — Auto/Fast/Balanced/Thorough in a portalled dropdown with signal-bar intensity icons. Auto is visible as the default path: the system balances effort, latency, and cost unless the participant deliberately overrides it. Fast, Balanced, and Thorough explain the tradeoff directly; the picker does not list provider model names because `GET /api/v1/llm-config` exposes legacy provider chains, not a per-preset display contract. |
| `autonomy-control.tsx` | sets POST `autonomy`; `approval-required` arms the live tool-approval gate |

## Tool calls (`tool-trace.tsx`, `tool-inspector.tsx`, `json-view.tsx`, `tool-summary.ts`)

**A run of Tool calls has one presentation: the Trace.** `ToolTrace` draws it — a rail, no border,
a present-tense header while the work is live, a `Ran N tools` header once it is over. It replaced
a bordered record that said the same things inside a box, which made every reply that touched a
Tool open with a slab of chrome above the answer the reader actually asked for.

There is no bordered record left, in any state. An **approval** is the one thing the trace does
not hide: `ApprovalCard` renders as a sibling *between* the steps, always visible, and its run is
never `foldable`. A question the reader has to click to find is a question they will miss.

It is a step on the rail, not a card — no border, no fill. In a surface where nothing else is
filled, the primary `Approve` button is the loudest thing on screen without any help. Once the
decision lands the card collapses to one settled line (`Approved` / `Denied` / `Expired without a
decision`); a denial is toned `run-blocked`, because it is a decision and not a fault.

A step has to answer four questions on one line: which Tool ran, what it did, how long it took, and
how it ended.

- **Collapsed:** a status glyph, a human summary in verb-object form from `describeToolCall`, the
  Tool name in a mono chip, and — for a `mutating` Tool — a labelled write marker, because write
  capability is a standing property of the Tool and should not hide behind a disclosure.
- **Expanded:** the one-line facts (error code, result hint, duration) and then `ToolInspector` —
  separate **Input** and **Output** panes with their own copy controls, plus the metadata strip
  (tier, agent, `callId`, `argsDigest`). The earlier row printed the same JSON twice and left the
  reader to guess which was which.
- A step with nothing to report stays silent and non-expandable rather than offering a chevron onto
  an empty panel.

### The rail is the vocabulary for all narration, not just Tools

`parts.tsx` renders plans, single tasks, cited sources, agent handoffs and guardrail refusals in
the same vocabulary: a glyph, a line of text, no border, no fill, no radius. Sources are rows
(`TraceSource`), never a grid of cards — a citation is a footnote, and a footnote that outweighs
its sentence is a design error.

A **guardrail** is the sharpest case. Boxing a refusal would make it outrank the approval ask,
which is the most important interruption in the product and wears no box at all. So it earns its
weight from tone (`run-blocked`) and a `font-medium` "Blocked", nothing more.

The one exception is a **verbatim payload** inside a disclosure the reader opened on purpose
(`ToolInspector`, `json-view`): that block is evidence, not narration, and its border says "this is
quoted, not written". `parts.test.tsx` locks the rule — every narration part is asserted to carry
no `border-run-border` and no bordered radius.

### Grouping a run (`timeline-groups.ts`)

A turn that ran nine lookups should read as one block, not nine free-floating cards.
`groupTimelineParts` gathers **consecutive** Tool rows into a single `tool-run` node. Grouping is
unconditional: a run is always one node, so the transcript never becomes a stack of identical
blocks.

Folding is the separate decision, and the Trace takes it from the same `foldable` flag the record
used (`keepOpen={!foldable}`). A run collapses to one `Ran N tools` line when it has at least
`MIN_CLUSTER_SIZE` (3) members, every member has finished, and none is holding an approval:

| Never folded | Why |
|---|---|
| still running | it is happening now |
| awaiting an approval | it is an ask, not a record, and an ask hidden behind a click strands the reader |
| the trailing part while streaming | folding the live edge makes a turn look finished before it is |
| fewer than three steps | collapsing two costs a click and saves nothing |

**A failure folds, but it is never silent.** The header reads `Ran 4 tools · 1 failed` and swaps its
glyph for an error-toned `AlertTriangle`, so folding costs the reader a click and never the fact.
The count is the whole licence for folding one: without it a green `Ran 4 tools` over a failure
would be a lie. Open the run and the failed step is already expanded onto its error code, because
`TraceStep` holds an `error` step open on its own.

That count is why it is a *string* rather than a tinted fragment. Splitting it into two nodes made
the accessible name come out `Ran 4 tools· 1 failed`, since `dom-accessibility-api` trims each
child's contribution before joining. Tone belongs on the glyph, not inside the sentence.

A failure does not split the run; it stays one Trace. The folded line's check is only ever as strong
as the steps it hides: `isFoldable` refuses anything unfinished or awaiting a decision, so the
header can always describe what is underneath it.

Rows hidden by `isHiddenToolPart` (`cite_sources`, **all** presentation Tools) are dropped before
grouping, so they cannot split a run that should read as one.

A live transcript and a restored one can group the same Turn differently, and that is expected. A
persisted reply stores its text as one string and its calls as a flat `metadata.toolCalls` with no
positions, so `hydrate.ts` can only lay the run out as all tools then all text. A Turn that live
read as `Ran 3 tools` → text → two more calls comes back as one five-row block.

### Presentation Tools never draw a step

`present`, `update_presentation` and `request_input` are how the assistant *draws the answer*.
Naming them as steps tells the reader the assistant called a tool to do the one thing they can
already see it doing, and a failure among them is a rendering fault, not work the reader can act
on. `isPresentationToolPart` hides them in every outcome — success, failure, in flight.

While one is in flight the grouping pass emits a `surface-building` node instead, and the transcript
renders a `LoadingState` labelled `Rendering`. That is the honest report: something is being drawn,
and it is not a step in the reader's errand.

### Narrating a live run (`tool-trace.tsx`)

The unit of work is **the Turn, not the call**. Gating narration on a call being mid-flight does not
work here: a platform Tool returns in ~20ms, shorter than one frame, and the reducer applies
`tool-call` and `tool-result` in the same synchronous batch, so `running` frequently never paints.
Between calls the model round-trip takes seconds during which every part is `done`. Narrating only
those windows handed the reader a finished-looking column while the Turn was visibly still working.

`describeToolCallActive` in `tool-summary.ts` supplies the present-tense label by swapping the
leading verb through a closed map. It returns `undefined` for any word this module did not write —
a server-supplied summary is never conjugated — and the step falls back to its past-tense label.

`transcript.tsx` no longer chooses a presentation. Every `tool-run` node is a `ToolTrace` — live,
sealed, failed, or holding a decision.

`pending` marks the run as the **live edge** — the last node in the message, with nothing after it
yet. It decides two things:

| `pending` | The run reads as | Why |
|---|---|---|
| `true`, a call in flight | header names that call, its step expanded | the work has a name |
| `true`, nothing in flight | a trailing `Thinking` step under the finished ones | the Turn is still working; a column of ticks would read as done |
| `false` | folded to `Ran N tools`, if `foldable` | something followed it, so the work it describes is over |

The trailing `Thinking` step is the answer to the gap this surface used to have: a platform Tool
returns in ~20ms, so between calls the reader saw only finished ticks for seconds and the next
result appeared already ticked.

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
`transcript.test.tsx`, `composer-editor.test.tsx`, `approval-card.test.tsx`. The live end-to-end round-trip is
covered in `apps/api/src/chat/routes.test.ts`.

## A run folds at two calls

`MIN_CLUSTER_SIZE` in `timeline-groups.ts` is **2**. The boundary is where the fold header starts
saying more than the rows it replaces: `Ran 2 tools` is a summary; `Ran 1 tool` is strictly less
information than the one row it would hide. `timeline-groups.test.ts` asserts both sides with
literals — the older tests derive their sizes from the constant and so pass at any value.

## A restored reply can be text-free

A Turn that only ran Tools, or that stopped to ask a question, persists with `content: ""`; the
Message exists to carry `metadata.toolCalls` and its Surface link. `assistantParts` in
`app/lib/chat/hydrate.ts` drops empty text rather than emitting a blank paragraph above the run.
