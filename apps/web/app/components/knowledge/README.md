# Knowledge wiki (web)

Notion/Confluence-style wiki over OKF spaces. One unified **space → page** tree (no
documents/collections tabs); pages are markdown, edited with the shared `@tulipfarm/editor`
(TipTap, markdown in/out). The backend (`apps/api/src/knowledge`) is the source of truth.

## Model (UI ↔ OKF)

- **Space** = an OKF space. Top-level tree node.
- **Page** = a page at a `path` within a space; children = pages/dirs under `<path>/`.
- A page is a **container** simply by having children — the tree merges a page `a.md` and a
  sibling dir `a/` into ONE node that is clickable (its body) AND expandable (its children).
- **Front page** = the space's root `index.md` override (authored or synthesized contents).
- Zero new DB: spaces/pages/front page reuse `createSpace` / `writePage(id, path|"index", …)`
  / `navigateSpace`. Cross-links / #tags / `log.md` history are later phases.

## Data + pure logic (`app/lib/`)

- `knowledge-api.ts` — typed client (spaces CRUD, `writePage`, `navigateSpace`,
  `listSpacePages`, graph, zip export/import).
- `okf-listing.ts` — pure `parseListing` / `mergeEntries` (the merge rule) / `listingToNodes` /
  `rewriteOkfLinks` (relative `.md` links → SPA routes). Unit-tested.
- `rehype-callouts.ts` — renders `> [!NOTE]` blockquotes as callouts in `MarkdownView`.

## Components (this dir)

- `space-tree` — the forest rail: spaces → lazy pages (merge rule), active highlight, inline `[+]`
  create, refreshes on the `okf:space-changed` window event a write dispatches.
- `page-form` — guided (frontmatter fields + `<PageEditor>` WYSIWYG body) / **raw** OKF escape
  hatch. Submits `{ path, content }`.
- `page-detail` — read view (`MarkdownView`, callout-aware).
- `space-form` — space name/description/domain.
- `space-graph` — d3-force cross-link graph (content-pane route).
- `space-delete-dialog` — names the Space and counts its Pages before deleting it.

## Routes (`app/routes/_app.knowledge.*`)

`_app.knowledge.tsx` = the wiki **shell**: persistent `<KnowledgeTree/>` rail + content `<Outlet/>`;
the main app sidebar auto-collapses here (wired in `_app.tsx` via `forceCollapsed`). `_index` =
welcome pane. `spaces.$id` = thin context provider (no chrome); its `_index` = front page;
`pages.$` = page read; `pages.new` (accepts `?parent=` / `?path=index`) + `pages.edit.$`
= edit via `<PageEditor>`; `spaces.$id.graph` = graph; `spaces.new` / `spaces.$id.edit` = space
create / settings.

## Tests

Pure logic in `@tulipfarm/editor` (markdown round-trip, callout, slash filter) + `app/lib/
okf-listing.test.ts` + `markdown-view.test.tsx` (callouts). The tree/shell/editor are verified
end-to-end via Playwright. Run: `pnpm --filter @tulipfarm/web test knowledge`.
