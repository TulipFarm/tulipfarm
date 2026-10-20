# Memory-core Phase 1 status

**M0 complete in `f276abf`. M1 complete; M2 is next.**

M1 creates `@tulipfarm/memory-core`, moves the three browser-safe contract
implementations without changing their definitions, keeps all old export
paths, and adds the CI lint fence. No existing test, schema, permission,
ranking, API, or runtime policy changed.

Scoped build/typecheck, repository lint, and all five serial unit suites
passed. Both ranking snapshots replay unchanged. All 222 original integration
entry points completed and match the refined baseline policy:

| Suite         | Files | Tests | Pass | Observed known failures | Original skips |
| ------------- | ----: | ----: | ---: | ----------------------: | -------------: |
| knowledge     |    28 |   257 |  254 |                       3 |              0 |
| conversations |    40 |   163 |  148 |                      14 |              1 |
| api           |    80 |   328 |  291 |                      37 |              0 |
| worker        |    74 |   491 |  437 |                      49 |              5 |

Total: 1,239 tests, 1,130 passes, 103 observed known failures, six original
skips, and no cancellations. M0 observed one fewer failure because the
shared retry/backoff assertion passed in that original run.

The line-208 Temporal retry assertion failed on detached M0 as well as M1.
All five runs per tree are recorded, including Google versus Slack names.
Later changed Slack DM and MCP diagnostics also received five serial checks
per tree and reproduced before M1. Only their exact evidenced assertion
variants may pass or fail; all other known signatures stay strict.
The existing UUID-ordered inventory exception remains a proven multiset
comparison, not a general sorting rule. All 55 policy checks pass.

See [M0](M0.md) for the unchanged frozen baseline and accepted annotations,
and [M1](M1.md) for every repeated-run result, exact failure names, metrics,
commands, and receipts.

The brief's standing authority resolves unexpected failures through a
five-versus-five comparison against the last local milestone. A current-only
failure requires fixing the refactor, never the test. Environment faults
are repaired; behavior-preserving design adjustments are documented.
Required behavior, schema, permission, or API changes and the M4/M5
security-review pauses remain hard stops.

The temporary `/tmp/memcore-m0-check` worktree was removed after its evidence
was copied and verified. The owned Compose project, volumes, and network
were removed (`M1-final-cleanup.tap`). No remote action was performed and
no earlier commit was amended.
