# TulipFarm architecture decision index

Status: Accepted architecture contract

This index records accepted architecture decisions and the binding repository terminology.
`metadata/terminologies.md` controls names at every layer; where an earlier design used a retired
spelling, only the spelling is corrected here and the approved behavior remains unchanged.

Detailed contracts:

- [Boundaries and owners](boundaries.md)
- [Dependency rules](dependency-rules.md)
- [Building an Integration](building-an-integration.md)
- [Governed network Tools](governed-network-tools.md)
- [Deployment manifest](deployment-manifest.md)
- [Sandboxed Surface code views](adr-031-sandboxed-surface-code.md)

## Accepted decisions

| ID | Decision | Rationale and consequence | Accountable owner |
| --- | --- | --- | --- |
| ADR-001 | One deployment represents one business; every persisted object carries `business_id` | Keeps current product scope while making isolation explicit and future-safe | `packages/storage` |
| ADR-002 | TulipFarm remains a TypeScript pnpm monorepo with modular applications and packages | Preserves current tooling while separating API, durable work, Integrations, and UI | Architecture rules |
| ADR-003 | PostgreSQL is the correctness core | Transactions, constraints, leases, inbox/outbox, and recovery must work without optional infrastructure | `packages/storage` |
| ADR-004 | Every Chat turn and automation is one durable Run with durable States | One state, recovery, policy, and audit model replaces special chat/schedule/webhook engines | `packages/run-kernel` |
| ADR-005 | State outputs are immutable typed Artifacts referenced by later inputs | Enables replayable lineage, validation, and safe concurrency; forbids mutable global context | `packages/run-kernel` |
| ADR-006 | Delivery is at least once with stable effect identities and reconciliation | External exactly-once claims are dishonest; ambiguous dispatch is explicit and never blindly retried | `packages/tool-broker` |
| ADR-007 | Every authored write uses one Soul changeset and publication gateway | UI, API, Agent, import, migration, MCP, and discovery paths cannot bypass validation/policy/audit | `packages/soul` |
| ADR-008 | Runs pin immutable published bundles by content digest | Runtime does not need live Git and survives deploys; current security revocations still re-evaluate | `packages/soul` |
| ADR-009 | Effective authority is an intersection and can only narrow | Users, Agents, Run context, resources, destinations, Tools, and credentials never union authority | `packages/authz` |
| ADR-010 | Skills contain instructions/assets and never grant Tools | Prevents instruction packages from becoming capability or authorization boundaries | `packages/authz` |
| ADR-011 | Tool calls use one broker with exact approvals and a durable effect ledger | The broker orchestrates validation, approval, dispatch, and recovery while consuming authorization/DLP decisions, credential leases, and audit appends from their owners | `packages/tool-broker` |
| ADR-012 | Secrets are opaque references resolved immediately before authorized dispatch | Keeps plaintext out of Soul, prompts, logs, audit, and stale caches | `packages/secrets` |
| ADR-013 | Knowledge ACLs are enforced before candidate ranking or return | Prevents leakage through candidates, snippets, metadata, summaries, embeddings, and timing | `packages/knowledge` |
| ADR-014 | Audit is append-only, hash-linked, separately sealed, and supports cryptographic erasure | Missing, reordered, or altered evidence remains detectable; authorized key destruction retains tombstones and chain integrity, subject to legal holds | `packages/audit` |
| ADR-015 | Provider selections remain behind capability-checked ports | PostgreSQL stays required; cache, vector, queue optimization, blob, KMS, model, and sandbox providers remain replaceable | Port owner |
| ADR-016 | Untrusted code executes outside the control-plane process | Third-party Integration code and Skill scripts cannot share API/worker memory or implicit credentials | `packages/sandbox` |
| ADR-017 | Hermes is a read-only behavioral reference, never a dependency or compatibility target | Adapt ergonomics while rejecting process-local durability, implicit authority, and in-process extensions | Architecture rules |
| ADR-018 | Current behavior is replaced beside existing behavior and cut over by capability | No users require DB compatibility; old routes/workers are removed only after target acceptance proves replacements | Application owners |
| ADR-019 | V1 ships no public customer CLI, general SDK, native app, or desktop app | Focuses security and product support on responsive browser and approved HTTP/Integration surfaces | `apps/api`, `apps/web` |
| ADR-020 | Applications compose; packages own domain decisions; packages never import applications | Prevents cycles, hidden ownership, and duplicated business rules | Dependency rules |
| ADR-027 | A user's Memory is one Markdown Memory Document, always injected whole, written by named-entry delta from Tools and by stale-checked section replacement from privileged writers | Removes relevance recall, versioned Assertions, and the confirmation queue as sources of silent omission; the document is current truth, so what the model reads is exactly what was written | `packages/storage`, `apps/api` |
| ADR-028 | The Curator is one durable Run per user or business that proposes every model-derived effect; deterministic maintenance stays deterministic | Model reasoning cannot execute outside `packages/run-kernel` (ADR-004); one loop replaces four half-built mechanisms for memory, Knowledge, Tasks, and suggestions | `packages/curator`, `apps/worker` |
| ADR-029 | Curator output names only a closed `kind` and a Run-scoped subject; the server templates every user-visible string, URL, and dedupe key | A Proposal pill inserts its prompt straight into Chat, so model-authored text there is a direct injection path into the user's next turn | `packages/curator`, `apps/api` |
| ADR-030 | Generic web and API access runs as governed first-party Tools with pure call-level read/write classification | One structured path keeps SSRF controls, exact destination and Secret authority, Approval, and effect recovery intact while allowing REST and GraphQL calls whose risk varies by operation | `packages/tool-host`, `packages/integrations`, `apps/api` |
| ADR-031 | A Surface component may carry Agent-authored code, executed in an opaque-origin `sandbox="allow-scripts"` frame with `connect-src 'none'` | The shipped catalog cannot anticipate every visual a user asks for, and an Agent that can only re-compose it substitutes and narrates; the boundary is the missing origin and the missing network, never source inspection | `packages/surface`, `packages/surface-web`, `apps/web` |

