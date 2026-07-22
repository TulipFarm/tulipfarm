# `src/a2ui` — declarative generative-UI compiler

Server-side A2UI: the agent emits a **declarative component spec** (via the `render_surface` tool); this
module compiles it to `tf-*` HTML that renders in the existing hardened sandboxed iframe
(`apps/web/app/lib/a2ui`). Adopting the A2UI v0.9 contract gives the LLM a structured, validatable,
data-bindable surface format instead of raw HTML — while keeping the CSP/DOMPurify isolation.

## Files

- **`spec.ts`** — the agent-facing contract: `A2uiSpec` (`{ root }`), the `A2uiNode` union (Card, Row,
  Column, Grid, Heading, Text, Badge, Alert, Button, MetricCard, List, DetailView, DataTable, BarChart,
  LineChart, Form), `A2uiValue` (literal **or** `{ path }` binding), `A2uiAction`, and `A2UI_SPEC_SCHEMA`
  (loose JSON Schema for the tool; the compiler is the structural authority).
- **`catalog.ts`** — `A2UI_CATALOG`: one render fn per component → `tf-*` HTML matching the canonical
  component contract (`apps/web/app/lib/a2ui/components.ts`). Output stays within the sanitizer allowlist
  (`tf-*` + `data-`/`aria-`; form fields use `data-name`). Buttons/forms serialize an `action` to
  `data-a2ui-send` (same postback channel `present_choices` uses).
- **`compiler.ts`** — `compileSurface(spec, dataModel) → { html, nodeIds, nodes }`: walks the tree,
  resolves `{ path }` bindings server-side (server-authoritative binding engine), HTML-escapes every
  value (`esc` is null-safe so a loose spec degrades, never throws), and stamps each node with
  `data-a2ui-id`. `nodes` carries every node's `outerHTML` + a `leaf` flag — the live-update diff unit.
- **`surface-store.ts`** — `A2uiSurfaceStore` (Pg + memory over `a2ui_surfaces`): per-`(conversation,
  surfaceId)` spec + data model, so `update_surface` can load + diff a surface rendered earlier.
- **`escape.ts`** — shared, null-safe `esc` / `sendAttr`.

## Flow

`render_surface` → `chat/a2ui-surface.ts` `a2uiEventsForToolResult` → `compileSurface` → producer emits
an `a2ui` `{ op: "createSurface", … }` SSE event (and persists the surface to the store) → web reducer
pushes an `a2ui` part → `<A2uiFrame>` renders it. **Live update:** `update_surface` (data-model patch) →
load the stored surface → recompile → diff the changed **leaf** fragments → emit
`{ op: "updateDataModel", surfaceId, fragments }` → the reducer stashes the fragments on the part → the
iframe runtime swaps them by `data-a2ui-id` in place (no rebuild). Legacy view tools still emit `{ html }`.

## Status

Phases 1 (declarative contract + render pipeline), 2 (HITL suspend/resume via `ask_user` +
`chat/pending-interactions.ts` + greenfield baseline), 3 (frontend tools —
`platform/frontend-tools.ts`), and
the **live-ops layer** (`update_surface` + `surface-store.ts` + the leaf-diff in `chat/a2ui-surface.ts`)
are built and tested. Containers (Card/Row/Column/Grid) carry no bound props, so a binding change always
lands on a leaf — swapping that leaf updates its ancestors' DOM too, which is why only leaves are diffed.
