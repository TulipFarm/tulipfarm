# MCP account API

Durable personal/shared account management and browser OAuth over the Integration account policy.

## Read on / Skip

- Read for MCP account routes, credential probes, or OAuth composition.
- Skip protocol negotiation and SDK details; those belong to `packages/mcp`.

## Map

| Path | Owns |
| --- | --- |
| `compose.ts` | Account, Secret, OAuth persistence, lifecycle, and routes; returns the shared authorization policy for runtime composition. |
| `authorization.ts` | Active local-user, current Team membership, and declared shared-management gates. |
| `routes.ts` | Account CRUD, shared grants, and exact Chat account selection. |
| `schemas.ts` | Grant response schema with server-recomputed approval status. |
| `oauth-routes.ts` | Session-bound OAuth start and one-use callback routes. |
| `oauth-protocol.ts` | Adapter to the SDK-backed guarded OAuth client in `packages/mcp`. |
| `probe.ts` | Actual MCP initialization using scoped credentials and live authorization. |

## Rules

- `chatContext` must derive membership and audience from durable state, never request input.
- `grantSubject` loads current persisted Routine/Agent or sync configuration and computes its
  material digest; the request accepts only subject kind and ID.
- Shared management goes through the existing authorizer's `integration.accounts.manage`
  action. Personal mutations are owner-only even for administrators.
- OAuth callback origins come from configured public endpoints, never request headers.
- Guarded fetch executes inside the Secret callback. Do not return bearer headers or credential
  values from the callback.
- Credential probes establish MCP authentication, not a verified provider subject.
- Remote bearer credentials use the `accessToken` slot. Local environment slots must be declared
  in the approved server definition; host environment fallback is forbidden.
