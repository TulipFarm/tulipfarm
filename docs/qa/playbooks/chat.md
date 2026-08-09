---
id: chat
area: Chat
suites: [smoke, full]
routes: ["/", /chats, "/chat/:id"]
preconditions: [signed-in session, LLM provider configured]
blast_radius: creates chats titled/containing qa-<run-id>-*; never deletes chats it did not create
est_minutes: 12
smoke_scenarios: [S1, S2, S7]
---

# Chat

Chat is the product's primary surface (route `/`). Streaming SSE transcript, Tiptap composer with
four mention triggers, effort presets, autonomy/approval gate, and chat history at `/chats`.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Empty state and first send

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` | Chat panel renders. Welcome/empty state visible, not a transcript |
| 2 | `expect` a **Suggested prompts** group is present | Present, labeled |
| 3 | `click` a suggested prompt | It **drafts editable text into the composer and does not send** — this is a design-system rule, sending on selection is a P1 finding |
| 4 | Clear the composer | Composer empty |
| 5 | `type` composer `qa-<run-id> reply with a one-sentence hello` | Text appears in the editor |
| 6 | `click` `Send prompt` (or press Enter) | User message bubble appears immediately |
| 7 | `expect` `Stop response` replaces `Send prompt` while streaming | Streaming affordance shown |
| 8 | `expect` the first token arrives within 10s of send | Record the elapsed time; over budget is a P2 perf finding |
| 9 | `wait-until` streaming stops (max 60s) | Assistant response non-empty; no error banner |
| 10 | `expect` the URL is now a `/chat/:id` deep link, or the chat appears in the sidebar Recent list | Chat persisted |
| 11 | `capture` screenshot, console delta, failed requests | — |

**Assert on shape, not wording.** Empty response, error banner, or never-settling stream are the
failures — not what the model said.

## S2 — Streaming controls

| # | Action | Expected |
| --- | --- | --- |
| 1 | Send `qa-<run-id> write a long numbered list of 20 items` | Streaming starts |
| 2 | `click` `Stop response` mid-stream | Streaming halts within ~2s; partial text retained, not discarded |
| 3 | `expect` composer returns to `Send prompt` and is usable | Recovered |
| 4 | Send a follow-up message | Accepted; conversation continues in the same chat |
| 5 | `expect` no console error was produced by the abort | Clean |

Silent failure to stop, a stuck `Stop response` button, or a discarded partial response are P1.

## S3 — Composer editor

Tiptap rich text. Markdown formatting plus keyboard behavior.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Select text in the composer | A selection bubble menu appears with bold / italic / code / link |
| 2 | Apply bold, italic, and inline code | Formatting renders in the composer |
| 3 | Insert a link, then `expect` a `javascript:` scheme is rejected or sanitized | Scheme sanitization holds — a live `javascript:` href is **P0** |
| 4 | Press `Shift+Enter` | Newline inserted, message **not** sent |
| 5 | Press `Enter` | Message sends |
| 6 | `expect` the sent user bubble renders markdown (bold/italic/code visible, mention tokens literal) | Renders |

## S4 — Mention triggers

Four triggers, each with its own menu. All four are checked even if the underlying list is empty —
an empty menu must show an empty state, not a broken dropdown.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Type `@` in the composer | Agent menu opens, listing agents or an empty state |
| 2 | Press `Enter` while the menu is open | Selects the highlighted item; **does not send the message** |
| 3 | Type `/` | Skill menu opens |
| 4 | Type `#` | Resource-type menu opens |
| 5 | Type `~` then a query | Knowledge menu opens and searches per keystroke (server-side, async) |
| 6 | `expect` each menu shows a loading state while fetching and an empty state when there are no matches | Both present |
| 7 | Insert one mention of any available type and send | Message sends; the mention renders as a literal token in the user bubble |
| 8 | `wait-until` streaming stops (max 60s) | Response acknowledges the mentioned context in some form |
| 9 | Press `Escape` with a menu open | Menu closes; composer keeps focus and text |

Enter sending the message while a suggestion menu is open is a P1 — deferral to the menu is the
documented behavior.

## S5 — Effort presets and Try harder

