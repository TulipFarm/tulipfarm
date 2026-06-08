# Secrets — Agent Conventions

`@tulipfarm/secrets` — encrypted secret storage with zero-downtime key rotation. Implements
`specs/SECRETS.md`. See root `AGENTS.md` for commands/lint.

## Public API (`src/index.ts`)

- **`SecretsService`** — high-level `get` / `set` / `list` / `delete` with an in-memory cache.
- **`PgSecretRepo`** (+ type `SecretRepo`) — persistence; the V1 store is PostgreSQL (caller injects a `Queryable`).
- **`encryptSecret` / `decryptSecret`** — AES-256-GCM envelope codec.
- **`loadEncryptionKeys`** (+ type `EncryptionKeys`) — reads keys from env.
- **`assertValidSecretKey`** + `InvalidSecretKeyError` — key-name guard.
- Types: `SecretDoc`, `SecretEnvelopeFields`, `SecretMeta`, `SecretType`.

## Model

- Each secret is encrypted per-record: random IV + auth tag, stored base64 in an envelope.
- **Rotation:** `decryptSecret` tries the current key, then the previous key
  (`ENCRYPTION_KEY` + `ENCRYPTION_KEY_PREVIOUS`) — reads survive a key swap with no downtime;
  writes always use the current key.
- **`SecretsService` cache:** TTL freshness plus a stale-grace window, so a brief datastore blip
  still serves the last known value (logged when served stale).

## How to extend

- **New backend:** implement the `SecretRepo` interface (`list` / `findByKey` / `upsert` /
  `delete`); keep `PgSecretRepo` as the reference.
- **Always** call `assertValidSecretKey()` before any write — it enforces the charset and blocks
  prototype-pollution names (`__proto__`, `prototype`, `constructor`).
- Rotate by shifting env keys (`PREVIOUS` ← old, current ← new); reads fall through automatically.
- Never log decrypted values; surface failures as the package's typed errors.

## Tests

Vitest, colocated (`crypto` / `keys` / `key-guard` / `service`). Cover the encrypt→decrypt round
trip, malformed envelopes, the dual-key rotation fall-through, and cache TTL / stale behavior.
