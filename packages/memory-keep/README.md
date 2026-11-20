# Memory Keep client

A small HTTP client for [Keep](https://github.com/TulipFarm/keep), the
open-source memory and knowledge service. TulipFarm talks to Keep over its
HTTP API only.

`createKeepClient({ endpoint, token })` offers:

- `health()`: `GET /v1/health/ready`, without the token.
- `memoryContext({ scope, query, budgetTokens, includePersonal, includeKnowledge })`:
  a budgeted context bundle from `POST /v1/memory/context`.
- `read`, `list`, `history`, `write`, `undo`, `delete`, `restore` and `forget`:
  the matching `POST /v1/memory/*` routes, with `Authorization: Bearer <token>`.
  `write` takes `expectedRevisionId` for compare-and-swap and an
  `idempotencyKey` so a retried write is applied once. `delete` moves a file to
  the trash, where `restore` can bring it back for 7 days; `forget` erases a
  file, an entry or exact text from every revision and cannot be undone.

Every call has a timeout (2 seconds by default) and refuses redirects. Memory
routes return a typed `KeepMemoryResult`: `ok`, `unavailable` (slow, missing,
not ready or refusing the token), `conflict` (with the current head when Keep
reports it), `not_found` or `rejected` (with Keep's error code). An unavailable
service is never an empty successful answer. Results and errors never include
the token, and the client never logs memory text.

`scope.ts` maps TulipFarm owners to Keep scopes. A member's personal memory is
`{ user: 'ws-<workspaceId>-m-<membershipId>' }` with no project, so a new
membership starts with an empty tree. Both ids must be UUIDs, and each is
written as 25 base-36 characters so the id fits Keep's 64-character limit.

The conversations package uses the client for personal memory in workspaces
where the `keep-memory` flag (off by default) is on. See
`packages/conversations/src/keep-personal-memory.ts`.