## Superseded decisions

Superseded decisions stay listed until their mechanism is deleted, because the old path remains live
through cutover (ADR-018).

| ID | Decision | Superseded by | Removed when |
| --- | --- | --- | --- |
| ADR-026 | Memory is scoped Assertions plus Pending Memory, Episodes, and content-free telemetry | ADR-027 | fully retired — `packages/memory` internals, the memory routes, the Settings memory panes and the five `memory_*` tables are deleted (migrations v66, v67) |

## Terminology decisions

These spellings supersede earlier conflicting names without changing behavior.

| ID | Accepted spelling | Replaces | Boundary effect |
| --- | --- | --- | --- |
| ADR-021 | Integration | Retired third-party synonyms | Domain, code, DB, REST, UI, and docs use Integration vocabulary |
| ADR-022 | `packages/integrations` | Retired package spelling | Owns Integration adapter contracts, normalization, delivery, and mappings |
| ADR-023 | `apps/integration-worker` | Retired worker spelling | Runs Integration ingress, sync, delivery, retries, and reconciliation |
| ADR-024 | Integration installation and `IntegrationCheckpoint` | Retired domain/checkpoint names | Preserves provider/app/install hierarchy without retired synonyms |
| ADR-025 | `/api/v1/chats/:id/turns` | Retired Conversation wire route | Chat stays external/wire; Conversation remains internal/persistence |

## Rejected alternatives

| Alternative | Reason rejected |
| --- | --- |
| Fork or embed Hermes, then add business controls | Durability and authorization are kernel properties, not safe overlays |
| Separate chat, schedule, webhook, and Routine engines | Creates competing recovery, policy, effect, and audit domains |
| Redis, pg-boss, a vector DB, or external orchestration service as correctness core | Optional/provider-specific infrastructure cannot be required for correctness |
| Shared mutable Routine context | Breaks typed lineage, replay, concurrency, and deterministic recovery |
| Exactly-once external effects | Cannot be guaranteed across arbitrary providers and ambiguous network outcomes |
| Static Tool sets or missing allowlists as authorization | Tool discovery/exposure never substitutes for policy; missing context denies |
| Retrieve knowledge then redact | Candidate and metadata leakage already occurred before redaction |
| Dynamic in-process third-party extensions | Grants trusted memory/code/credential access and bypasses isolation review — unrelated to ADR-031, whose authored view code runs only in the reader's browser with no origin, network or credential |
| A closed set of declarative drawing primitives instead of authored code | Every new visual still needs the primitive set to have anticipated it, and local editing state cannot be expressed at all (ADR-031) |
| Direct Soul file/Git mutation | Bypasses schema, semantic checks, policy, approval, publication, and audit |
| Approval by heuristic or expired/mismatched decision | Approval must bind one exact normalized intent and current policy evidence |
| Local/SSH/container shell as production isolation | Workspace abstraction is useful but is not a strong security boundary |
| Compatibility with v1 internals or development DB | Clean contracts are preferred; cutover tests protect behavior instead |
| Key/value or fact-level Memory operations instead of section patches | Reintroduces the identity model ADR-027 retired; a per-section stale check already prevents lost updates |
| A business-scoped Memory Document mirroring the user one | Business learning belongs in Knowledge, which already has ACLs, citations, and human review |
| Curator reasoning as a bare pg-boss job beside the deterministic sweep | Model-derived effects outside the run kernel would fork recovery, concurrency, budget, and audit (ADR-004) |
| A business Run emitting Proposals directly | Business scope cannot name an audience; only the target user's own Run may read their document and personalize |

## Change control

A later task may refine implementation details only when it preserves these decisions, the invariant
map, and the dependency allowlist. Any change that weakens an invariant, adds an authority/write/
effect path, introduces trusted unreviewed code, or changes an accepted public boundary requires a
new reviewed ADR and explicit design approval before implementation.
