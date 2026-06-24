# Runbook — Secrets Key Recovery & Rotation

How TulipFarm protects encrypted secrets, and the operator procedures for recovery and rotation.
Background: `apps/docs/content/docs/security/encryption.mdx`.

## Prerequisites

- Shell access to the machine running the TulipFarm API.
- `.env.local` (or equivalent) in scope so the process can read `DATABASE_URL` and `ENCRYPTION_KEY`.
- `node` and `pnpm` installed (same version as the project — check `.node-version`).
- The API checked out at the relevant version (`git status` should be clean or on the right commit).

## How it works (1 minute)

- Every secret is encrypted under a single **DEK** (Data Encryption Key).
- The DEK is wrapped under one or more **KEKs** and stored in `wrapped_deks`:
  - **`env` wrap** — wrapped under `ENCRYPTION_KEY` (the everyday operational key).
  - **`recovery` wrap** — wrapped under an offline **recovery key** you mint once.
- On boot the server unwraps the DEK under `ENCRYPTION_KEY` and verifies a canary. A wrong/missing
  key or corrupt data **fails boot loudly** rather than silently at first use.

All commands: `pnpm --filter @tulipfarm/api keys <command>` (reads `.env.local` + `DATABASE_URL`).

## One-time setup (do this in production)

A fresh install auto-provisions the DEK on first boot, so the app runs immediately. But until you
mint a recovery key, **`ENCRYPTION_KEY` is still a single point of failure.** Mint it once:

```bash
pnpm --filter @tulipfarm/api keys show-recovery
```

This prints the recovery key **once**. Store it offline (password manager / sealed vault). It is
never shown again and is never written to the database or environment. Verify state any time:

```bash
pnpm --filter @tulipfarm/api keys verify   # prints the active DEK + which wraps exist
```

## Procedure: ENCRYPTION_KEY is lost

Symptom: boot fails with `KeyManagerError` ("DEK unwrap failed: no KEK authenticated").

1. Generate a fresh key: `openssl rand -base64 32`, set it as `ENCRYPTION_KEY`.
2. Recover using your offline recovery key:
   ```bash
   RECOVERY_KEY=<the offline base64 key> pnpm --filter @tulipfarm/api keys recover
   ```
   This unwraps the DEK from the `recovery` wrap and rebuilds the `env` wrap under the fresh key.
3. `keys verify` → should report the active DEK with `env, recovery` wraps. Boot the app.

> If **both** `ENCRYPTION_KEY` and the recovery key are lost, the secrets are unrecoverable by
> design — re-enter them. (This is why minting and safeguarding the recovery key matters.)

## Procedure: rotate ENCRYPTION_KEY (planned)

Cheap — secrets are never re-encrypted, only the small DEK is re-wrapped.

1. Generate a new key. Set `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEY_PREVIOUS=<old>`.
2. `pnpm --filter @tulipfarm/api keys rotate-kek`
3. Verify, then remove `ENCRYPTION_KEY_PREVIOUS` from the environment:
   ```bash
   pnpm --filter @tulipfarm/api keys verify
   ```

## Procedure: migrate legacy secrets (after upgrading to envelope encryption)

Secrets written before this feature decrypt under `ENCRYPTION_KEY` directly (`dek_id IS NULL`) and
keep working. To move them onto the DEK:

```bash
pnpm --filter @tulipfarm/api keys backfill   # idempotent + resumable; reports migrated/failed
```

Verify all secrets migrated successfully by checking `dek_id IS NOT NULL` in the output, or run
`keys verify` to confirm the active DEK covers all wraps.

## API-token pepper (optional, separate from the above)

Set `API_TOKEN_PEPPER` (`openssl rand -base64 32`) to hash API tokens as
`HMAC-SHA256(token, pepper)` instead of bare SHA-256. Existing tokens keep working and upgrade
lazily on next use. The pepper is **not** part of the DEK/recovery scheme — losing it just means
re-issuing tokens.

> **One-way door:** once tokens have upgraded to the `v2:` (peppered) hash, removing or changing
> `API_TOKEN_PEPPER` breaks them. Set it once and keep it stable, or re-issue tokens.

## Safety notes

- The DEK and recovery key live in memory only — never log them.
- `keys recover` / `rotate-kek` re-wrap the same DEK; they never touch secret ciphertext.
- The `wrapped_deks` partial unique index guarantees at most one active `env` and one active
  `recovery` wrap.
