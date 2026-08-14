# Sandbox (`@tulipfarm/sandbox`)
Isolated execution request contracts, backend ports, runtime profiles, workspace/assets, Hook
execution, and egress/compute controls.

## Read on / Skip
- **Read on if** you touch sandbox requests, backend attestation, production isolation gates,
  runtime profiles, development containers, Skill execution, or isolated-vm Hook execution.
- **Skip if** you touch Tool orchestration (`../tool-broker/AGENTS.md`), app-specific Hook grants
  (`../../apps/api/AGENTS.md`, `../../apps/worker/AGENTS.md`), or integration adapters.

## Map
| Path | Owns |
| --- | --- |
| `src/ports/`, `src/{backend,attestation}.ts` | SandboxPort and production checks. |
| `src/{request,runtime-profile,development-container}.ts` | Requests and runtime models. |
| `src/{skill-execution,guardrail}.ts` | Skill execution and sandbox guardrails. |
| `src/hooks/` | Shared isolated-vm Hook executor. |
| `test/security/` | Sandbox security checks. |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `storage`, and `observability`; see
  [dependency rules](../../docs/architecture/dependency-rules.md).
- Production composition must inject an isolated microVM/service backend. Local/SSH execution and
  non-strong isolation are never production boundaries; `assertProductionSandbox` rejects them.
- `src/hooks/` is the one implementation for untrusted source in API hooks and Worker ingress;
  do not reintroduce an app-local copy.
- Hook capabilities are granted at the app call site through a custom `serveHookRequests` entrypoint
  and `HookExecutorOptions.workerPath`, never by a widening flag inside this package.
- Default `src/hooks/worker.ts` grants nothing. Add a port here and an app grant there for any new
  capability.
- `src/hooks/protocol.ts` is a cross-thread/bundle wire contract; changing it is breaking.
- `analyzeHook` is only a cheap pre-filter, not the isolation boundary.
- `resolveHookWorkerPath(dir, basename)` prefers bundled `.cjs`, then `.ts` under `tsx`.
