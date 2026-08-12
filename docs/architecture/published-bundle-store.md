# Published bundle store

Status: Accepted architecture contract

Scope: Soul publication, immutable execution bundles, active-version selection, runtime bundle
verification, and bundle retention.

This document extends ADR-007 (one Soul changeset and publication gateway), ADR-008 (Runs pin
immutable published bundles by content digest), ADR-009 (effective authority is an intersection),
and ADR-012 (Secrets are opaque references).

---

## 1. Framing principle

**Soul git is the editable draft. The published bundle store is the printing press.**

The Soul repository is where a business authors its Agents, Skills, Routines, Triggers, Roles,
AccessGrants, Integrations, and other governed artifacts. A Soul commit is still editable history:
the current checkout can move, and a later commit can change the same slug.

An execution bundle is one frozen copy of a committed Soul tree:

- compiled from a specific Soul commit;
- content-addressed by a canonical digest over its authored content — `bundleVersion`,
  `businessId`, `definitions`, and `assets`, but not its `changesetId` or `commitSha`, so
  byte-identical content published under two commits shares one digest;
- signed before storage — the signature binds the lineage (`changeset`, `commit`) that the digest
  omits, so tampering with either is still caught at verification;
- opened only after digest and signature verification;
- selected for runtime by `soul_active_bundles`.

A Run records the bundle digest and exact authored identity it was minted with. A Run that waits
for a week therefore keeps executing the behaviour it started with, even if the business publishes
new behaviour in the meantime.

That immutability is not an authorization rule. Authority has its own temporal rule: behaviour is
pinned, authority is live.

---

## 2. Why this store exists

Runtime must not read live Git. Git is an authoring substrate: it can be mid-merge, unavailable,
diverged from remote, or updated while a Run is parked. Runtime needs a small, verified, immutable
record that can be loaded without Git.

The store creates that boundary:

```
authoring path                         runtime path
-------------                          ------------
Soul git commit                        Run.bundle.digest
      |                                      |
      v                                      v
compile + sign                         verify digest + signature
      |                                      |
      v                                      v
content-addressed bundle               RuntimeBundle
      |                                      |
      v                                      v
soul_active_bundles alias              execute pinned behaviour
```

The read side already expected this boundary. The hardening made the write side real: every
successful Soul git commit now compiles, signs, publishes, and activates a bundle. There is no
separate publish button for an operator to remember.

---

## 3. What goes into a bundle

The membership rule is registry-derived, not regex-derived.

`packages/schema/src/artifacts.ts` owns `ARTIFACT_LAYOUTS`. `GitSoulTreeReader` asks that registry
to classify every path. A path that belongs to no known layout is ignored for publication; a
definition path that parses as a known artifact but fails validation aborts publication. Future
artifact kinds must extend the registry first, so the writer, reader, validator, and compiler share
one contract.

Bundle membership is independent from temporal semantics:

| Registry class | Bundled? | Runtime read rule |
| --- | --- | --- |
| Authored pinned artifacts | yes | read from the Run's pinned digest |
| Authored live artifacts (`Role`, `AccessGrant`) | yes | read from the active digest |
| Managed artifacts (`SkillsLock`, `IntegrationsLock`) | no | not authored runtime content |

This means authority artifacts are signed, versioned, projected, and auditable. They are not
excluded from the bundle. They are only read from a different digest.

Companion files are also registry-derived. `hooks.ts`, `instructions.md`, Skill prose/assets,
Integration specs, and similar governed files are included according to the artifact's declared
companions. The compiler applies count, per-asset size, total-size, UTF-8, and secret-material
guards before anything reaches storage.

---

## 4. Pinned versus live

Temporal class answers one question:

**Which digest does this read use?**

It does not answer "is this artifact bundled?"

| Temporal class | Kinds | Why |
| --- | --- | --- |
| `pinned` | behaviour/configuration | A waiting Run must replay its starting rules. |
| `live` | `Role`, `AccessGrant` | Revocation must affect parked and in-flight Runs. |

Pinned examples include Routine, Trigger, Agent, Skill, ToolContract, Guardrail, and ModelProfile.

The split exists because immutability and revocation pull in opposite directions.

```
Run minted Monday
  bundle.digest = A
  Routine / Agent / ToolContract reads -> digest A forever

Wednesday
  Role revoked
  active digest = B

Same Run resumes Thursday
  behaviour reads -> digest A
  authority reads  -> active digest B
```

