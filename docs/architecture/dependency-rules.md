# TulipFarm architecture dependency rules

Status: Accepted architecture contract

These rules define compile-time direction. In every arrow below, `consumer -> provider` means the
consumer may import only the provider's documented public exports. Runtime calls remain subject to
authentication, authorization, policy, audit, and durable-state boundaries.

## Direction rules

1. Applications compose packages; packages never import from `apps/*`.
2. Packages import only public package exports, never another package's private source path.
3. `packages/schema` and `packages/observability` are foundations and import no TulipFarm runtime
   package.
4. A package may depend only on the allowlist below. Transitive availability is not permission.
5. Domain packages do not read another owner's tables. They use `packages/storage` repository and
   transaction ports.
6. Cross-process work uses versioned events/commands plus PostgreSQL inbox/outbox records, never an
   in-memory callback as the authoritative handoff.
7. Concrete provider SDKs live only in their owning adapter package. Core contracts expose
   provider-neutral ports and capability checks.
8. `apps/web` uses versioned HTTP/SSE and shared wire schemas. It never imports server, persistence,
   secret, provider, or worker code.

## Package import allowlist

An omitted edge is forbidden.

| Consumer | May import from |
| --- | --- |
| `packages/schema` | No TulipFarm runtime package |
| `packages/observability` | No TulipFarm runtime package |
| `packages/storage` | `packages/schema`, `packages/observability`, `packages/surface` |
| `packages/authz` | `packages/schema`, `packages/observability` |
| `packages/audit` | `packages/schema`, `packages/storage`, `packages/observability` |
| `packages/soul` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/storage`, `packages/observability`, `packages/surface` |
| `packages/secrets` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/storage`, `packages/observability` |
| `packages/run-kernel` | `packages/schema`, `packages/audit`, `packages/storage`, `packages/observability` |
| `packages/sandbox` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/storage`, `packages/observability` |
| `packages/tool-broker` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/secrets`, `packages/sandbox`, `packages/storage`, `packages/observability` |
| `packages/knowledge` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/storage`, `packages/observability`, `packages/constants`, `packages/llm`, `packages/tool-host` |
| `packages/memory` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/storage`, `packages/observability`, `packages/constants`, `packages/tool-host` |
| `packages/tool-host` | `packages/schema`, `packages/authz`, `packages/soul`, `packages/run-kernel`, `packages/tool-broker`, `packages/surface`, `packages/storage`, `packages/observability` |
| `packages/kv` | `packages/schema`, `packages/storage`, `packages/tool-host` |
| `packages/platform-tools` | `packages/schema`, `packages/tool-host`, `packages/agent-runtime` |
| `packages/surface` | `packages/schema` |
| `packages/surface-web` | `packages/surface` |
| `packages/surface-slack` | `packages/surface` |
| `packages/surface-telegram` | `packages/surface` |
| `packages/surface-github` | `packages/surface` |
| `packages/integrations` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/tool-broker`, `packages/storage`, `packages/observability` |
| `packages/agent-runtime` | `packages/schema`, `packages/authz`, `packages/audit`, `packages/run-kernel`, `packages/tool-broker`, `packages/knowledge`, `packages/memory`, `packages/observability` |
| `packages/curator` | `packages/schema`, `packages/constants`, `packages/observability` |
| `packages/curator-host` | `packages/schema`, `packages/constants`, `packages/curator`, `packages/memory`, `packages/run-kernel`, `packages/storage`, `packages/observability` |
| `packages/turn-executor` | `packages/schema`, `packages/run-kernel`, `packages/agent-runtime`, `packages/storage` |
| `packages/model-adapter` | `packages/agent-runtime`, `packages/llm` |

`packages/integrations` may implement the public Tool adapter interface owned by
`packages/tool-broker`; the broker does not import Integration implementations. `packages/agent-runtime`
may submit child-Run commands through the public `packages/run-kernel` port; the kernel never imports
the Agent runtime. Applications register implementations during composition.

## Application import allowlist

| Consumer | May import from |
| --- | --- |
| `apps/api` | `schema`, `soul`, `constants`, `authz`, `audit`, `secrets`, `run-kernel`, `tool-broker`, `agent-runtime`, `knowledge`, `memory`, `curator`, `curator-host`, `surface`, `surface-web`, `surface-slack`, `surface-telegram`, `surface-github`, `sandbox`, `integrations`, `storage`, `observability`, `tool-host`, `kv`, `platform-tools` |
| `apps/worker` | `schema`, `constants`, `authz`, `audit`, `secrets`, `soul`, `run-kernel`, `tool-broker`, `agent-runtime`, `knowledge`, `memory`, `curator`, `surface`, `integrations`, `sandbox`, `storage`, `observability`, `tool-host`, `kv`, `platform-tools`, `turn-executor`, `model-adapter` |
| `apps/integration-worker` | `schema`, `authz`, `audit`, `run-kernel`, `tool-broker`, `integrations`, `storage`, `observability` |
| `apps/web` | `schema`, `surface`, `surface-web`, and presentation-only packages such as `ui`/`editor` |
| `apps/eval` | `agent-runtime`, `turn-executor`, `model-adapter`, `llm`, `schema`, `secrets`, `soul`, `tool-host` |

`packages/constants` is a dependency-free leaf holding non-sensitive deployment defaults. The API
and the worker must resolve the same business scope or the worker claims nothing, and an app may
not import another app, so both read it from there. Secrets never belong in it.

The Worker may import `packages/soul` only for the Git-free execution-bundle read path. A durable
Run is pinned to an immutable bundle digest and exact definition identity; `PgBundleStore`,
`PinnedDefinitionLoader`, and signature verification are the single authority for opening that
definition. This edge does not license `SoulLoader`, Git sync, changeset writes, publication, or
active-alias resolution in the Worker.

`apps/api` may import `sandbox` and `agent-runtime` for one reason only: those packages own the
single implementation of something both applications need, and the alternative is a second copy.
The API spawns the `sandbox` hook isolate for resource hooks and the Worker spawns it for ingress
classification — one isolate, two capability grants. Likewise `agent-runtime` owns system-prompt
assembly, so the API's debug-context route renders the same prompt the Worker actually sent rather
than a lookalike. Neither edge licenses running a turn in the API: durable execution belongs to the
Worker, and these packages are pure — they open no connections and mint no Runs.

Package names in application rows are relative to `packages/`. Existing v1 packages may remain
during capability cutover, but target code must not create additional legacy dependencies. Each
legacy edge is removed when its accountable owner passes replacement and cutover tests.

`apps/worker` → `packages/llm` is the one edge added after that rule was written, and it is
recorded as legacy rather than allowed. The Worker executes the turn, so it is the process that
calls a model, and `packages/llm` holds the only provider and tier resolution that exists; the
target home for it is `packages/agent-runtime` (see "Model provider" below). Writing a second copy
in the Worker would create the same v1 debt twice and force it to be unwound twice. The edge
retires when `agent-runtime` owns provider adapters, which removes the API's identical edge in the
same change.

## Required ports and composition seams

| Port or seam | Contract owner | Implemented/composed by |
| --- | --- | --- |
| Transaction, repository, inbox/outbox | `packages/storage` | PostgreSQL adapters in `packages/storage`; applications provide pools |
| Authorization decision | `packages/authz` | Authz implementation; callers provide principal/context and consume evidence |
| Audit append/seal | `packages/audit` | PostgreSQL plus provider-neutral sealed-blob adapter |
| Active bundle lookup | `packages/soul` | Soul publication projection and content-addressed blob adapter |
| Run commands and step executor | `packages/run-kernel` | API submits; workers claim; executor implementations are injected |
| Tool adapter | `packages/tool-broker` | Native, Integration, MCP/OpenAPI, DB, and sandbox adapters register at composition |
| Secret/KMS provider | `packages/secrets` | Local envelope/KMS adapters selected through capability-checked config |
| Model provider | `packages/agent-runtime` | Provider adapters normalized behind ModelProfile selection |
| Sandbox backend | `packages/sandbox` | Isolated service/microVM adapters; never local fallback in production |
| Integration adapter | `packages/integrations` | `apps/integration-worker` loads reviewed Tulip-owned adapters in-process; third-party implementations run out of process over the authenticated, versioned Integration protocol |
| Blob/vector/cache | `packages/storage` | Filesystem/S3-compatible, pgvector, Redis, or other optional adapters |

## Forbidden edges and bypasses

- No package or application writes Soul Git/YAML except through `packages/soul` changesets.
- No Agent, Routine, Skill, Integration, route, or worker calls a Tool implementation directly.
- No model or Tool receives secret plaintext except the authorized adapter at dispatch time.
- No package other than `packages/knowledge` returns knowledge candidates before ACL evaluation.
- No Chat, schedule, webhook, form, API, Integration event, or delegation executes outside
  `packages/run-kernel`.
- No approval, stream, queue, retry counter, or authoritative state exists only in process memory.
- No application imports another application. Shared behavior moves to its accountable package.
- No package imports `pg-boss`, Redis, pgvector, or a provider SDK as a correctness contract.
- No dynamic MCP/OpenAPI/Integration discovery enables a Tool; discovery creates a Soul proposal.
- No untrusted extension module is imported into the API or worker process.
- No missing allowlist/policy broadens access. Missing, stale, or unverifiable context denies.

## Data and event ownership

- `packages/storage` owns physical persistence mechanics; domain owners define repository behavior
  and receive transaction-scoped ports.
- Publishers persist state plus an outbox event in one PostgreSQL transaction. Consumers record
  event ID plus consumer identity before acknowledging.
- Event schemas live in `packages/schema`. Additive changes may share a version; breaking or
  semantic changes require a new version.
- Large/private payloads travel as authorized Artifact references. Events, logs, and errors carry
  hashes and safe metadata, not protected content or secrets.
- Workers are horizontally replaceable. Losing a process, cache, queue accelerator, or vector
  adapter cannot lose authoritative state or grant access.

## Enforcement

This allowlist is enforced as a static-import check in `scripts/architecture-check.ts`
(`pnpm architecture:check`), which the CI `Architecture` job runs on every PR. The check scans the
`@tulipfarm/*` import graph and fails on any forbidden edge or import cycle with an actionable
message. The `legacyExceptions` map in `scripts/lib/architecture-rules.ts` documents the remaining
v1 edges tolerated during cutover; new legacy edges must not be added there. Review still treats any
omitted, undocumented edge as a blocking architecture violation. Runtime contract tests must
separately prove default deny, duplicate safety, crash/retry/restart behavior, authority
non-amplification, and redaction; passing an import check never substitutes for those tests.
