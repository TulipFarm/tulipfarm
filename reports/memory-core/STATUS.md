# Memory-core Phase 1 status

**M0 complete in `f276abf`; M1 in `fbb1642`; M2 in `667a34f`. M3 is complete.**

M3 introduces the provider, summarizer, clock, telemetry, feature-flag, and
usage-meter ports. All 34 scoped build/typecheck tasks, the five serial unit
suites (615 tests: 614 passes and one original skip), focused port checks,
and lint passed. All 222 integration entry points match the refined M0
policy: 1,239 tests, 1,131 passes, 102 observed known failures, six original
skips, no cancellations. Both frozen ranking snapshots are unchanged.
The known Temporal retry assertion passed this run, as its proved flaky
rule permits.

The audit comparison's generated-label/order variation reproduced in all
five M3 and all five detached M2 runs. Complete 104-row comparisons preserve
every field, multiplicity, identity relationship, and timestamp ordering.
Only the proved random-UUID row ordering varies; the same line-350
failure remains required. All 78 policy checks pass.
See [M3](M3.md) and the annotated [M0](M0.md).

M2 moves all parser and chunking implementations into core, retains all old
Knowledge exports, and removes the Conversations-to-Knowledge runtime edge.
All 204 moved parser tests run from core with unchanged assertions. Exact
move checks, all five serial unit suites, scoped build/typecheck, and lint
pass. All 222 integration entry points match the refined M0 policy:
1,239 tests, 1,130 passes, 103 observed known failures, six original skips,
and no cancellations. Both ranking snapshots are unchanged.
See [M2](M2.md) for changes, benchmarks, and completed receipts.

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
was copied and verified. M1's owned Compose project was removed
(`M1-final-cleanup.tap`); it was restored for M2's integration comparison.
No remote action was performed and no earlier commit was amended.
