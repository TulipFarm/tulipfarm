# Knowledge section (web)

Frontend for managing knowledge **documents** and **collections** in the shell. Markdown-only
content — **no file upload** (AC-V1-004). The backend (`apps/api/src/knowledge`) is the source of
truth; this is the UI over it.

## Data layer
- **`app/lib/knowledge-api.ts`** — typed client over the shared `apiGet/apiWrite/apiSend/apiDelete`
  primitives in `app/lib/api.ts` (cookie-first auth, CSRF echo, quoted `If-Match`). Covers documents
  CRUD, collections CRUD + membership, and search. `listCollectionsWithCounts` fans out one
  `documentIds` request per collection (N+1 — collections are few).
  - `apiSend` (added to `api.ts`) is for 204-returning mutations (e.g. add-to-collection) where
    `apiWrite` would throw parsing an empty body.

## Components (this dir — all presentational; routes own data + navigation)
- `index-status-badge` — per-doc `indexingStatus` pill (`indexed` ruby / `lexical-only` · `pending` muted).
- `doc-list` — `DocTable` (browse, sortable title/domain/updated) + `SearchResults` (semantic hits).
- `doc-form` — title / content (textarea + **markdown preview** via `MarkdownView`) / tags
  (comma ↔ `string[]`) / domain / `alwaysLoadForAgents`. Server-authoritative errors via props.
- `doc-detail` — `MarkdownView` body + metadata + badge + two-step inline **delete**.
- `collection-list` — name / description / **doc count**.
- `collection-form` — name / description / domain.
- `collection-detail` — meta + member documents with add (by id) / remove.

Shared chrome reused (not duplicated): `ResourcePanel`, `EmptyState`, `states` (Error/NotFound),
`MarkdownView`, `ui/button`, `resource-form`'s exported `writeErrorState` (422→field, 409→banner).

## Routes (`app/routes/_app.knowledge.*`)
`_app.knowledge.tsx` = layout with the `[documents] · [collections]` sub-nav + `<Outlet/>`;
`_app.knowledge._index.tsx` redirects to `/knowledge/documents` (via `<Navigate replace>`). Each entity
has `_index` / `new` / `$id` / `$id.edit`, mirroring the `_app.resources.*` convention. Routes fetch in
`clientLoader`, render via `useLoaderData`, and expose an `ErrorBoundary` (401 → auth, 404 → not found).

## indexingStatus (backend contract)
The API derives `indexingStatus ∈ {indexed, lexical-only, pending}` per document from its chunks
(read-only; returned on document create/get/list/update). `pending` = not yet indexed (prod indexing
is async); `lexical-only` = indexed without embeddings (no provider — search returns the
`embedding-unavailable` warning the list surfaces).

## Tests
`*.test.tsx` colocated (badge, doc-form) + `app/routes/knowledge.{documents,collections}.routes.test.tsx`
(Vitest + `createRemixStub` + mocked `useLoaderData`/`useRouteError`). `app/lib/knowledge-api.test.ts`
mocks `fetch`. Run: `pnpm --filter @tulipfarm/web test knowledge`.
