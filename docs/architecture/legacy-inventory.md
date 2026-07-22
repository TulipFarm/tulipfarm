# TulipFarm legacy bypass inventory and cutover targets

Status: Accepted architecture contract
Scope: AW-006 legacy bypass and cutover inventory
Authority: `metadata/terminologies.md`, then the approved architecture SPEC, then
[boundaries.md](boundaries.md) and [decision-index.md](decision-index.md)

This document inventories every known legacy runtime, configuration, and effect path that bypasses
a target invariant, and maps each to the task that replaces it, the test that proves cutover, and
the task that removes it. It is the cutover contract that AW-096 consumes to prove that no listed
bypass remains, and that AW-098 uses to prove every replaced requirement is covered.

Legacy filenames are quoted literally for source discovery even when they contain a retired term
(SPEC terminology lock). Naming a path here is not endorsement of its trust boundary; each row
records the invariant it currently violates.

## How to read a row

| Column | Meaning |
| --- | --- |
| ID | Stable `LB-NN` identifier for the bypass; referenced by cutover and review tasks |
| Category | The bypass class (see mandatory high-risk classes below) |
| Legacy path | Repo-relative file that carries the bypass today; it must exist now and be gone after removal |
| Bypass / shadow risk | The invariant violation or shadow/second-authority risk the path creates |
| Invariant | The release-blocking invariant (`I-NN`) or decision (`ADR-NNN`) the path violates |
| Replacement | Task(s) that build the governed replacement beside the legacy path |
| Cutover test | Task whose tests prove the replacement is authoritative and the bypass is closed |
| Removal | Task that disables or deletes the legacy path once cutover passes |
| Risk | `high`, `medium`, or `low` residual risk while the bypass still exists |

The five high-risk classes the acceptance criteria require to be explicit are
`identity-substitution`, `process-approval`, `acl-seam`, `mcp`, and `all-tools`. Each is present
below and marked `high`.

Machine verification: `apps/api/src/legacy-inventory.test.ts` parses the table below, asserts every
legacy path still exists (the inventory is not stale) and every row names a replacement, cutover
test, and removal owner. AW-096 inverts the existence check to prove the same paths are gone.

## Inventory

