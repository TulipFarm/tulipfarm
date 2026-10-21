# Memory-core Phase 1 status

**M5 security review and UUID compatibility follow-up complete. Ready for M6.**

The user verified M5's SQL/parameters, access order, transaction scoping
and leases equivalent to `3d5f606`, with no exploitable findings.
The approved follow-up restores Access's former lowercase transform for
all moved internal UUIDs, including internal citations and workspace IDs,
without changing the earlier browser contracts or importing Access into
core. Five regression tests were added; affected units, lint and all
36 scoped build/typecheck tasks passed. All 28 Knowledge integration files
match strictly: 257 tests, 254 passes, three exact known failures.
Original M5 receipts are preserved; see the follow-up section in [M5](M5.md).

The Google repair failure did not reproduce in five current/five baseline
runs. Hybrid session constraint errors were proved to arise from app/DB
clock skew, not changed timestamp code; after restarting the owned test
Postgres, final checks pass. No new flaky exception or SQL/schema/test
change was introduced. The owned Compose project is retained for M6.

M0 is in `f276abf`; M1 in `fbb1642`; M2 in `667a34f`; M3 in `6159003`.
M4 is in `3d5f606`. The user accepted its authorization equivalence and
the stricter invalid-Date guard. This worker did not run that review.
M5 moves Store, Search, and Embeddings into core behind opaque
tenant-runtime, typed repository, lexical-index, vector-index, and session
ports. `memory-postgres` owns their SQL; host permission decisions and
eligibility predicates remain in Knowledge. Old constructors and exports
forward unchanged. This worker has not run the M5 security review.

All 36 scoped build/typecheck tasks, lint (26 tooling tests), 78 strict
comparison-policy checks, and six serial unit suites passed: 666 tests,
665 passes, one original skip. All 222 integration entry points match the
agreed rules: 1,239 tests, 1,131 passes, 102 observed known failures,
six original skips, no cancellations. Both ranking snapshots are unchanged.
The proof preserves all 112 extracted SQL operations and bound arguments,
four host availability queries, fusion, and external lock resolutions.

The interrupted API dispatch timeout did not recur in five M5 or five
detached M4 runs. A later Slack progress assertion also did not recur in
its five-versus-five check. Original failed receipts and all 20 experiment
runs are retained; neither failure has an accepted exception. Both final
files meet the strict baseline. Their causes remain unproved, not claimed
as known baseline flakes.

For the M5 review, inspect tenant/schema mapping, admission and lock order,
eligibility SQL on candidate/page reads, revision/publication/epoch/proof
binding and final evidence checks, embedding pre-dispatch and publication
authorization, and transaction/rollback/error behavior. Schema, API
responses, ranking, embedding model/dimensions, existing tests, Access,
Files, and Temporal are unchanged. See [M5](M5.md) for the full surface,
commands, counts, preserved diagnostics, and benchmarks.

The temporary M4 checkout was removed after all copied evidence was
verified byte-for-byte. The owned Compose containers, network, and volumes
were removed; see `M5-cleanup.tap`. M6 has not started. All commits remain
local and no earlier commit was amended.

M4 adds explicit allow/deny decisions and a storage-side eligibility port.
Review the new core decision/proof helpers and Knowledge adapters for
membership/source access, Files integrity and recursive provenance,
conversation readers/revision fences, current task-run binding, stored
and external proofs, embedding dispatch, and search eligibility.
Locks, SQL order, final evidence checks, and host denial identity remain
at their original call points. All 144 SQL literals are preserved.
Access, Files, app code, schema, API responses, ranking, model/dimensions,
Temporal, and the lockfile are unchanged. See [M4](M4.md) for the full
authorization-sensitive diff surface and callback receiver correction.

All 34 scoped build/typecheck tasks, lint, and five serial unit suites
passed: 638 tests, 637 passes, one original skip. All 222 integration
entry points match the agreed baseline rules: 1,239 tests, 1,131 passes,
102 observed known failures, six original skips, no cancellations.
Both frozen ranking snapshots are unchanged. No new M4 comparison
exception was needed.

Removed the owned Compose project, network and volumes after the final
integration run. No temporary baseline worktree remains; copied audit
receipts were verified before removal. See `M4-cleanup.tap`.

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
