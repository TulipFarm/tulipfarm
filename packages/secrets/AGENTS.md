# Secrets (`@tulipfarm/secrets`)

Encrypted Secret storage, DEK/KEK rotation, recovery, redaction, KMS ports, and short-lived
Credential leases for tool/runtime use.

## Read on / Skip
- **Read on if** you change Secret storage, encryption, keys, leases, KMS, or redaction.
- **Skip if** you only reference a Secret from a schema; read `../schema/AGENTS.md` instead.

## Map
| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/service.ts`, `src/repo.ts`, `src/dek-repo.ts` | Service cache and Postgres repos. |
| `src/crypto.ts`, `src/keys.ts`, `src/key-manager.ts` | Envelope encryption, DEK/KEK lifecycle. |
| `src/backfill.ts` | Legacy Secret migration to DEK-backed envelopes. |
| `src/broker.ts`, `src/lease.ts`, `src/providers.ts` | Scoped leases and current-value providers. |
| `src/redaction.ts`, `src/key-guard.ts` | Redaction and Secret key validation. |
| `src/registry.ts`, `src/integration-registry.ts` | Provider/integration Secret metadata. |
| `src/ports/` | Provider-neutral KMS port; no SDK types cross it. |

## Rules
- Each Secret is encrypted under one 32-byte DEK and tagged with `secrets.dek_id`.
- DEKs are wrapped under KEKs in `wrapped_deks`: `env` (`ENCRYPTION_KEY`) has a canary;
  `recovery` is the offline break-glass path.
- Boot unwraps and canary-verifies the env DEK; wrong/missing keys or corruption fail fast.
- Fresh DBs auto-provision the DEK; recovery key creation and legacy backfill are explicit steps.
- KEK rotation never re-encrypts Secrets: set `ENCRYPTION_KEY_PREVIOUS`, run `keys rotate-kek`.
- Recovery sets a fresh `ENCRYPTION_KEY`, then `keys recover` unwraps via `RECOVERY_KEY`.
- Legacy rows (`dek_id IS NULL`) decrypt via `legacyKeys` until `keys backfill` moves them to DEK.
- `SecretsService` cache uses TTL plus stale-grace; stale serves are logged. Extending past the TTL
  requires a `findRevision` probe proving the row is unchanged — a rotation or deletion in another
  process refuses (`secret.stale_refused`), as does an unreadable probe.
- Always call `assertValidSecretKey()` before writes; it blocks prototype-pollution names.
- Never log a DEK, recovery KEK, or decrypted value; surface failures as typed errors.
- `SecretBroker` is default-deny, clamps TTL/uses, resolves values fresh on use, emits metadata
  only, and revokes by Secret, lease, or all.
- A network lease scope binds the caller, destination, Run, and active Skill as well as the exact
  Secret reference; scope equality is exact across every field.
- `SecretLease` is not serializable; plaintext may exist only inside `lease.use(cb)`. Returning it
  throws `SecretLeakError`; callback errors are re-thrown redacted.

Operator CLI: `pnpm --filter @tulipfarm/api keys <cmd>` (`verify`, `show-recovery`, `rotate-kek`,
`recover`, `backfill`). See [key recovery](../../docs/runbooks/secrets-key-recovery.md).
