# Shared workspace authorization

`Actor` is either `{ kind: 'human', userId, membershipId }` or `{ kind: 'agent', runId }`.
`resolveActor(transaction, principal)` accepts an authenticated user ID or a persisted actor.
The transaction is `{ client, schema }` and must already use READ COMMITTED.

Call `lockAuthorization(transaction)` before any authority reads. Policy writers call it with `'write'`.
The lock statement and permission reads remain separate so a waiter observes committed revocations.

`requireResourcePermission`, `canAccessResource`, and `requireResourceCreation` accept either actor.
`currentMember` and `resolveHuman` remain human-only operations for governance.
`requireCurrentActor` checks current human incarnation or persisted agent/run validity.

Agent authorization consumes the agent partition's `0007_agents.sql` tables. It intersects the live agent team grants, current limits, pinned activation, and run scope. Delegated runs also intersect the initiating human's current membership and permission. Scheduled runs also require their matching live schedule and scope. Admin status bypasses only the human team restriction. Disabled agents, revoked activations, terminal runs, replaced memberships, and mismatched schedules fail closed.

Creation grants use a destination team UUID with `table.create`. Record grants use the resource UUID with `table.row.create`, `table.row.read`, `table.row.update`, or `table.row.delete`. Schema management uses `table.schema.manage`. Team ownership alone grants no permission.

Confirmation must remain a separate authenticated human operation. This package supplies no confirmation, SQL, or credential tool.