| ID | Category | Legacy path | Bypass / shadow risk | Invariant | Replacement | Cutover test | Removal | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LB-01 | identity-substitution | `apps/api/src/ingress/service.ts` | Integration ingress runs the Turn as the Conversation owner (`runAs = owner`) with hardcoded `autonomy: "full"`; a different external sender's Message executes under another user's identity and authority | I-02 | AW-020, AW-058, AW-071 | AW-074 | AW-096 | high |
| LB-02 | all-tools | `apps/api/src/tools/registry.ts` | In-process registry exposes every registered Tool to the model (ALLOW_ALL / AC-V1-004); a missing allowlist exposes all Tools instead of denying, and there is no broker reauthorization per call | I-04 | AW-036, AW-037 | AW-045 | AW-096 | high |
| LB-03 | process-approval | `apps/api/src/chat/approvals.ts` | Pending Tool approvals live in a process-memory `Map`; no exact-intent digest binding, no Guardrail revision, no four-eyes, and an API restart drops in-flight decisions | I-13 | AW-023, AW-041 | AW-045 | AW-096 | high |
| LB-04 | mcp | `apps/api/src/integrations/mcp-client-service.ts` | MCP discovery registers Tools directly in process, inherits `process.env`, and resolves `secret://` env into subprocess plaintext with no pinned proposal or Guardrail boundary | I-04 | AW-087 | AW-089 | AW-096 | high |
| LB-05 | acl-seam | `apps/api/src/knowledge/retrieval-service.ts` | Retrieval enforces no source ACL before ranking or content return; ACL is left as a documented seam, so disallowed candidates, snippets, and metadata can leak | I-11 | AW-075 | AW-080 | AW-096 | high |
| LB-06 | runtime | `apps/api/src/chat/turn.ts` | A Chat Turn is an in-process streaming flow, not a durable Run with durable States; a crash loses authoritative Run state and there is no resumable lineage | I-07 | AW-050 | AW-035 | AW-096 | high |
| LB-07 | runtime | `packages/routine-engine/src/interpreter.ts` | The Routine interpreter drives automations over a shared mutable JSON Context with local caps and incomplete State semantics; no immutable typed outputs and no durable orchestration | I-08 | AW-028, AW-054 | AW-061 | AW-096 | high |
| LB-08 | config-write | `packages/soul/src/soul-loader.ts` | The Soul loader reads and can skip invalid entries at load time; it acts as an alternate, fail-open write/read path rather than the single fail-closed changeset and publication gateway | I-05 | AW-011, AW-014 | AW-016 | AW-096 | high |
| LB-09 | secret-resolution | `packages/secrets/src/service.ts` | Secret resolution has no scoped Secret Broker lease, rotation, or revocation semantics; stale plaintext can remain usable and is not bound to an authorized Tool dispatch | I-10 | AW-024 | AW-045 | AW-096 | high |
| LB-10 | auth | `apps/api/src/auth/users.ts` | Only fixed `admin` and `member` roles exist; there are no custom user/Agent roles or scoped AccessGrants, so authority cannot narrow through delegation or Run Context | I-03 | AW-017, AW-018 | AW-026 | AW-096 | high |
| LB-11 | approval-persistence | `apps/api/src/approvals/repo.ts` | The approvals table is a persistence seed lacking exact intent binding, expiry semantics, Guardrail evidence, and four-eyes enforcement; decisions are not one-use or digest-bound | I-13 | AW-023 | AW-026 | AW-096 | medium |
| LB-12 | direct-effect | `apps/api/src/routines/driver.ts` | The Routine driver dispatches effects with CAS/persist-first patterns but no effect ledger, idempotency key, or ambiguity reconciliation; retries can double-apply external effects | I-09 | AW-038, AW-039 | AW-035 | AW-096 | medium |
| LB-13 | table | `apps/api/src/routines/repo.ts` | Routine persistence snapshots definitions but stores a mutable Context and a limited status model; it is superseded by Runs, States, attempts, waits, and effect records | I-08 | AW-028 | AW-035 | AW-096 | medium |
| LB-14 | a2ui | `apps/api/src/a2ui/surface-store.ts` | A2UI surfaces are process/local store rows rather than immutable authorized Artifacts with signed, expiring action descriptors; client actions are not re-authorized against a signed intent | I-14 | AW-081 | AW-084 | AW-096 | medium |
| LB-15 | worker | `apps/api/src/ingress/jobs.ts` | Legacy Integration ingress runs on an in-process pg-boss worker with prompt-to-session processing instead of a normalized EventInbox and a separately scalable integration worker | ADR-018 | AW-058, AW-059 | AW-074 | AW-096 | medium |
| LB-16 | queue | `apps/api/src/chat/stream-gc.ts` | Durable-work coordination (stream GC, ingress, sync) is scheduled on in-process pg-boss queues in `apps/api`; the target moves durable dispatch to `apps/worker`/`apps/integration-worker` over the transactional outbox | ADR-003 | AW-027, AW-034 | AW-035 | AW-096 | low |

## Coverage against SPEC §26.2 cutover acceptance

Each cutover-acceptance clause in SPEC §26.2 maps to the inventory rows and the test that proves it.

| §26.2 clause | Rows | Proven by |
| --- | --- | --- |
| Every write reaches the Soul gateway | LB-08 | AW-016 |
| Chat and every trigger create the same Run/State records | LB-06, LB-07, LB-13 | AW-035, AW-061 |
| No work runs under another user's identity | LB-01, LB-10 | AW-074, AW-026 |
| Private source never appears in unauthorized retrieval | LB-05 | AW-080 |
| Duplicate delivery causes one logical Routine and idempotent effects | LB-12, LB-15 | AW-065 |
| Worker death during an effect reaches a reconciled state | LB-12 | AW-035 |
| Secret rotation/revocation affects the next invocation | LB-04, LB-09 | AW-045 |
| Legacy routes and workers are disabled or removed, not left as bypass paths | LB-02, LB-03, LB-11, LB-14, LB-16 | AW-096 |

## Shadow and second-authority risks

These are the paths that could silently re-open a bypass after cutover if a later task reintroduces
them. AW-096 and AW-097 must confirm none returns as a shadow authority:

- A second Tool-exposure path that skips the broker (any direct `buildToolSet`/`registry.register`
  outside `packages/tool-broker`) re-creates LB-02/LB-04.
- Any in-process approval `Map` or non-digest-bound decision re-creates LB-03/LB-11.
- Any ingress or channel path that borrows a Conversation owner's identity re-creates LB-01.
- Any Soul read/write outside the changeset gateway re-creates LB-08.
- Any retrieval that ranks before an ACL check re-creates LB-05.

## Change control

Adding a legacy path to the codebase requires adding its `LB-NN` row here in the same change, or the
machine verifier fails. Removing a row is permitted only by the named removal owner after its cutover
test passes. Changing a replacement, cutover, or removal mapping requires a reviewed update that
preserves the invariant map in [boundaries.md](boundaries.md).
