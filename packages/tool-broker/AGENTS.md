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
| `src/{approval-gate,broker,credential-dispatch}.ts` | Approval, orchestration, credentials. |
| `src/sandbox-adapter.ts`, `src/effects/` | Sandbox-backed Tools and effect ledger. |
| `test/security/` | Security matrices for Tool execution. |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `secrets`, `sandbox`, `storage`, and
  `observability`; see [dependency rules](../../docs/architecture/dependency-rules.md).
- Consume policy, DLP decisions, and credential leases; never reimplement or broaden them.
- Expose the Tool adapter interface that `@tulipfarm/integrations` implements; never import
  Integration implementations.
