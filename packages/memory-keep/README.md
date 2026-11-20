# Memory Keep client

A small HTTP client for [Keep](https://github.com/TulipFarm/keep), the
open-source memory and knowledge service. TulipFarm talks to Keep over its
HTTP API only.

`createKeepClient({ endpoint, token })` offers:

- `health()`: `GET /v1/health/ready`, without the token.
- `memoryContext({ scope, query, budgetTokens })`: `POST /v1/memory/context`
  with `Authorization: Bearer <token>`.

Every call has a timeout (2 seconds by default) and refuses redirects. A slow,
missing or refusing service is a typed `{ status: 'unavailable', reason }`,
never an empty successful answer. Results never include the token.

The API composes the client behind the workspace `keep-memory` flag (off by
default) in `apps/api/src/keep-memory.ts`. Personal memory stays the source of
truth: the flag only probes Keep's availability and records it in telemetry.
