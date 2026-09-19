# MCP Integration services

Owns non-secret server setup, reviewed capability policy, and governed capability access.
Protocol transports remain in `@tulipfarm/mcp`; account authority remains in `../accounts/`.

## Read on / Skip

- Read for server configuration, capability review, account-port composition, resources or prompts.
- Skip wire framing and OAuth persistence; use their owning packages.

## Map

| Path | Owns |
| --- | --- |
| `definition.ts` | Soul-persisted server configuration and exact reviewed capabilities. |
| `ports.ts` | Injected Soul store, account authority, protocol session and audit boundaries. |
| `service.ts` | Discovery, explicit review, revision checks and authorized disclosure. |
| `tool-contract.ts` | Re-exports shared schema-owned Tool derivation so live registration and published contracts have identical IDs and revisions. |
| `tool-error.ts` | Bounded provider-error classification and fixed operator explanations; advisory only, never effect or retry policy. |
| `transport.ts` | Host fetch with validated, pinned DNS answers for streaming remote MCP traffic. |
| `errors.ts` | Safe, distinct setup, consent, selection and access failures. |

## Rules

- Discovery enables nothing. Server annotations never determine authority or mutation policy.
- Changing server configuration clears the reviewed capability set.
- Integration configuration reserves `github` and `slack` for native channels; this is not a
  restriction on protocol-level server IDs.
- A fresh discovery must match the approved capability digest before use.
- Account selection is an injected policy, never inferred from model arguments.
- `McpAccountAccess.use` keeps connect, requests and close inside the host's credential lease.
  It must install account admission before every protocol request.
- Account bindings and server revisions are frozen before action Approval, then rechecked.
- Resources and prompts return untrusted content; rendering a prompt does not execute it.
- Mutating Tool execution belongs to the existing Tool host and EffectDispatcher. No HTTP
  endpoint may call a Tool directly.
- Uncertain provider mutations never receive an automatic retry.
- Persist definitions through the injected SoulWriter store, never direct filesystem writes.
