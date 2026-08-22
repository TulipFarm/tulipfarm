# Identity domain

Hardened auth surfaces layered on `auth/`: typed principals, OIDC, MFA step-up,
API clients, external identity mappings, and channel bind links.

## Read on / Skip

- **Read on if** you touch `req.principal`, OIDC, MFA/step-up, service identities, external
  identity mappings, or Slack-style channel account binding.
- **Skip if** you touch passwords, sessions, CSRF, invites, users, or user API tokens; read
  [`../auth/AGENTS.md`](../auth/AGENTS.md) instead.

## Map

| Path | Owns |
| --- | --- |
| `principal.ts` | `RequestPrincipal` and authz adapters. |
| `oidc.ts` | OIDC provider port, PKCE, one-use `state`/`nonce`, MFA claim checks. |
| `step-up.ts` | MFA verifier registry, step-up evaluation, `makeRequireStepUp`. |
| `api-clients.ts` | Service identities and `tfc_<clientId>.<secret>` bearer credentials. |
| `external-links.ts` | External identity mappings and one-use link tokens. |
| `channel-link.ts` | Signed channel bind link issue, preview, and redemption. |
| `routes.ts` | `registerIdentityRoutes(app, deps, requireAuth)`. |

## Rules

- New request code should read `req.principal`; `req.user` exists only for legacy auth routes.
- Default deny: no verifier, mapping, or valid active principal means the same opaque `401`.
- API client secrets and link tokens are hash-only and compared with `timingSafeEqual`.
- OIDC `state` and link tokens are consumed atomically so replay fails.
- OIDC/link errors expose only coarse reasons; provider detail must not reach responses or logs.
- Channel senders live in `external_identity_mappings` with the Integration slug as provider.
- A mapping's `verifiedVia` decides whether it confers **authority**, separately from whether it
  identifies a chat sender. `PROVEN_LINK_VERIFICATION` in `external-links.ts` is the only list;
  `manifest_email` and `null` are excluded because a provider-asserted email is controlled by the
  counterparty org, not by us.
- Anything deciding what a principal may reach reads `listProvenMappingsForUser`, never
  `listMappingsForUser`. The filter is in SQL so a new call site cannot omit it. Both
  `knowledge-sources/live-authorization.ts` ports and `internal/github-entitlement.ts` depend on
  this; `listMappingsForUser` is for display and identity questions only.
- Identifying a sender and empowering them are separate questions, so `IngressIdentityResolver`
  returns `principalKind`/`principalId`/`principalRef` alongside `user`. Anything conferring
  authority — Surface interactions, approval decisions, the resolve route — reads those. `user` is
  for routing only.
- Channel bind links are HMAC credentials with `{slug, senderId, issuedAt, nonce}`, no account,
  15-minute expiry, body-only token transport, and authenticated explicit redemption.
- Authentication and privilege elevation rotate the session id. Do not use the legacy
  `SessionStore.create()` shim in product code because its CSRF token is unbound.
