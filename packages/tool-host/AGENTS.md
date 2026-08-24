# `@tulipfarm/tool-host`

The Tool execution host: the contract a Tool is written against, the authorization gate, and the
dispatcher that runs one Tool call under a Run's authority. Composed by both `apps/api` and
`apps/worker`, so a Tool is authorized the same way wherever it executes.

## Read on

Tool contracts and error taxonomy, the dispatch path, credential mode, approvals, the co-location
admission rule, or anything a process must inject to host Tools.

## Skip

Individual Tool families (`packages/kv`, `apps/api/src/tools/**`), the model-facing tool set
(`apps/api/src/broker/tool-adapter.ts`), and Tool policy shapes (`packages/tool-broker`).

## Map

| Path | Owns |
| --- | --- |
| `src/types.ts` | `ToolDef`, `RequestContext`, `ToolCallResult`, `ToolErrorCode`, fault classes |
| `src/define.ts` | `defineApiTool` / `toToolDef` — declaration plus bound per-request context |
| `src/dispatcher.ts` | `RegistryToolDispatcher`: authorize → credential → entitlement → approve → execute |
| `src/timeout.ts`, `src/execution.ts` | Deadline and abort delivery; the attempt loop and effect settlement |
| `src/gate.ts` | `LiveToolGate`, autonomy mapping, agent authority layer, DLP rules |
| `src/eligibility.ts` | `localDispatchRefusal` — which Tools a non-control-plane process may run |
| `src/capability-restrictions.ts` | An Agent's authored restrictions, decided at offer and at dispatch |
| `src/catalog.ts` | `ToolCatalog` port, `InMemoryToolCatalog`, per-agent visibility |
| `src/ports.ts` | Injected capabilities: surfaces, agents, visibility, approvals, guardrails |
| `src/authority.ts` | `TurnAuthority` — what one Run may do, taken from the Run, plus the Agent |
| `src/approvals/` | `ApprovalsRepo` and `ToolApprovalService` |
| `src/credential-mode.ts` | Personal vs service credential resolution |
| `src/request.ts` | Reading the chat request Artifact; presentation context |

## Rules

- **A restriction is decided twice; only dispatch is the boundary.** `agentCanBeOfferedTool` trims
  the catalog for UX; `agentCapabilityDenial` runs inside `dispatch` before authority, approval and
  `execute`. A Soul-less host such as `apps/worker` composes no `agents` resolver and reads the
  Agent off `TurnAuthority.agent` instead, so dropping that field unenforces both it and autonomy.
- **A deadline must cancel, and an uncancelled deadline is not a plain failure.** Never race a
  Tool against a bare timer; the loser keeps mutating and its result is lost. `timeout.ts` aborts,
  waits `CANCELLATION_GRACE_MS` for an acknowledgement, and reports unacknowledged mutating work as
  `indeterminate`, which nothing may retry and `dispatcher.ts` settles `ambiguous`.
- **A Tool that needs longer declares it; the default is never raised for everyone.**
  `execution.ts` takes `definition.timeout.wallClockMs` over the host's option and over
  `DEFAULT_EXECUTE_TIMEOUT_MS`, because only the Tool knows what it does and these are written in
  code beside the handler. A Tool holding a socket must also pass `RequestContext.abortSignal` to
  its transport, or the ceiling abandons the Tool while its request stays on the wire.
- **`eligibility.ts` fails closed.** A process without a live Soul, a renderer registry or
  provider credential leases must not authorize a Tool that needs them. Widening the rule needs a
  reason why the weaker check is still the same check.
- **`ToolApprovalPort` exposes `decide` and `consume` only.** `consume` spends the one-use decision
  at the dispatch that executes it (I-13); `registerWait` mints a one-use resume token and must
  stay in the control plane — see `apps/worker/AGENTS.md`.
- No dependency on `@tulipfarm/agent-runtime` — it depends on this package's consumers' shape, not
  the reverse. Narrow structural types instead.
- A Tool with call-level classification is validated first; the derived action, mutation state,
  destination, Approval demand, retry policy, and effect policy govern the same immutable call.
- `scripts/tool-colocation.test.ts` pins who may host what; it fails the build on drift.
