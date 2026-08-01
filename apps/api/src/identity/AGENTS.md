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
| `channel-link.ts` | Binding a channel sender (Slack, Telegram, …) to an account: the signed bind link, its preview, and its redemption. |
| `routes.ts` | `registerIdentityRoutes(app, deps, requireAuth)`. |

## Channel links

A channel sender is an external identity like any other, so it is stored in
`external_identity_mappings` with the Integration slug as the provider — not in a table of its own,
which would be a second authority on the same question. `verified_via` records *how* the link was
established, because an auto-link from a provider-verified email and a human confirming a bind link
are not equally strong evidence and an audit has to tell them apart.

The bind link is a credential. It is HMAC-signed with a key from `@tulipfarm/secrets`, encodes only
`{slug, senderId, issuedAt, nonce}` — no account, since none is known when it is issued — expires in
15 minutes, and its nonce is consumed on redemption (`channel_bind_tokens`), so a replayed link
binds nothing. Redemption requires an authenticated session and an explicit confirm against a
preview naming both sides; the token travels in the **body**, never a query string, so it stays out
of access logs and referrer headers. Nothing outside this module ever sees an issued link — the
Worker is told only that the sender was unlinked.

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
