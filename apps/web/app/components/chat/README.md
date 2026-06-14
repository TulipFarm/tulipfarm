# Layer-1 chat UI

The product's primary surface (route `/`, `_app._index.tsx`): a streaming chat rendered **outside** the
A2UI iframe, terminal-native per `DESIGN.md`. Components are hand-authored (shadcn-style, modeled on AI
SDK Elements) and fed by the custom fetch-SSE client in `app/lib/chat/` — **not** the Vercel `ai` SDK.

## Data flow

```
POST /api/v1/chat ─SSE→ lib/chat/sse-client.ts (parse frames → ChatEvent)
                          → lib/chat/reducer.ts  (fold events → ordered TimelinePart[])
                          → lib/chat/use-chat-stream.ts (hook: messages, status, send, approve)
                          → chat-panel.tsx → transcript.tsx → parts.tsx (+ approval-card)
```

`chat-panel.tsx` owns the hook and switches the empty state (welcome + suggestion chips) to the live
transcript on first send. `composer.tsx` is a **Tiptap rich-text editor** (see below) + model selector,
with **no attachment affordance** (no blob storage in V1). User messages render as markdown in their own
bubble (`transcript.tsx` → `MarkdownView`), so formatting + the literal mention tokens show.

## Composer editor (`composer.tsx` + `editor/`)

A Tiptap (`@tiptap/*` v3) editor replacing the old textarea. It supports markdown formatting
(bold/italic/code/link via Cmd shortcuts + a selection `BubbleMenu`) and three mention triggers, each a
separately-named ProseMirror node with its own suggestion `pluginKey`:

| Trigger | Menu source | On send |
|---|---|---|
| `@agent` | `listAgents()` | first one → POST `agentId` (routes the turn; overrides the panel's active agent) |
| `/skill` | `listSkills()` | POST `skills: string[]` — eagerly injected into the agent's context for the turn |
| `#resource` | `listResourceTypes()` | POST `resources: string[]` — type schema injected for the turn |

`editor/serialize.ts` is the pure, DOM-free core (unit-tested): `serializeDoc(editor.getJSON())` →
`{ text (markdown, mentions as literal `@/ / /#` tokens), agentId, skills, resources }`; link hrefs are
scheme-sanitized. `editor/mentions.ts` builds the extensions + portals the `editor/mention-list.tsx`
dropdown via `ReactRenderer` (no tippy, mirrors `model-selector.tsx` positioning); `editor/use-mention-data.ts`
fetches the three lists once. Enter sends (deferred to the suggestion menu while one is open); Shift+Enter
newlines. The backend eager-injection lives in `apps/api/src/chat/routes.ts` (`buildSystemFor`) +
`apps/api/src/context/assemble.ts` (`<skills>` + `<eager-resources>` blocks); the tags are ephemeral per turn.
Note: ProseMirror can't be driven under jsdom — the editor's behavior is covered by `serialize.test.ts`
(pure) + a mocked `composer.test.tsx`; the live flow is Playwright-verified.

## Persistence & history

Conversations persist server-side (UUID id, auto-created on the first turn). On that first turn the API
generates a **title** from the message via the quick LLM tier (async, non-blocking — see
`apps/api/src/chat/title.ts`). The shell holds the list in `lib/conversations-context.tsx`
(`GET /api/v1/conversations`, refetched on route change + on each turn via `onConversationChange`), which
`app-sidebar.tsx` renders below a clickable **Chats** header (the entry point to the `/chats` browse
page — there is no standalone "Chat" nav item). Clicking a row opens `/chat/:id` (`_app.chat.$id.tsx`),
whose loader fetches the conversation + messages and rehydrates the timeline via `lib/chat/hydrate.ts`
(`messagesToTimeline`) so `useChatStream({ initialMessages })` seeds a sealed transcript; follow-up turns
reuse the same id. "+ new chat" links back to `/`. The **Chats** page (`_app.chats.tsx`) lists every chat
with server-side title search (`?q=`), and a three-dots menu to **star** (pin) or **rename** a chat
inline (`PUT /api/v1/conversations/:id` → `renameConversation` / `setConversationStarred`).

## Component → event

| Component | Driven by |
|---|---|
| `parts.tsx` Response (text) | `text` (live) |
| `parts.tsx` tool block + `approval-card.tsx` | `tool-call`/`tool-result` + `approval-request`/`approval-resolved` (live) |
| `parts.tsx` reasoning / plan / task / sources / agent-handoff / a2ui (`<A2uiFrame>`) | **contract-only** — typed + rendered now, light up when the backend emits |
| `model-selector.tsx` | sets POST `model` — a portalled dropdown over quick/standard/complex (signal-bar intensity icons); each option explains the tier (line 1) and lists its configured models (line 2, from `GET /api/v1/llm-config`) |
| `autonomy-control.tsx` | sets POST `autonomy`; `approval-required` arms the live tool-approval gate |

## Approval round-trip (live)

Set the composer mode to **Approval** → a mutating tool suspends server-side and emits `approval-request`
→ `ApprovalCard` shows Approve/Deny + a countdown → the click POSTs `/api/v1/chat/approvals/:id/decide`
→ the stream resumes (runs the tool, or returns a denial the model sees). A denial is shown via
`approval.status` (the `approval-resolved` outcome), distinct from a genuine tool failure.

## Testing

Component tests fold synthetic `ChatEvent`s through the **real reducer** (no network); see
`transcript.test.tsx`, `composer.test.tsx`, `approval-card.test.tsx`. The live end-to-end round-trip is
covered in `apps/api/src/chat/routes.test.ts`.
