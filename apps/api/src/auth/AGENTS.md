# Auth domain

API authentication: sessions, CSRF, passwords, users, invites, API tokens, `requireAuth`,
and legacy `req.user` compatibility.

## Read on / Skip

- **Read on if** you touch login/logout, cookies, CSRF, passwords, invites, user admin routes,
  API tokens, or `makeRequireAuth`.
- **Skip if** you touch OIDC, MFA step-up, API clients, principals, or channel identity links;
  read [`../identity/AGENTS.md`](../identity/AGENTS.md) instead.

## Map

| Path | Owns |
| --- | --- |
| `routes/` | Auth route registration, split into session, token, and admin user routes. |
| `middleware.ts` | `makeRequireAuth`, credential resolution, `req.user` and `req.principal`. |
| `session-store.ts`, `csrf.ts` | Server-side sessions, session CSRF tokens, rotation support. |
| `passwords.ts`, `users.ts` | Password hashing/verification and `UserRepo` / `UserDoc`. |
| `api-tokens.ts` | User API token minting, hashing, lookup by hash. |
| `invites.ts` | Invite issue, preview, redeem, hash-only storage, single-use consume. |
| `schemas.ts` | Shared auth JSON Schemas. |

## Rules

- `requireAuth` checks `tf_sid`, then API client bearer credentials, then user API bearer tokens;
  every success sets `req.principal`, and legacy routes also get `req.user`.
- Auth denials return the same opaque `401 { error: "unauthorized" }`; disabled, expired, and
  unknown credentials must not be distinguishable to callers.
- Store passwords, invite tokens, and API tokens hash-only; look tokens up by hash.
- Login and step-up rotate the session id; product code must use bound-CSRF sessions.
- Admin-created users start as `invited` with `password_hash = null`; admins never mint, see, or
  relay passwords.
- Invite links are single-use and revocable. Preview/accept receive the token in the body; web
  links carry it in the URL fragment, not query strings.
- Invite preview/accept are CSRF-exempt with login; accept still rotates the session.
- Re-enabling an invited user returns `invited`; re-issuing for disabled is `400`.
- Password change is self-service only and requires the current password.
- Shared response schemas belong in `schemas.ts`.
