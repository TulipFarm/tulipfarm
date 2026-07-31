# Sandbox — Agent Conventions

`@tulipfarm/sandbox` — isolated execution request contract, backend ports, workspace/assets, and
egress and compute controls. **Today:** `src/ports/` defines the provider-neutral `SandboxPort`,
`SandboxIsolationAttestation`, and `assertProductionSandbox` gate (rejects local/SSH and any
non-strong-isolation backend for production); `src/hooks/` holds the isolated-vm executor. tsconfig
extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## `src/hooks/` — the isolated-vm executor

One implementation, shared by every host that runs untrusted source (API resource hooks, Worker
ingress classification). Moved here from `apps/api/src/hooks/` — do not reintroduce a second copy.

| File | What |
| --- | --- |
| `protocol.ts` | `WorkerRequest`/`WorkerResponse` — a wire contract across threads and bundles; changing it is a breaking change. |
| `analyzer.ts` | `analyzeHook` static pre-filter. A cheap first pass, **not** the isolation boundary. |
| `isolate.ts` | `runExpression` / `runRoutineHook` / `runResourceHook` — the isolate itself, plus the `ResourceLookup` port. |
| `worker-host.ts` | `serveHookRequests(options)` — serves requests on a worker thread with the capabilities the host grants. |
| `worker.ts` | Default entrypoint granting **nothing**. Use it unless a capability is genuinely needed. |
| `executor.ts` | `HookExecutor` (thread lifecycle, timeouts, circuit breaker) + `resolveHookWorkerPath`. |

**Capabilities are granted at the call site, never inside the package.** An application that needs
the isolate to reach something ships its own entrypoint module calling `serveHookRequests` with
that one port, and passes its path as `HookExecutorOptions.workerPath`. The API grants a read-only
resource lookup (`apps/api/src/hooks/hook-worker.ts`); the Worker grants nothing. Adding a
capability means adding a port here and a grant there — never a flag that silently widens reach.

`resolveHookWorkerPath(dir, basename)` prefers a bundled `.cjs` sibling and falls back to `.ts`
(run under `tsx`), so the same code path works in a built image and in tests.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Production
composition must inject an isolated microVM/service backend; local execution is never a
production isolation boundary.
