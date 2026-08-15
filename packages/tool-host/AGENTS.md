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
| `src/gate.ts` | `LiveToolGate`, autonomy mapping, agent authority layer, DLP rules |
| `src/eligibility.ts` | `localDispatchRefusal` — which Tools a non-control-plane process may run |
| `src/catalog.ts` | `ToolCatalog` port, `InMemoryToolCatalog`, per-agent visibility |
| `src/ports.ts` | Injected capabilities: surfaces, agents, visibility, approvals, guardrails |
| `src/authority.ts` | `TurnAuthority` — what one Run may do, taken from the Run |
| `src/approvals/` | `ApprovalsRepo` and `ToolApprovalService` |
| `src/credential-mode.ts` | Personal vs service credential resolution |
| `src/request.ts` | Reading the chat request Artifact; presentation context |

## Rules

- **`eligibility.ts` fails closed.** A process without a live Soul, a renderer registry or
  provider credential leases must not authorize a Tool that needs them. Widening the rule needs a
  reason why the weaker check is still the same check.
- **`ToolApprovalPort` exposes only `decide`.** `registerWait` mints a one-use resume token and
  must stay in the control plane; see `apps/worker/AGENTS.md`.
- No dependency on `@tulipfarm/agent-runtime` — it depends on this package's consumers' shape, not
  the reverse. Narrow structural types instead.
- `scripts/tool-colocation.test.ts` pins who may host what; it fails the build on drift.
