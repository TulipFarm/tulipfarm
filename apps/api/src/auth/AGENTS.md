# Auth Domain — Agent Conventions

Authentication for the API: sessions, CSRF, passwords, and API tokens. This is the densest
`apps/api` domain — it inherits the route/test conventions in `apps/api/AGENTS.md` and the
OpenAPI schema rule in the root `AGENTS.md`.

## Module map

| File | Role |
| --- | --- |
| `passwords.ts` | Password hashing + verification. |
| `session-store.ts` | Server-side session store (issue / get / destroy, TTL). |
| `csrf.ts` | CSRF token issue / verify for cookie-session requests. |
| `api-tokens.ts` | API token mint + `hashToken` + repo lookup by hash. |
| `invites.ts` | Invite links: issue / preview / redeem, hash-only storage, single-use consume. |
| `users.ts` | `UserRepo` / `UserDoc`. |
| `middleware.ts` | `makeRequireAuth({ store, userRepo, tokenRepo, apiClientRepo })` → `requireAuth` PreHandler. |
| `schemas.ts` | Shared JSON Schemas for auth routes — import, don't inline. |
| `routes/` | `registerAuthRoutes` (index) → `registerSessionRoutes`, `registerTokenRoutes`, `registerAdminUserRoutes`. |

## How `requireAuth` resolves a request

1. Session cookie `tf_sid` → `session-store` → `UserRepo.findById`.
2. Else `Authorization: Bearer tfc_<clientId>.<secret>` → API client (service identity).
3. Else `Authorization: Bearer <token>` → `findByHash(hashToken(raw))`.
4. Else `401 { error: "unauthorized" }`.

Every success sets both `req.user` (legacy) and `req.principal` (`RequestPrincipal`, see
`../identity/principal.ts`). Every denial logs `{ event: "auth.denied", reason, credential }` and
returns the same opaque `401` — disabled, expired, and unknown are indistinguishable to callers.

Sessions carry the auth methods used and a session-bound CSRF token; `rotateSession` replaces the
id on login and on step-up (session fixation). See `../identity/AGENTS.md`.

## Invite links

An admin never mints, sees, or relays a password. `POST /api/v1/users` creates a `member` with
`status = "invited"` and a **null** `password_hash`, and returns one invite link; the invited person
chooses their own password by redeeming it (`POST /api/v1/auth/invites/accept`), which activates the
account and signs them in. `POST /api/v1/users/:id/invite` re-issues, revoking whatever was
outstanding — for an account that has not accepted this replaces a lost link, and for an active one
it is the **password recovery path**, since there is no email to send a reset to.

The token is a 32-byte random secret stored only as its SHA-256 hash and consumed atomically. Unlike
a channel bind link (`../identity/channel-link.ts`) it carries no claims, so there is nothing to
sign: the token *is* the secret and the row *is* the authority — which is also what makes an
outstanding invite revocable. Preview and accept take the token in the **body**, and the web link
carries it in the URL **fragment**, so it never reaches an access log or a referrer header.

Two rules keep a passwordless account from authenticating: `userAsAuthzPrincipal` maps anything but
`active` to `disabled` (allowlist-shaped, so a future status cannot default in), and login refuses a
null `passwordHash` after burning the dummy verification, so "invited" costs the same as "unknown".

Status follows from whether a credential exists, so two admin operations resolve rather than obey:
`PATCH /users/:id/status` re-enabling an account that never accepted returns `invited`, not the
requested `active`, and re-issuing for a `disabled` account is a `400` — a link that would restore
an identity an admin switched off is not a link worth minting. Both are visible in the OpenAPI
description, since the response status can differ from the requested one.

Preview and accept are **CSRF-exempt** alongside login (`csrf.ts`). This is not incidental: an
invite is redeemed in whatever browser opened the link, which in the recovery case is often one
still holding a live session, and the hook only skips when *no* session cookie is present. Gating on
that would 403 exactly the person the link was issued to. Accept rotates the session, which is what
contains the fixation risk the exemption opens.

`POST /api/v1/auth/change-password` is self-service only and requires the **current** password — a
stolen session must not be able to lock the owner out. There is no forced-reset gate: nothing mints
a password on a user's behalf any more, so there is nothing to force.

## Conventions

- Protected routes take `requireAuth` as the last handler arg and declare
  `security: [{ sessionCookie: [] }, { bearerToken: [] }]` in their schema (root `AGENTS.md`).
- **Never store secrets in plaintext** — hash passwords and tokens; look tokens up by hash.
- Shared response shapes live in `schemas.ts`; reuse them across routes.

## How to extend

- **New auth method** (e.g. OAuth): add `<method>.ts`, teach `middleware.ts` to recognize it,
  and register routes under `routes/`.
- **New token type / scope:** extend `api-tokens.ts` + the token routes; keep hash-only storage.

## Tests

Per `apps/api/AGENTS.md`: `buildApp` + Fastify `inject` (never a real server). Fakes implement
the real repo/store interfaces. Colocated `*.test.ts` already cover passwords, csrf, api-tokens,
session-store, and routes.
