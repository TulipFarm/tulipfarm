# `@tulipfarm/curator`

The Curator's pure reasoning contract: the prompt it is given, the output schema it must answer
in, and the validation that turns that answer into effects the server is willing to record. It is
a package because two untrusted processes share it — the Worker builds the prompt and calls the
model, the API re-derives every check on what comes back.

## Read on

Proposal kinds, memory patch validation, citation rules, injection guardrails, or the wording of
either prompt.

## Skip

Persistence, minting, admission and the effect ledger (`apps/api/src/curator/`), the sweep
(`apps/worker/`), and the Memory Document itself (`packages/memory`).

## Map

| Path | Owns |
| --- | --- |
| `src/proposal.ts` | Closed kind/subject vocabularies, the resource template menu, the reserved `curator:` dedupe namespace, and every user-facing string |
| `src/output.ts` | The two ajv output schemas — user and business — and their parse results |
| `src/citations.ts` | Quote normalization, citation resolution, directive evidence, shared-text guardrails |
| `src/effects.ts` | `planUserEffects` / `planBusinessEffects` — the only place model output becomes an effect |
| `src/prompt.ts` | Both prompts, rendered from the same vocabularies the validator enforces |
| `src/review.ts` | What a reviewer may see of a recorded effect — `memory_patch` and `proposal` are one person's, so a non-subject gets counts and closed vocabularies, never text |

## Rules

- **The model authors no user-facing text.** It picks a `kind` and a `subjectId`; `templateProposal`
  writes the title, pill label, prompt and link. Clicking a pill inserts its prompt into the user's
  next turn, so model text there is a direct injection path.
- **Nothing is dropped silently.** Every discarded claim becomes an `EffectRejection` with a
  reason — "why was this rejected" is how the loop is judged.
- Two output schemas, never a union: a union's errors cannot say which branch failed.
- Entailment is deliberately **not** checked here. A lexical proxy would reject true learnings that
  share no token with their evidence; see the header of `src/citations.ts`.
- Budgets stay in `packages/memory` — the *remaining* budget depends on the live document, so it
  arrives as context, not as a constant.
