# Secrets — Agent Conventions

`@tulipfarm/secrets` — encrypted secret storage with zero-downtime key rotation. Implements
`specs/SECRETS.md`. See root `AGENTS.md` for commands/lint.

## Public API (`src/index.ts`)

- **`SecretsService`** — high-level `get` / `set` / `list` / `delete` with an in-memory cache.
  Constructed with an `ActiveDek` (+ optional `legacyKeys` for pre-backfill rows).
- **`PgSecretRepo`** (+ type `SecretRepo`) — secret persistence; V1 store is PostgreSQL.
- **`PgDekRepo`** (+ type `DekRepo`) — wrapped-DEK persistence (`wrapped_deks` table).
- **`encryptSecret` / `decryptSecret`** — AES-256-GCM envelope codec.
- **Key manager** — `generateDek`, `wrapDek` / `unwrapDek`, `makeCanary` / `verifyCanary`,
  `loadOrProvisionActiveDek`, `rotateEnvKek`, `provisionRecoveryKey`, `recoverWithKey`,
  `KeyManagerError`, type `ActiveDek`.
- **`backfillSecretsToDek`** — migrate legacy (pre-envelope) secrets onto the DEK.
- **`loadEncryptionKeys`** (+ type `EncryptionKeys`) — reads the env KEK(s).
- **`assertValidSecretKey`** + `InvalidSecretKeyError` — key-name guard.
- **KMS port** (`src/ports/kms.ts`) — provider-neutral `KmsPort` (`wrap`/`unwrap`/`activeKey`)
  with opaque `MasterKeyRef` / `WrappedKey`; the master key never crosses the boundary and no
  provider SDK type leaks. Adapters: local managed keys, cloud KMS, or Vault-compatible services.
- Types: `SecretDoc`, `SecretEnvelopeFields`, `SecretMeta`, `SecretType`, `WrappedDekRow`, `KekLabel`.

## Model — envelope encryption (SEC-V1 key recovery)

- Each secret is encrypted under a single 32-byte **DEK** (random IV + auth tag, base64 envelope),
  and tagged with `secrets.dek_id`.
- The DEK is **wrapped** (same GCM codec) under one or more **KEKs**, stored in `wrapped_deks`:
  the `env` wrap (operational, = `ENCRYPTION_KEY`) carries a canary; the `recovery` wrap is the
  offline break-glass path.
- **Boot:** `loadOrProvisionActiveDek` unwraps the DEK under the env KEK and verifies the canary —
  fail-fast on a wrong/missing key or corruption. On a fresh DB it auto-provisions the DEK (so
  `npm run dev` just works); the recovery key and legacy backfill are explicit operator steps.
- **KEK rotation (cheap):** `decryptSecret`'s current→previous fall-through now lives in
  `unwrapDek` — set the new key as `ENCRYPTION_KEY`, the old as `ENCRYPTION_KEY_PREVIOUS`, run
  `keys rotate-kek`; secrets are never re-encrypted.
- **Recovery:** if `ENCRYPTION_KEY` is lost, set a fresh one and run `keys recover` with the offline
  recovery key — it unwraps the DEK from the recovery wrap and rebuilds the env wrap.
- **Legacy rows** (`dek_id IS NULL`, pre-upgrade) decrypt under `legacyKeys` until `keys backfill`
  re-encrypts them onto the DEK.
- **`SecretsService` cache:** TTL freshness plus a stale-grace window (logged when served stale).

## Operator CLI

`pnpm --filter @tulipfarm/api keys <cmd>`: `verify` (boot canary on demand), `show-recovery`
(mint + reveal the offline recovery key once), `rotate-kek`, `recover` (`RECOVERY_KEY=…`),
`backfill`. See `docs/runbooks/secrets-key-recovery.md`.

## How to extend

- **New secret backend:** implement `SecretRepo` (`list` / `findByKey` / `upsert` / `delete` /
  `listLegacyKeys`); keep `PgSecretRepo` as the reference. New DEK backend: implement `DekRepo`.
- **Always** call `assertValidSecretKey()` before any write — it blocks prototype-pollution names.
- Never log a DEK, recovery KEK, or decrypted value; surface failures as typed errors.

## Tests

Vitest, colocated unit (`crypto` / `keys` / `key-guard` / `service` / `key-manager` / `backfill`)
plus DB-level `apps/api/src/secrets/key-manager.pg.test.ts` (provision / rotate / recover /
canary fail-fast / backfill). Cover the round trip, malformed envelopes, KEK fall-through, the
legacy decrypt branch, backfill idempotency, and cache TTL / stale behavior.