This composes with ADR-009 because live authority can only narrow the effective decision. A newer
Role or AccessGrant cannot grant a Run more than its pinned ToolContract and Guardrail permit. A
revocation can deny work that an old bundle would otherwise have allowed.

`PinnedDefinitionLoader` enforces this boundary. It refuses `live` kinds and fails closed for
unknown kinds before opening the bundle. Future live readers must do the inverse: accept only live
kinds and read from the active digest.

---

## 5. Publication lifecycle

Publication begins after a successful Soul git commit. `GitSyncService` has one post-commit hook;
all commit helpers must flow through it.

```
Soul write succeeds
      |
      v
Git commit --------------+
      |                  |
      v                  |
read committed tree      |
      |                  |
      v                  |
compile bundle           |
      |                  |
      v                  |
sign with API key        |
      |                  |
      v                  |
store inert bundle blob  |
      |                  |
      v                  |
soul_publications: committed
outbox row enqueued
      |
      v
drain loop claims row with lease
      |
      v
project definitions -> stage projected
      |
      v
confirm stored digest -> stage stored
      |
      v
activate digest + mark consumed -> stage active
```

Each stage commits separately and is idempotent. If the process dies, the drain loop resumes from
the recorded stage. The previously active digest stays active until the final activation
transaction commits.

The durable stage rows are:

- `committed` — the bundle was written to content-addressed storage; publication and outbox rows
  exist.
- `projected` — `soul_definition_projections` was rebuilt from that bundle.
- `stored` — the bundle was read back and its digest matched.
- `active` — `soul_active_bundles` points at the digest and the outbox row is consumed.

Failures do not stop the queue head forever. A failed publication records `attempts`,
`failure_code`, and `next_attempt_at`. Retries use exponential backoff. After the maximum attempts,
the row is dead-lettered by setting `dead_lettered_at` and `dead_letter_reason`; its last successful
stage is retained for diagnosis. Later publications can still be claimed.

Activation is monotonic. Every publication gets a per-business `publication_sequence`; activation
can update `soul_active_bundles` only if the candidate sequence is not older than the current
sequence. Activation history is retained in `soul_bundle_activations`.

Losing that race is **not** a failure. A publication that arrives after a newer one already
activated is retired with the terminal outcome `superseded`: its outbox row is consumed, its retry
budget is untouched, and it never reaches the dead-letter queue. Retrying it would lose the same
race every time, and dead-lettering it would leave the deployment permanently `degraded` while
burying real breakage in the dead-letter queue. The store makes this distinguishable by design —
activation reports "no candidate" (the publication or its signed bundle is genuinely absent, a real
failure) separately from "candidate did not win" (benign supersession, raised as
`StaleActivationError`).

Both activation paths join `soul_execution_bundles`, so a digest whose bundle was never stored can
never become active. The in-memory store models this same constraint through an injected
bundle-existence probe, so the test double cannot accept a state PostgreSQL would reject.

---

## 6. Trust model

The API process is the publisher. The Worker is a verifier and executor.

```
                         trust boundary
      API process                              Worker process
  +----------------+                       +------------------+
  | Soul checkout  |                       | no Soul checkout  |
  | compiler       |                       | no Git sync       |
  | Ed25519        |                       | no private key    |
  | private key    |                       | Ed25519 public key|
  +-------+--------+                       +---------+--------+
          |                                          |
          | signed bundle                            | verified read
          v                                          v
  +----------------------------------------------------------+
  | PostgreSQL                                               |
  | soul_execution_bundles · soul_active_bundles · runs      |
  +----------------------------------------------------------+
```

Signing is asymmetric: Ed25519 private-key signing, public-key verification.

The previous HMAC shape made every verifier a signer. That is not acceptable for a Worker, because
the Worker executes untrusted Routine and Tool code. A compromised Worker may read the public key,
but it cannot forge a bundle.

Verification is fail-closed:

- unsupported bundle version is rejected;
- digest mismatch (tampered content) is rejected;
- lineage tampering (`changeset` or `commit`) is caught by the signature, which binds both even
  though the digest omits them;
- unknown signature key id is rejected;
- invalid signature is rejected.

The verifier accepts multiple trusted public keys, selected by `keyId`, so key rotation can keep
old bundle digests readable while new publications use a new signing key.

---

## 7. Storage and retention

The store is append-first:

