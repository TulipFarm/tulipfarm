# Backup, restore, and rolling-upgrade operations

The supported recovery set is one consistent checkpoint containing PostgreSQL, encrypted blob
data, the Soul Git repository, and external key-provider metadata. PostgreSQL remains the
correctness boundary; the other components are restored before workers are admitted.

The reference production posture is an RPO of at most five minutes and RTO of at most one hour.
These are deployment reference targets, not contractual SLAs. Every drill records the hardware,
storage provider, database size, backup time, restore time, PostgreSQL LSN, Soul head, blob and key
metadata digests, waiting Run count, ambiguous effect count, and audit tail hash.

## Operator flow

1. Quiesce new ingress while allowing leased work to drain.
2. Run `backup.sh` with `DATABASE_URL`, `SOUL_PATH`, `BLOB_PATH`, and `KEY_METADATA_PATH`.
3. Run `drill.sh <archive>` for integrity preflight.
4. Use an isolated database and `--execute --confirm "DRILL"` for the full restore drill.
5. Compare pre/post recovery evidence with `assertRestoreEquivalent`.
6. Exercise a waiting Run, reconcile an ambiguous effect, verify the audit chain, and perform a
   denied-access smoke check.

Restore never calls the development reset path. An executing restore requires both an isolated
target and the exact `--confirm "RESTORE"` token.

## Rolling upgrades

Migrations are additive and idempotent. A database schema accepts its current worker version and
the immediately previous worker version. Stop claiming new work, let active leases finish or
expire, apply the migration once, start new workers, verify readiness, then retire old workers.
Rollback reactivates the previous binary only while the database remains inside that one-version
window; destructive down-migrations are not supported.
