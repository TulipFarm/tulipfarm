# Effect ledger: `idempotency_digest_mismatch` after a deploy

## Symptom

After deploying, a Run that was **suspended before the deploy** fails on resume with:

```
EffectLedgerError: idempotency_digest_mismatch
```

Fresh Runs started after the deploy are unaffected. Only Runs that reserved an effect under the
previous build and resumed under the new one fail.

## Why it happens

The effect ledger keys a reserved effect on `(businessId, idempotencyKey)` and then verifies the
replayed intent still matches, by comparing `intentDigest`
(`packages/tool-broker/src/effects/store.ts:111-116`).

The two values are derived from **different inputs**:

| Value | Derived from | Where |
| --- | --- | --- |
| `idempotencyKey` | Run slug + a digest of the Run *inputs* | `apps/api/src/runtime/invocation-callers.ts:34` |
| `intentDigest` | `toolId`, `toolVersion`, **`action`**, **`targetRefs`**, `arguments`, `destination`, `credentialRef` | `packages/tool-broker/src/intent.ts:92-102` |

So the key stays stable across a deploy while the digest does not. Any release that changes a Tool's
declared `action` string or its derived `targetRefs` — even with identical behaviour and identical
inputs — invalidates the digest of every already-reserved effect.

This is a **fail-closed** design: the ledger refuses to resume an effect it can no longer prove is
the same effect. It is doing its job. The operational cost is that a purely cosmetic vocabulary
change is indistinguishable from a semantic one.

## Releases that change the digest

Treat a release as digest-affecting when it changes any Tool's `authorization.action` or the targets
returned by a `targetsFor` derivation.

The **effect-plane hardening release** does both. Known changes:

| Tool | Field | Before | After |
| --- | --- | --- | --- |
| `update_memory` | action / target | `memory.remember` / `memory:<key>` | `memory.service.remember` / `memory.service:<key>` |
| `delete_memory` | action / target | `memory.forget` / `memory:<key>` | `memory.service.forget` / `memory.service:<key>` |
| `remember_correction` | action / target | `memory.remember` / `memory:<subject>` | `memory.lifecycle.remember` / `memory.lifecycle:<subject>` |
| `resource_hooks_get` | action | `soul.resource_type.read` | `soul.resource_type.hooks.read` |
| GitHub searches, `github_repository_list` | targets | `[]` | `github.installation:all-repositories` |
| `end_soul_batch`, `soul_repo_push` | targets | `[]` | `soul.repo:entire-repository` |
| Slack send | targets | `slack.channel:<name-or-id>` | `slack.channel:<id>` or `slack.channel_name:<name>` |
| Declarative (OpenAPI-imported) | action | bare operation name | `<slug>.<operation>` |

## Before deploying

Drain in-flight work rather than migrating digests. Digest values are deliberately not rewritable —
an operator who could rewrite them could also launder one effect into another.

1. Stop dispatching new Runs.
2. Let suspended Runs reach a terminal state, or cancel the ones that will not.
3. Confirm no reserved-but-unsettled effects remain for the affected Tools.
4. Deploy.

## If it already happened

The failure is safe: the mismatch is detected **before** dispatch, so the provider-side effect is
not performed twice. No external system has been touched by the failed resume.

Cancel and restart the affected Run. It will reserve a fresh effect under the new vocabulary. Do not
edit ledger rows by hand.

## Reducing future exposure

Including `action` and `targetRefs` in `intentDigest` is correct — they are exactly what
authorization was granted against, so a resumed effect whose action or target changed is no longer
the effect that was approved. The digest should not be narrowed to make deploys quieter.

The durable fix is to make `idempotencyKey` derive from the same canonical intent as the digest, so
a vocabulary change produces a *new* effect rather than a *conflicting* one. That is a change to the
Run/effect boundary and is deliberately out of scope here.
