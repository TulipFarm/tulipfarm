# Private conversation browser evidence

The historical text-chat UI proof below dates from 28 September 2026. The aggregate acceptance, verified on 29 September, supersedes its scope exclusions. The current live script includes attachments, and the separate interaction scripts cover requests and approvals on the normal 21-receipt stream.

`src/features/chat/private-conversations.tsx` replaces the browser-only workspace home. Private reads and drafts remain in mounted component state. `src/pages/workspace.tsx` keys that state by session, user, and workspace. Chat URLs use `/{workspaceSlug}#chat={chatId}`. No private content is written to browser storage or a shared query cache.

`conversation-api.ts` validates HTTP responses. `conversation-state.ts` retains uncertain commands with their exact inputs and IDs. Read refresh aborts a superseded request, retains successful history during pagination and transient failure, and stops automatic checks after 30 pending checks. HTTP denial unmounts the entire private view. Focus and workspace-access events revalidate access.

## Executed proofs

- `pnpm --filter @tulipfarm/web test:conversations` passed in Chromium. Controlled responses exercise slow loading, empty history and lists, repeated initial failure, transient refresh failure, exact create and send replay after lost acknowledgement, duplicate clicks, queued sends, ordered text parts, persisted-history reload, generation-bound retry and cancel, rename conflict recovery, archive and restore, title search, both pagination paths, title length validation, dark mobile and light desktop layouts, reduced motion, bounded polling, access concealment, and workspace isolation.
- `pnpm --filter @tulipfarm/web test:conversations:live` passed with `TEST_ADMIN_DATABASE_URL` set to the disposable local PostgreSQL server. The first runs used the read-only HTTP worktree via `CONVERSATION_BACKEND_ROOT`, at backend revision `96d976555844b4773c4e84a2b72d1577c695cfb4`. The script creates an isolated test database and restricted logins, runs real Better Auth sessions and conversation HTTP handlers, drops one accepted send response, verifies exact receipt replay, processes two reverse replies through the real executor, reloads history, renames, archives, restores, retries, cancels, and denies another workspace admin and the removed owner.
- `pnpm check` passed all 49 tasks. The existing production bundle size warning remains.

The live browser script uses fixture metadata for workspace admission routes and explicitly drives the executor. It does not prove Temporal dispatch, API or worker process restart, production deployment, or complete workspace admission. The failed-turn setup changes the isolated fixture row before the user retries it. The initial text-only proof did not cover attachments or interaction cards. Raw internal conversation UI remains deliberately unavailable.

## Reproduction

Run `pnpm install --frozen-lockfile` and `pnpm check` from the repository root. Run the two browser scripts above. The live script requires local PostgreSQL and the conversation HTTP implementation. `CONVERSATION_BACKEND_ROOT` optionally selects a read-only backend checkout before its PR lands. Omit it once those routes are on main. `CONVERSATION_SCREENSHOT_DIR` saves synthetic-data screenshots into an existing directory. No live credentials or environment files are needed.
