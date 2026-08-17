# 03 — Walking skeleton: one Eval Case, scripted model, printed Scorecard

**What to build:** The entire spine, end to end, for free. A maintainer runs `pnpm eval`; it loads a
one-Case Corpus, assembles Context with the **real** Context assembler, runs the **real** Tool loop
against a **scripted** model with faked Tools, evaluates deterministic Assertions, and prints a
Scorecard with a per-Case verdict.

No credential. No vendor. No cost. Every later ticket widens this bullet rather than replacing it.

**Why the assembler is in scope here.** The Tool loop receives messages that are *already assembled*
— Context assembly and guardrail composition happen above it. Attaching only at the loop would
measure the loop against hand-written prompts and would not notice a Context-assembly regression at
all. The assembler is pure and lives in the same package, so including it is cheap, but it decides
what an Eval Case must carry — which is why it belongs in the skeleton, not bolted on later.

Case shape, from the design prototype — the decision-bearing parts only, not a full schema:

```
EvalCase
  id            stable; appears in the Scorecard
  tier          "l2" | "l3"
  agent         which Agent in the Eval Soul answers
  input         the Message(s) that open the Conversation
  tools         L2 only: the faked Tool responses, in order
  expect        Assertion[]        deterministic, model-free
  rubric?       Judge criteria     only where prose quality is the point
  trials        default 1; raised for Cases used to measure the Noise Floor
```

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A new workspace hosts the eval framework, with its own `AGENTS.md` and a row in the root
      navigation table
- [x] `pnpm eval` executes a Corpus of one Case and prints a Scorecard with a per-Case verdict
- [x] Context comes from the real Context assembler — a change to assembly is visible in the result
- [x] The Tool loop under test is the real one; only the model and the Tools are scripted
- [x] Assertions are evaluated by a pure function, so a Case is data rather than code
- [x] The Corpus is content-hashed: a semantic edit changes the hash, a reformat does not
- [x] The framework's own tests need no credential and run in the ordinary suite, so a contributor
      without keys can still develop the framework
- [x] Exactly one new seam is introduced — the runner entry point. Model injection reuses the
      existing model port at both tiers
