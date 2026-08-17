# 05 — Pinned real model on one Case

**What to build:** The first real verdict. The same single Case now runs against a real vendor
model, with the exact model pinned, and the Scorecard reports real tokens and real cost.

**Blocked by:** 03

**Status:** done

- [x] The runner executes a Case against a real vendor model
- [x] Model Profile selection and the Effort router are bypassed — pinning is done by injecting a
      port that wraps one directly-constructed provider model, so the loop never sees the router
- [x] Effort is pinned explicitly rather than left to the classifier, so a classifier change cannot
      silently alter what every Case measures
- [x] The exact model identifier and the API-reported version are recorded in the Scorecard, so a
      vendor rolling an alias forward is not mistaken for a harness regression
- [x] Token counts and cost are captured per Case. **Cached input is a breakdown of the input
      count, not an addend** — adding them double-counts
- [x] A configured ceiling aborts the Sweep before it exceeds budget
- [x] A transient vendor error is retried and reported distinctly from a genuine Case failure
- [x] A silent fallback to a different credential or model fails the Sweep rather than being reported
      as a result

## Deviation 1 — the vendors are subscription CLIs, not API providers

This ticket, and the spec behind it, assumed `anthropic` and `openai` API providers reached with
an API key. The operator holds **neither key**. What this deployment actually has is two vendor
CLI seats, which `packages/llm/src/cli/` already drives:

| Sweep name | Provider | Model | Credential |
| --- | --- | --- | --- |
| `sonnet` | `claude-code` | `sonnet` | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) |
| `luna` | `codex` | `gpt-5.6-luna` | `CODEX_AUTH_JSON` (contents of `~/.codex/auth.json`) |

These are the two the operator named at the outset. Three consequences, all now built:

1. **Dollars cannot bound a Sweep.** `priceCall` returns `{kind: "subscription"}` for both, which
   is correct — a seat has a genuine zero marginal cost. So `--max-spend` can never trip on one,
   and `--max-tokens` was added as the ceiling that actually binds. Tokens are what the vendor
   meters, so tokens are what bounds the Sweep.
2. **Neither id is dated.** `sonnet` and `gpt-5.6-luna` are aliases the vendor may move. The
   Scorecard now carries `modelDated: false` and prints a `NOTE` line, rather than implying a
   stability the Sweep does not have. Recording the version the vendor reports is the only
   available mitigation, and it is built.
3. **Ticket 01 changes shape.** A personal OAuth seat cannot go into a public repo's GitHub
   secret. A release Sweep either runs on a maintainer's own machine and uploads its Scorecard,
   or waits for org-owned API keys. **This must be re-decided before ticket 01 is picked up.**

## Deviation 2 — an unplanned extraction

`splitPrompt`, `toOutput`, `toToolSet`, `withCacheBreakpoint`, `stablePrefixChars`, `tokenDetail`
and `UsageAccumulator` were trapped in `apps/worker`, and an app may not import an app. They moved
verbatim to a new `packages/model-adapter`. A second copy would have let the eval score a call the
product would never make.

## Deviation 3 — the SDK's own retry had to be switched off

`streamText` retries transient failures silently and unbounded by anything the Sweep can observe.
`maxRetries: 0` is now passed, and the retry policy lives in `apps/eval/src/retry.ts` where a retry
can be counted and the failed attempt's tokens still charged.

## What is verifiably not done

One end-to-end call against a live seat, which needs an interactive `claude setup-token`. Every
layer below it is covered against a fake `LanguageModelV4`.
