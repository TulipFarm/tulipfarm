# TulipFarm architecture boundaries

Status: Accepted architecture contract
Authority: `metadata/terminologies.md`

This document freezes ownership and enforcement boundaries for TulipFarm. Later work may
choose libraries and adapters behind these boundaries, but may not add a second authority path or
weaken an invariant without a reviewed architecture decision.

## Product boundary

- One deployment represents one business, while every persisted object carries `business_id`.
- Tulip-owned runtime code is TypeScript in this pnpm monorepo.
- PostgreSQL is the correctness core. Queues, caches, vector stores, and model providers are
  replaceable optimizations or adapters.
- Browser, HTTP, webhook, and internal Integration surfaces are in scope. A public customer CLI,
  general SDK, native app, and desktop app are out of scope for v1.
- Chat is the external/wire term; Conversation is the internal/persistence term. The turn route is
  `/api/v1/chats/:id/turns`.
- Integration is the canonical third-party term. The architecture uses `packages/integrations` and
  `apps/integration-worker`; an installed external link is an Integration installation.
- Hermes is a read-only behavioral reference. TulipFarm neither forks, embeds, imports, nor keeps
  runtime compatibility with Hermes.

## Trust and process boundary

```text
Browser / external systems
          |
          v
       apps/api <------> apps/web
          |
          +---- authz / policy / Soul / audit commands
          +---- PostgreSQL transaction + outbox
          |
          v
      apps/worker ----> Run kernel / Agent runtime / Tool Broker
          |                                |
          |                                +--> Secret Broker
          |                                +--> model adapters
          |                                +--> isolated sandbox service
          v
 apps/integration-worker ----> external Integration adapters
```

`apps/api` authenticates requests and submits commands; it does not execute long-running Agent or
Tool work. Workers claim durable work and persist every transition before acknowledging it.
Untrusted scripts and third-party Integration implementations execute outside the control-plane
process and communicate through authenticated, versioned protocols.

## Accountable owners

Each cross-cutting concern has exactly one accountable package. Collaborators consume its public
contract; they do not reimplement its decisions.

| Concern | Accountable owner | Public responsibility |
| --- | --- | --- |
| Schemas and canonicalization | `packages/schema` | Versioned JSON Schemas, AJV validators, migrations, canonical values |
| Soul authorship and publication | `packages/soul` | Changesets, Git adapter, validation pipeline, immutable published bundles |
| Identity and authorization | `packages/authz` | Principals, roles, grants, authority intersection, policy evidence |
| Audit and lineage | `packages/audit` | Audit events, hash chains, sealing, retention, cryptographic erasure evidence, export, lineage queries |
| Credentials and secret resolution | `packages/secrets` | Envelope crypto, Secret Broker, leases, rotation, revocation |
| Durable orchestration | `packages/run-kernel` | Run and State state machines, attempts, waits, leases, retries, child Runs |
| Tool effects and approvals | `packages/tool-broker` | Catalog and intent/effect orchestration that consumes authorization decisions, credential leases, audit appends, exact approvals, and reconciliation |
| Agent and model behavior | `packages/agent-runtime` | Context assembly, model profiles, bounded Tool loop, budgets, delegation |
| Knowledge authorization | `packages/knowledge` | Source ACL ingestion, retrieval, provenance, invalidation, deletion |
| Durable Memory | `packages/memory` | Scoped Assertions, Pending Memory confirmation, provenance, recall reauthorization, Contradictions, Episodes, Forget, and Erase |
| Tulip Surface Protocol and forms | `packages/surface` | Safe presentation schemas, Artifacts, signed actions, form contracts |
| Integrations | `packages/integrations` | Adapter contracts, event normalization, delivery, identity mapping, checkpoints |
| Isolated execution | `packages/sandbox` | Execution request, backend ports, workspace, egress and resource controls |
| Persistence and infrastructure ports | `packages/storage` | PostgreSQL repositories, transactions, outbox/inbox, blob/vector/cache ports |
| Telemetry and redaction | `packages/observability` | OTel conventions, health, metrics, correlation, log redaction |

The Tool Broker consumes policy and DLP decisions from `packages/authz`, credential leases from
`packages/secrets`, and append contracts from `packages/audit`. Its contract prohibits reimplementing
or broadening those owners' decisions.

Application ownership is composition-only:

| Application | Responsibility |
| --- | --- |
| `apps/api` | HTTP/SSE, sessions, request auth, commands, webhooks, approvals, read models |
| `apps/worker` | Run dispatch, Agent/Tool steps, timers, reconciliation, projections |
| `apps/integration-worker` | Integration ingress, sync, delivery, rate limits, reconciliation |
| `apps/web` | Responsive browser product over authorized APIs |

