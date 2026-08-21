# `@tulipfarm/curator-host`

The Curator's server half: the code that decides *which* job exists, what it is allowed to read,
and whether an answer may be recorded. It sits between the pure reasoning contract
(`@tulipfarm/curator`) and the tables (`packages/storage/src/curator/`), and it exists as its own
package because none of it touches Fastify — `apps/api` keeps only routes and composition.

## Read on

Minting a job, starting or recovering its Run, resolving pinned context, or accepting model output.

## Skip

Prompts, output schemas and citation rules (`packages/curator`), SQL and table shapes
(`packages/storage/src/curator/`), the sweep and the model call (`apps/worker`).

## Map

| Path | Owns |
| --- | --- |
| `src/mint.ts` | `CuratorMinter` — provider preflight, claim-and-reserve via `CuratorMintStore`, `gateway.start()` under a per-job idempotency key, `recover()`, atomic `abandon()` |
| `src/host.ts` | `CuratorHost` — context pinning and drift detection, then revalidation of submitted output and exactly-once settlement |
| `src/recovery.ts` | `CuratorRecovery` — replays a mint that crashed before the gateway, frees a target whose Run died |

## Rules

- **No SQL here.** Domain packages reach the database through storage repositories
  (`docs/architecture/dependency-rules.md`).
- **Never mint a second job to fix a stuck one.** The stuck job already holds the target, the
  claimed work and the reservation; recovery replays `start()` under that job's own idempotency key.
- **Refusals throw, they do not return** — a mint refusal returned from inside the transaction
  commits the work claim behind a job that will never run. See `MintAbort` in storage.
- **Context is pinned on first resolution and never re-based.** If what the pin recorded has since
  moved, the job is retired (`context_drifted`); output validated against inputs it never saw
  proves nothing. Drift is judged **per section** at submit, so one moved section does not discard
  the rest of the answer.
- Age alone never kills a job. Only a job with no Run, or one whose Run can no longer make
  progress — terminal, or parked in `needs_reconciliation`, which nothing requeues — is touched.
  Retiring one closes its Run too, so no Run outlives the work it describes.
