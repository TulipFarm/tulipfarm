# 09 — L3: real database, one Turn end to end

**What to build:** The first end-to-end proof. One Chat Turn runs against a real database and the
Eval Soul, reaching a real model through the same port the L2 tier uses.

Investigation established this is cheaper than feared in one way and dearer in another: migrations
already run programmatically against in-process PGlite, so no Docker is needed, and no job queue is
required because the Chat executor is invoked synchronously — but the executor needs roughly a dozen
ports and reusable fakes exist for only two. Writing the rest is the bulk of the cost.

Two existing tests bracket the target: one runs a real database with real stores but no worker; the
other runs a real worker but no Chat submission. **The missing bridge between them is this ticket.**

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Migrations run programmatically against in-process PGlite; no Docker database
- [ ] The Chat executor's required ports are satisfied by **reusable** fakes, not inline stubs
- [ ] One Chat Turn runs end to end and reaches a real model through the same port L2 uses
- [ ] No job queue is stood up for a single Turn
- [ ] The fakes are shared and usable by other suites, not private to this one
