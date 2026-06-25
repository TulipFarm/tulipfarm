# Knowledge wiki (web)

Notion/Confluence-style wiki over OKF bundles. One unified **space → page** tree (no
documents/collections tabs); pages are markdown, edited with the shared `@tulipfarm/editor`
(TipTap, markdown in/out). The backend (`apps/api/src/knowledge`) is the source of truth.

## Model (UI ↔ OKF)

- **Space** = an OKF bundle (the word "bundle" is hidden in the UI). Top-level tree node.
- **Page** = a concept doc at a `path` within a space; children = docs/dirs under `<path>/`.
- A page is a **container** simply by having children — the tree merges a concept `a.md` and a
  sibling dir `a/` into ONE node that is clickable (its body) AND expandable (its children).
- **Front page** = the space's root `index.md` override (authored or synthesized contents).
- Zero new DB: spaces/pages/front page reuse `createBundle` / `writeConcept(id, path|"index", …)`
  / `navigateBundle`. Cross-links / #tags / `log.md` history are later phases.

## Data + pure logic (`app/lib/`)

- `knowledge-api.ts` — typed client (bundles CRUD, `writeConcept`, `navigateBundle`,
  `listBundleDocuments`, graph, zip export/import). Legacy doc/collection fns remain (agents use
  them) but have no UI.
- `okf-listing.ts` — pure `parseListing` / `mergeEntries` (the merge rule) / `listingToNodes` /
  `rewriteOkfLinks` (relative `.md` links → SPA routes). Unit-tested.
- `rehype-callouts.ts` — renders `> [!NOTE]` blockquotes as callouts in `MarkdownView`.

## Components (this dir)

- `space-tree` — the forest rail: spaces → lazy pages (merge rule), active highlight, inline `[+]`
  create, refreshes on the `okf:bundle-changed` window event a write dispatches.
- `concept-form` — guided (frontmatter fields + `<PageEditor>` WYSIWYG body) / **raw** OKF escape
  hatch. Submits `{ path, content }`.
- `concept-detail` — read view (`MarkdownView`, callout-aware).
- `bundle-form` — space name/description/domain.
- `bundle-graph` — d3-force cross-link graph (content-pane route).
- `bundle-list` — spaces card grid (the orphan `/knowledge/bundles` index; tree is the real nav).

## Routes (`app/routes/_app.knowledge.*`)

`_app.knowledge.tsx` = the wiki **shell**: persistent `<KnowledgeTree/>` rail + content `<Outlet/>`;
the main app sidebar auto-collapses here (wired in `_app.tsx` via `forceCollapsed`). `_index` =
welcome pane. `bundles.$id` = thin context provider (no chrome); its `_index` = front page;
`concepts.$` = page read; `concepts.new` (accepts `?parent=` / `?path=index`) + `concepts.edit.$`
= edit via `<PageEditor>`; `bundles.$id.graph` = graph; `bundles.new` / `bundles.$id.edit` = space
create / settings.

## Tests

Pure logic in `@tulipfarm/editor` (markdown round-trip, callout, slash filter) + `app/lib/
okf-listing.test.ts` + `markdown-view.test.tsx` (callouts). The tree/shell/editor are verified
end-to-end via Playwright. Run: `pnpm --filter @tulipfarm/web test knowledge`.