## Release-blocking invariant map

The accountable owner defines the public contract and evidence shape. Required collaborators may
add stricter checks but cannot bypass or broaden the owner's decision.

| ID | Invariant | Accountable owner | Enforceable boundary and evidence |
| --- | --- | --- | --- |
| I-01 | One business; persisted objects carry `business_id` | `packages/storage` | Repository inputs require `business_id`; DB constraints and audit correlation prove scope |
| I-02 | Every external principal resolves before execution | `packages/authz` | Identity resolution returns a Tulip principal or constrained guest; unresolved input denies |
| I-03 | Effective authority is an intersection and never amplifies | `packages/authz` | One decision API intersects user, Agent, Run context, resource, destination, and credential scope |
| I-04 | Skills instruct but never grant Tools | `packages/authz` | Tool exposure and every Tool intent require independent grants; Skill metadata is not authority |
| I-05 | Every authored write uses one Soul changeset gateway | `packages/soul` | No public Git/file write API; every proposal records validation, policy, approval, and audit IDs |
| I-06 | Runtime uses an immutable published digest without live Git | `packages/soul` | Bundle activation is content-addressed; Runs pin a digest; publication failure keeps prior active |
| I-07 | Every Chat turn and automation is a durable Run | `packages/run-kernel` | Public commands persist Run/State plus outbox before dispatch; no in-process-only execution path |
| I-08 | State outputs are immutable typed values | `packages/run-kernel` | AJV-valid Artifact references are append-only; later inputs name prior outputs explicitly |
| I-09 | Every side effect is idempotent and durably recorded | `packages/tool-broker` | Stable effect identity is persisted before dispatch; ambiguous results reconcile instead of retry |
| I-10 | Secrets remain opaque until authorized Tool dispatch | `packages/secrets` | Secret Broker leases current credentials after authorization; plaintext never enters Soul/prompts |
| I-11 | Knowledge authorization precedes ranking and return | `packages/knowledge` | ACL filter/live check runs before candidates; stale, revoked, or unverifiable access denies |
| I-12 | Untrusted content cannot become authority | `packages/authz` | Data/instruction classification and policy deny permission, credential, and approval amplification |
| I-13 | Approval binds exact intent and policy revision | `packages/tool-broker` | Digest, evidence, approver rules, expiry, and one-use decision revalidate immediately pre-dispatch |
| I-14 | Published definitions and evidence are immutable versions | `packages/storage` | Versioned/append-only repository APIs reject update/delete of protected rows and digests |
| I-15 | Audit evidence is append-only, hash-linked, separately sealed, and supports cryptographic erasure | `packages/audit` | Append API links prior hash; verifier and sealed segment detect removal, reorder, or mutation; authorized key destruction erases protected payloads while retaining tombstone and chain-integrity evidence, and legal holds block erasure |
| I-16 | Optional infrastructure is never required for correctness | `packages/storage` | Provider ports declare capabilities; PostgreSQL fallback remains authoritative under adapter loss |
| I-17 | Memory content never leaks through recall side channels or telemetry | `packages/memory` | Recall authorizes scope and Knowledge evidence before truncation; exclusions are reason counts only; metrics/spans use bounded enums and counts, never statements, subjects, entities, queries, or ids |

## Durable failure contract

Every owning boundary must cover these cases in contract or state-machine tests when implemented:

| Case | Required outcome |
| --- | --- |
| Empty, malformed, version-mismatched input | Stable typed denial; no durable partial state |
| Duplicate or replay | Existing logical result; no duplicate Run or effect |
| Concurrent update or claim | DB uniqueness/CAS/lease chooses one winner; loser safely retries or denies |
| Crash before dispatch | Persisted work is reclaimable; no external effect occurred |
| Crash or timeout after possible dispatch | Effect becomes ambiguous/reconciliation-required; never blind retry |
| Restart or deploy | Worker reconstructs authority and progress only from durable records/bundle digest |
| Revocation during a Run | Next protected action reauthorizes and denies; in-flight effects reconcile |
| Optional provider loss | Degrade, wait, or fail explicitly without losing authoritative state |

## Errors, audit, and observability

- Boundary errors use a versioned envelope: stable code, safe message, correlation ID,
  retryability, and optional field issues. Stack traces and provider payloads stay internal.
- Structured logs carry request, event, Run, State, effect, Integration, and audit correlation
  IDs. They never contain secret plaintext, protected Artifact contents, prompts, or raw webhook
  bodies.
- Audit evidence records actor/effective principal, action, resource, allow/deny reason, relevant
  policy and bundle digests, request/result hashes, causation, and safe metadata.
