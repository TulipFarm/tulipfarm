# 02 — Remove the old evals module

**What to build:** Delete the unused Agent-publication gating module so there is exactly one thing
in this repository called "eval" and no ambiguity about which is real.

Prefactor. It addresses an unrelated concern and has zero call sites outside its own test.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The module and its colocated test are removed
- [x] The package's public exports no longer mention it
- [x] Safety is proven by a repo-wide typecheck, not by running consumer suites — a broken consumer
      would be a compile error
- [x] Lint and typecheck pass
