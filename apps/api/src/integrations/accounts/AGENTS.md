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
| `audit.ts` | Production lifecycle/grant audit adapter; absent optional metadata is omitted, audit failures propagate. |
| `routes.ts` | Account CRUD, shared grants, and exact Chat account selection. |
| `schemas.ts` | Grant response schema with server-recomputed approval status. |
| `secret-metadata.ts` | Secrets-page labels from current account bindings; personal owner/shared management gates, never credential values. |
| `oauth-routes.ts` | Session-bound OAuth start and one-use callback routes. |
| `oauth-protocol.ts` | Adapter to the SDK-backed guarded OAuth client in `packages/mcp`. |
| `probe.ts` | Actual MCP initialization using scoped credentials and live authorization. |
| `setup-{routes,compose}.ts` | Authenticated durable Connect/Finish; read-only eligibility/full revision, progress and exact-account OAuth continuation lookup. |

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
- Token recovery uses account PATCH with replacement `values`: preserve the account ID, advance
  its revision, and probe before reporting active. Renaming/default changes never retry a probe.
- Setup POST reserves identity and freezes initial capabilities before publication; GET never advances
  it. Resume rechecks the original principal, exact account and current configuration authority.
- Unknown legacy empty policy is preserved unless a new admin/revision-bound intent records
  `legacyEmptyPolicyConsent`; old frozen intents cannot acquire it through resume.
