# Workspace lock contention

## Problem

`lockAuthorization` in `packages/access` is one lock per workspace. Shared
mode (`'read'`) lets many transactions run together. Exclusive mode (`'write'`)
stops every other transaction in the workspace until it commits.

Many frequent paths took `'write'` although they change no authorization
policy: sending a chat message, every reply transaction when workspace MCP is
on, MCP catalog reads, task runs and background jobs. One slow holder made
every other chat in the workspace wait. Each waiter kept a pool connection, so
a new send could fail with nothing saved.

Some transactions also took `'read'` first and `'write'` later on the same
transaction. Two of those deadlock, and the savepoint retry cannot help.

## Rule

- `'write'`: the transaction changes policy that a later authority read
  depends on. Membership, roles, teams, grants, audience, ownership,
  integration lifecycle and credentials, installations, settings.
- `'read'`: everything else. A data write must be ordered by a narrower lock on
  the item it changes: the chat row, the turn row, the run row, `lockTask`, a
  per-command advisory lock, or the integration row.
- A transaction never moves from `'read'` to `'write'`.

## Changes

### 1. Chat path

| Path                         | Before               | After | Narrow lock                     |
| ---------------------------- | -------------------- | ----- | ------------------------------- |
| Send message, layout action  | write                | read  | command advisory lock, chat row |
| Reply transactions           | write when MCP is on | read  | chat row, head turn row         |
| Internal conversation claim  | write                | read  | internal conversation row       |
| Task run and task tool steps | write when MCP is on | read  | `lockTask`, run row             |

### 2. Workspace MCP store

The store has three modes.

| Mode      | Workspace lock | Integration row | Used by                                                                                           |
| --------- | -------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `reading` | shared         | none            | list, status, grants, tools, selection, catalog, action views, source checks                      |
| `acting`  | shared         | `FOR UPDATE`    | propose, dispatch, recover, credential refresh                                                    |
| default   | exclusive      | `FOR UPDATE`    | create, grants, lifecycle, credential, tool review, selection, OAuth setup, hosting, confirmation |

Reads take no row lock, so a read can never wait behind an action or deadlock
with one. Dispatch checks the action again under the integration row lock
before it claims, so a stale read cannot cause a call.

### 3. Other frequent sites

Agent chat submit and retry, skill runs, follow-ups, plans, plan documents,
tasks, personal memory and file recent-use move to `'read'`, each with a
narrow lock. The member task limit is ordered by a per-member advisory lock
taken inside the capacity check. Task start keeps `'write'` when it claims an integration
selection.

These stay `'write'` because no narrow lock is proven yet: the files tree and
quota, secrets, knowledge jobs, table cleanup, drafts, project saves,
invitation expiry, Slack admission and the Bud assistant.

### 4. Capacity

Each API replica admits 8 workspace transactions at a time by default and
queues 1000 more (`maxConcurrentTransactions`, `maxQueue` in
`packages/workspace-storage/src/runtime.ts`). The queue was 100, which rejected
a burst with `queue_full`. A waiter leaves after `waitTimeoutMs`, so the queue
bound only caps memory. Connection pool sizes are deployment configuration and
change outside this repository.

## Measured

`packages/conversations/test/bench/lock-contention.bench.mjs`: 100 sends to
100 chats in one workspace while one transaction holds the lock for 8 seconds.

| Code   | Holder mode | Saved | Failed | p95 wait |
| ------ | ----------- | ----- | ------ | -------- |
| Before | write       | 4     | 96     | 8103 ms  |
| After  | read        | 100   | 0      | 333 ms   |

## Not changed

Human admin and policy changes stay exclusive. They are rare and short.

## Checks

- Typecheck and lint.
- Concurrency test: many sends and reply steps in one workspace while a slow
  transaction holds the shared lock; none waits.
- Two concurrent dispatches of one MCP action produce one claim.
