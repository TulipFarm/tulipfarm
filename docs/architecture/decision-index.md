# TulipFarm architecture decision index

Status: Accepted architecture contract
Scope: AW-001 decision freeze

This index records architecture decisions authorized by the approved SPEC and the binding repository
terminology. `metadata/terminologies.md` controls names at every layer; where the SPEC uses a retired
spelling, only the spelling is corrected here and the approved behavior remains unchanged.

Detailed contracts:

- [Boundaries and owners](boundaries.md)
- [Dependency rules](dependency-rules.md)

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

## Terminology decisions

These spellings supersede conflicting names in the planning SPEC without changing its behavior.

| ID | Accepted spelling | Replaces | Boundary effect |
| --- | --- | --- | --- |
| ADR-021 | Integration | Retired third-party synonyms | Domain, code, DB, REST, UI, and docs use Integration vocabulary |
| ADR-022 | `packages/integrations` | Retired package spelling in SPEC | Owns Integration adapter contracts, normalization, delivery, and mappings |
| ADR-023 | `apps/integration-worker` | Retired worker spelling in SPEC | Runs Integration ingress, sync, delivery, retries, and reconciliation |
| ADR-024 | Integration installation and `IntegrationCheckpoint` | Retired SPEC domain/checkpoint names | Preserves provider/app/install hierarchy without retired synonyms |
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
| Dynamic in-process third-party extensions | Grants trusted memory/code/credential access and bypasses isolation review |
| Direct Soul file/Git mutation | Bypasses schema, semantic checks, policy, approval, publication, and audit |
| Approval by heuristic or expired/mismatched decision | Approval must bind one exact normalized intent and current policy evidence |
| Local/SSH/container shell as production isolation | Workspace abstraction is useful but is not a strong security boundary |
| Compatibility with v1 internals or development DB | Clean contracts are preferred; cutover tests protect behavior instead |

## Change control

A later task may refine implementation details only when it preserves these decisions, the invariant
map, and the dependency allowlist. Any change that weakens an invariant, adds an authority/write/
effect path, introduces trusted unreviewed code, or changes an accepted public boundary requires a
new reviewed ADR and explicit design approval before implementation.
