# Tool broker (`@tulipfarm/tool-broker`)
Tool catalog, typed intent, authorization/risk/approval pipeline, effect ledger, dry run,
credential dispatch, sandbox adaptation, and reconciliation.

## Read on / Skip
- **Read on if** you touch Tool definitions, catalog/search, intent contracts, risk, approvals,
  entitlement, credential leases, sandbox Tool execution, or effects.
- **Skip if** you implement integrations (`../integrations/AGENTS.md`), sandbox backends
  (`../sandbox/AGENTS.md`), Agent loops (`../agent-runtime/AGENTS.md`), or auth policy.

## Map
| Path | Owns |
| --- | --- |
| `src/{catalog,search,define,contract}.ts` | Tool registry, lookup, and adapter contracts. |
| `src/{intent,risk,authorize,entitlement}.ts` | Intent, risk, authorization, entitlement. |
| `src/targets.ts` | Contract-declared target derivation for hosts that hold documents, not code. |
| `src/{approval-gate,broker,credential-dispatch}.ts` | Approval, orchestration, credentials. |
| `src/sandbox-adapter.ts`, `src/effects/` | Sandbox-backed Tools and effect ledger. |
| `test/security/` | Security matrices for Tool execution. |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `secrets`, `sandbox`, `storage`, and
  `observability`; see [dependency rules](../../docs/architecture/dependency-rules.md).
- Consume policy, DLP decisions, and credential leases; never reimplement or broaden them.
- Expose the Tool adapter interface that `@tulipfarm/integrations` implements; never import
  Integration implementations.
- `EffectDispatcher` consults the mutation kill switch before recording an attempt, so a denied
  mutation leaves no attempt in the ledger. A dispatcher constructed without `mutationGuard` is
  outside the emergency stop; `scripts/mutation-kill-switch.test.ts` fails the build on one.
- A kill switch scope is only meaningful if the dispatch site fills the matching `MutationContext`
  field. Adding a scope kind means supplying its identity in `mutationIdentity` first, never after.
- `deriveContractTargets` refuses; it never returns `[]` for a target it failed to derive. An empty
  list is the gate's signal that a contract declares no per-object target at all, so conflating the
  two silently widens a decision from one object to every object of that type.
- `definitionForToolCall` is pure over validated arguments. A dynamic network Tool must classify
  before authorization; static `mutating: true` remains its conservative scheduling ceiling.
- The barrel lists every export by name. `export *` would republish internals — an adapter that
  performs an effect, a primitive that enforces a policy — the moment a file gains an export;
  `scripts/barrel-exports.test.ts` keeps this package and `integrations` explicit.
