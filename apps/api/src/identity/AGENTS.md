# Identity Domain — Agent Conventions

Hardened authentication surfaces layered on `auth/`: OIDC login, MFA step-up, API clients
(service identities), and external identity links. Inherits the route/test conventions in
`apps/api/AGENTS.md` and the OpenAPI schema rule in the root `AGENTS.md`.

## Module map

| File | Role |
| --- | --- |
| `principal.ts` | `RequestPrincipal` (the typed principal every request resolves to) + authz adapters. |
| `oidc.ts` | `OidcProvider` port, PKCE + one-use `state`/`nonce` auth requests, `claimsProveMfa`. |
| `step-up.ts` | `MfaVerifierRegistry`, `evaluateStepUp`, `makeRequireStepUp`. |
| `api-clients.ts` | Service identities; `tfc_<clientId>.<secret>` bearer credentials, hash-only storage. |
| `external-links.ts` | External identity mappings + one-use link tokens. |
| `routes.ts` | `registerIdentityRoutes(app, deps, requireAuth)`. |

## Rules

- **Every credential resolves to `req.principal`** (`RequestPrincipal`). `req.user` stays for
  existing routes; new code should read `req.principal`.
- **Default deny.** No verifier registered → step-up fails. No mapping → external subject denied.
  Unknown/disabled/expired principal → the same opaque `401 { error: "unauthorized" }`.
- **Hash-only secrets.** API client secrets and link tokens are stored hashed (`hashToken`) and
  looked up by hash; comparisons use `timingSafeEqual`.
- **One-use server state.** OIDC `state` and link tokens are consumed atomically
  (`UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING *`) so a replayed
  callback or token fails.
- **Opaque errors.** `OidcDeniedError` / `LinkRedemptionDeniedError` carry a coarse `reason`;
  provider detail never reaches the response or the log line.

## Sessions and CSRF

Authentication and privilege elevation rotate the session id (`rotateSession`) — a pre-planted id
is never upgraded. Sessions issued by `issue()` carry a session-bound CSRF token; the legacy
`SessionStore.create()` shim leaves it unbound (plain double-submit) and must not be used by
product code.