The picker exposes **Auto / Fast / Balanced / Thorough**. It must never list provider model names.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open the effort selector | Dropdown shows exactly Auto, Fast, Balanced, Thorough with intensity icons |
| 2 | `expect` **Auto** is the default and each option explains its tradeoff | Present |
| 3 | `expect` no provider model name (e.g. a `claude-*` / `gpt-*` string) appears in the picker | Absent — a model name here is a P2 |
| 4 | Select `Fast` and send `qa-<run-id> ping` | Completes |
| 5 | `wait-until` the reply finishes; inspect its receipt metadata | A Model ID may appear **only** as receipt metadata on the finished reply |
| 6 | `expect` a quiet **Try harder** action beside the receipt | Present for Fast/Balanced/Auto |
| 7 | `click` `Try harder` | A new turn is created; the original assistant message **remains in place** for comparison |
| 8 | Set the preset to `Thorough` and finish a reply | **No** Try harder action is rendered (no higher rung) |
| 9 | `expect` Try harder is hidden while any turn is streaming | Hidden |

## S6 — Autonomy and approval round-trip

| # | Action | Expected |
| --- | --- | --- |
| 1 | Set the composer autonomy mode to **Approval** | Mode reflected in the UI |
| 2 | Send a prompt that requires a mutating tool, e.g. `qa-<run-id> create a resource type called qa-<run-id>-approval-probe` | Turn starts |
| 3 | `wait-until` an approval card appears (max 60s) | Approve / Deny actions plus a countdown are shown |
| 4 | `click` `Deny` | Stream resumes; outcome is shown as a **denial**, visually distinct from a tool failure |
| 5 | Repeat and `click` `Approve` | Stream resumes and the tool runs |
| 6 | `expect` the countdown is readable and the card is keyboard-reachable | Accessible |
| 7 | `note` the created artifact so the operator can clean it up | Recorded |

An approval card that never resolves, or a denial rendered as an error, are P1.

## S7 — Chat history at `/chats`

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /chats` | Heading `Your chats`; list renders or shows an empty state |
| 2 | `type` `search chats` with `qa-<run-id>` | List filters to matching chats |
| 3 | `expect` a no-results query shows an empty state, not a blank panel | Empty state present |
| 4 | `click` `Chat actions` on a chat this run created | Menu opens |
| 5 | `click` `Rename chat`, set `qa-<run-id>-renamed`, submit | Title updates in the list **and** in the sidebar Recent list without a reload |
| 6 | Star the chat | Star state persists across a reload; `starred` control is labeled |
| 7 | `click` a chat row | Navigates to `/chat/:id`; full transcript rehydrates in order |
| 8 | Reload `/chat/:id` directly | Transcript rehydrates from the deep link; follow-up turns reuse the same chat id |
| 9 | Delete a chat **this run created** | Removed from list and sidebar; no console error |

Never rename, star, or delete a chat the run did not create.

## S8 — Debug drawer and surfaces

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open the chat debug drawer | Opens; shows turn/stream detail |
| 2 | `expect` no secret, API key, or raw credential is displayed | Any leaked secret is **P0** |
| 3 | Close the drawer | Focus returns to the composer; drawer uses `inert` rather than `aria-hidden` |
| 4 | If a reply rendered a Surface artifact, `expect` it renders inside the trusted frame without layout overflow | Renders |

## S9 — Getting-started card

| # | Action | Expected |
| --- | --- | --- |
| 1 | If the getting-started checklist is visible, dismiss it | Card disappears |
| 2 | `click` `+ new chat` | Chat panel remounts — the dismissed card **does not reappear** |
| 3 | Reload the page | Dismissal persists |

## S10 — Resilience, a11y, and themes

| # | Action | Expected |
| --- | --- | --- |
| 1 | Send an empty message | Send is blocked or a validation message appears; no request fired |
| 2 | Send a very long message (~5000 chars) | Handled: sends, or a clear limit message. No silent truncation and no crash |
| 3 | Tab through the composer, effort selector, and autonomy control | Every control reachable with a visible focus ring |
| 4 | `expect` icon-only controls have accessible names | `Send prompt`, `Stop response`, etc. present |
| 5 | Toggle to the other theme and re-check `/` and `/chats` | Text legible, no invisible or clipped elements in either theme |
| 6 | Resize to 375px width | Composer and transcript usable; nothing overflows horizontally |
| 7 | `capture` console delta and failed requests for the whole playbook | — |

## Notes for the runner

- Any state this playbook needs must be reachable through Chat or the UI. If it is not, that is a
  product gap and gets filed as a finding — never work around it by writing to `soul/` directly.
- Chat is nondeterministic. Judge intent, not wording. A prompt asking for a resource that produces
  no resource is a P1; a differently-phrased greeting is not a finding.