- Audit evidence is not replaced by logs or traces. Sensitive content is referenced through an
  authorized Artifact rather than copied into telemetry.
- Failure to emit optional telemetry cannot alter correctness. Failure to persist required audit
  evidence follows policy and stops high-risk work when its durability threshold is exceeded.

## V1 reuse and replacement map

Reuse means behavior or a primitive is adapted only after target contract tests pass. It never means
the current API or trust boundary is preserved.

| Current source | Decision | Target boundary and rationale |
| --- | --- | --- |
| Root pnpm workspace and Turbo config | Reuse | Preserve TypeScript monorepo mechanics; add target apps/packages behind frozen rules |
| `packages/schema/src/routine.ts` | Adapt primitives; replace contract | Keep TypeBox/AJV techniques; replace v1 Routine shape and deferred semantics in `packages/schema` |
| `packages/soul/src/git-sync.ts` | Adapt | Reuse tested Git mechanics behind the sole `packages/soul` changeset/publication boundary |
| `packages/soul/src/soul-loader.ts` | Replace boundary | Fail-open loading cannot be publication authority; runtime consumes an active immutable digest |
| `packages/routine-engine` | Adapt concepts; replace engine | Keep useful outcomes/snapshots; move to durable `packages/run-kernel` with immutable outputs |
| `apps/api/src/routines/driver.ts` | Adapt patterns | Preserve CAS, persist-first, journal, wake, timeout, and approval ideas in `packages/run-kernel` |
| `apps/api/src/routines/repo.ts` | Replace | Mutable context/status model becomes Runs, States, attempts, waits, and effects |
| `apps/api/src/chat/turn.ts` | Adapt ergonomics; replace execution | Keep streaming, Skills, models, and compaction behavior inside durable Agent steps |
| `apps/api/src/tools/registry.ts` | Adapt validation; replace authority | Keep AJV/timeouts; all Tool discovery and calls move through `packages/tool-broker` |
| `apps/api/src/chat/approvals.ts` | Replace | Process-local pending decisions become durable exact-intent approvals |
| `apps/api/src/approvals/repo.ts` | Adapt persistence seed | Add digest binding, expiry, policy evidence, one-use decisions, and four-eyes enforcement |
| `apps/api/src/auth/users.ts` | Replace | Two fixed roles become custom roles and scoped grants in `packages/authz` |
| `packages/secrets/src/crypto.ts` | Reuse after vectors | Preserve AES-256-GCM primitives behind scoped leases, rotation, and revocation tests |
| `packages/secrets/src/service.ts` | Adapt | Make it the Secret Broker owner; forbid stale resolution and plaintext propagation |
| `apps/api/src/surface/compiler.ts` | Adapt | Preserve escaping/compiler ideas inside safe `packages/surface` Artifact contracts |
| `apps/api/src/surface/surface-store.ts` | Replace boundary | Process/local surfaces become immutable authorized Artifacts and signed actions |
| `apps/api/src/knowledge/retrieval-service.ts` | Replace authorization seam | `packages/knowledge` enforces source ACLs before ranking/candidate exposure |
| `apps/api/src/ingress/service.ts` | Replace identity path | Integration events resolve the external principal; never borrow a Conversation owner's identity |
| `apps/api/src/integrations/mcp-client-service.ts` | Replace enablement path | Discovery creates a pinned Soul proposal; it never registers a Tool directly in process |
| `packages/llm` | Adapt behind owner | Provider normalization informs `packages/agent-runtime`; ModelProfile/policy owns selection |
| `DESIGN.md` and existing web components | Reuse selectively | Preserve visual language only over authorized APIs and accessibility contracts |

## Hermes adapt/reject record

Hermes paths are evidence only and remain read-only.

| Hermes source | Adapt | Reject or replace |
| --- | --- | --- |
| `README.md` | Model neutrality, interruptible conversations, channel continuity, scheduling and delegation ergonomics | Public CLI/desktop product surface and single-principal trust assumptions |
| `agent/conversation_loop.py` | Bounded iterative Tool loop, streaming, interruption, provider fallback, malformed-call recovery | Mutable Agent/session state, SQLite as Run durability, plugin hooks as authority, monolithic execution |
| `gateway/run.py` | Normalized channel events, thread continuity, rate/reconnect handling, user-visible delivery behavior | Process-local Agent caches/queues as records, channel identity as Tulip authority, one daemon as durability |
| `hermes_cli/plugins.py` | Manifest and discovery ergonomics, explicit registration vocabulary | `importlib` execution of user/project packages in the trusted process and direct dynamic Tool registration |

No Hermes module is a TulipFarm dependency. Useful behavior is re-expressed through typed ports,
durable Runs, narrowed authorization, isolated execution, and TulipFarm-owned tests.
