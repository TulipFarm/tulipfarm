# `@tulipfarm/skill-sandbox`

Runs a Skill's code: the sandbox Tool adapters for a verified bundle, plus the two runners behind
the `skill` Tool's `run` mode (a command the Skill declared) and `shell` mode (one it only
documented in a fenced block).

**Read on** — executing Skill commands, the `allowedCommands` gate, asset scans, guardrail
ceilings, or wiring a new caller that runs Soul-authored code.

**Skip** — the container backend and egress proxy (`../sandbox`), the adapter and effect ledger
(`../tool-broker`), bundle loading and signature verification (`../soul`).

## Map

| Path | Owns |
| --- | --- |
| `src/sandbox-tooling.ts` | `createSandboxStack` (executor, coordinator, artifact bridge, credential leases, guardrail ceilings, asset scans) and `buildBundleSandboxAdapters` |
| `src/runner.ts` | `SkillCommandRunner` — resolve one declared command from the active bundle, mint its intent, dispatch it |
| `src/bash-runner.ts` | `SkillBashRunner` — gate a model-supplied command on the Skill's `allowedCommands`, then run it on a generated entrypoint |
| `src/command-allowlist.ts` · `src/bash-script.ts` | `decideCommand` (patterns, chaining, heredocs); the generated wrapper (base64 payload, captured streams, `result.json`) |

## Rules

- **A declared command is only ever resolved from a verified bundle**, never a live Soul read, so
  no caller can hand the sandbox an asset the signature does not cover. A shell command is model
  input instead — what makes *it* runnable is the Skill's `allowedCommands`.
- **`allowedCommands` is intent, not containment.** Any pattern naming an interpreter permits
  arbitrary code in that language. What bounds it is the sandbox: read-only, non-root, all
  capabilities dropped, `--network=none` unless a destination was declared.
- **Egress is never widened by the caller.** A declared command reaches only what its ToolContract
  lists, `SkillBashRunner` only what that Skill declares on a command of its own; both refuse before
  the guardrail. With no destination `web.maxBytes` must be `0`, or it is `egress_denied`.
- **Never interpolate a command into the generated script.** `buildBashScript` carries it as
  base64; a quote in an approved command would otherwise change what else runs. The wrapper exits 0
  and reports the real exit code as data; `createSandboxStack` re-hashes the synthetic entrypoint.
- **Asset scans reject, they do not warn**, generated scripts included.
- **No runtime image means no execution, not a default one** — empty adapters or
  `sandbox_unavailable`, never a guess at which interpreter runs authored code.
- Adapters are keyed by `ToolContractSpec.adapter.ref`, which must be
  `skill:<slug>/<command>`; `resolveRuntimeSkillCommands` refuses any other binding.
