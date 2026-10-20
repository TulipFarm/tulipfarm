# Memory-core Phase 1 status

**Stopped at M0: platform SQL fails on the requested bare cluster.**
No extraction milestone is complete. No runtime code or existing test changed.

At source commit `fc6bc0ba4f76226fff1e62c6b155eaabaf8d4559`, before any
runtime or test changes, `packages/knowledge/test/defaults-gate.integration.mjs`
failed its assertion at line 191. The old-storage test expected
`{intentId: '', created: false}` but received a nonempty intent ID with
`created: true`. The complete evidence is in
`M0-packages-knowledge-test-defaults-gate.integration.mjs.tap`.

The user accepted that original failure as a known squashed-baseline failure
and authorized resuming M0. It must remain identical at later milestones.
No test was edited, fixed, weakened, or marked skipped.

The user then classified the Compose capacity failure as an environment
precondition and required rerunning the whole integration baseline on a
separate bare PostgreSQL container. That container started healthy on
`127.0.0.1:55432`, with the same pgvector image, no `init.sql` mount, and only
the `postgres` non-system role.

The first rerun file, `packages/knowledge/test/retrieval-baseline.integration.mjs`,
failed at line 22 while loading the platform baseline:
`role "tulipfarm" does not exist`, SQLSTATE `42704`.
`apps/database/migrations/0001_baseline.sql:734` grants rights to that role
unconditionally. The capacity test requires the same role to be absent after
loading that baseline. No test, SQL, or role workaround was applied.
Full output: `M0-bare-packages-knowledge-test-retrieval-baseline.integration.mjs.tap`.

This new bare-cluster failure triggers the user's stop rule. It is not on
the accepted squashed-baseline failure list. The full rerun and the golden
ranking snapshot remain incomplete. Earlier successful Compose measurements
are historical only, not a final common-environment M0 baseline.

See [M0](M0.md) for exact environment commands, earlier counts and benchmark
numbers, the accepted failure assertion, and the new setup failure.

All containers, volumes, and networks created for the original, resumed,
and bare-cluster attempts were removed. M1 and later milestones were not
started. No GitHub or other remote operation was performed.