- `soul_execution_bundles` stores signed, content-addressed bundles, one row per distinct content
  digest. Because the digest omits lineage, republishing byte-identical content under a new commit
  collides on `UNIQUE (business_id, digest)` and is accepted idempotently — the first stored copy
  wins and stays authoritative, so a no-op or lineage-only commit adds no duplicate bundle row;
- `soul_publications` stores provenance, stage, actor, retry, and dead-letter state;
- `soul_publication_outbox` stores the durable drain request and lease;
- `soul_definition_projections` stores queryable definition metadata for the active business;
- `soul_active_bundles` stores the current digest;
- `soul_bundle_activations` stores activation history.

Every publication has `actor_principal_id`. Anonymous publication is rejected. Migration 48 adds
the provenance, lease, activation-history, and retention constraints around the original tables.

Retention may delete only bundles that no durable reader can need. A bundle is not safe to delete
when any of these still reference it:

- the active alias;
- activation history;
- any Run whose `bundle.digest` names it;
- any Audit event whose `bundle_digest` names it;
- any non-dead-lettered publication still in flight.

Only old, unreferenced bundles are candidates for `deleteUnreferencedBundles`, and deletion is
limited per call.

---

## 8. Secret reference contract

Soul stores opaque Secret references, never Secret values.

The canonical shape is `SECRET_REFERENCE_PATTERN` in
`packages/schema/src/definitions/common.ts`. Trigger schemas, Integration schemas, and the bundle
compiler all use that one source. The compiler also scans for likely credential material by field
name and by known token/private-key patterns before storage.

This avoids an authorable-but-unpublishable trap. If a schema accepted `webhook.github.secret` but
the compiler required `secret://webhook/github/secret`, one bad Trigger could wedge all later
auto-publication for that business. One contract prevents that drift.

---

## 9. Operating it

Start with the alias:

```sql
SELECT business_id, digest, activation_sequence, activated_at, activated_by_principal_id
FROM soul_active_bundles
ORDER BY activated_at DESC;
```

If a Soul commit happened but no new digest is active, inspect publications:

```sql
SELECT changeset_id, business_id, digest, stage, actor_principal_id, attempts,
       next_attempt_at, failure_code, dead_lettered_at, dead_letter_reason, created_at
FROM soul_publications
ORDER BY created_at DESC;
```

Then inspect the drain handoff:

```sql
SELECT id, business_id, changeset_id, topic, consumed_by, consumed_at,
       claimed_by, claimed_at, claim_lease_expires_at, created_at
FROM soul_publication_outbox
WHERE consumed_by IS NULL
ORDER BY created_at, id;
```

Read the fields this way:

- No active row: check `soul_publications`. No commit has published, or the first publication is
  failing.
- `stage = committed`: check API logs and `failure_code`. Compile/sign/store worked; projection
  has not completed.
- `stage = projected`: check the bundle store row for `digest`. Projection wrote; stored-bundle
  confirmation failed.
- `stage = stored` with no `failure_code` and its outbox row consumed: this publication was
  superseded by a newer one. Expected and benign; no action.
- `stage = stored` with a `failure_code`: check `soul_active_bundles` and activation constraints.
  Activation is genuinely failing — most often the signed bundle row is missing for the digest.
- `dead_lettered_at IS NOT NULL`: read `dead_letter_reason`. The publication exceeded its retry
  budget. Supersession never appears here.
- `claimed_by` with expired lease: check drain loop logs. A drainer crashed; the row is
  reclaimable after the lease.

The API drains on boot and then on a short interval. If rows remain due and unclaimed, check for
`Soul publication drain failed` in API logs. If rows are claimed repeatedly and fail, fix the cause
reported by `failure_code`; do not hand-edit the active alias.

For Routines specifically, a missing or invalid active publication means no Run should be minted.
That is correct: runtime must not fall back to the live Soul checkout or an old in-process registry.

---

## 10. Invariants

- Bundle tree reading is registry-derived from `ARTIFACT_LAYOUTS`; never add regex path classifiers
  for artifact membership.
- `temporalClass` selects the read digest only; it never excludes an artifact from signing,
  versioning, or audit.
- Authority artifacts are bundled but read live.
- The API may hold the Ed25519 private key; the Worker may hold only public verification keys.
- Unknown bundle versions, digests, artifact kinds, and signature key ids fail closed.
- A publication failure never partially activates a bundle.
- Retention never deletes a bundle referenced by a Run, activation, Audit event, active alias, or
  in-flight publication.
