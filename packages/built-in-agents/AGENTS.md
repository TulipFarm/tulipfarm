# @tulipfarm/built-in-agents

The single-shot prompts the runtime calls on its own behalf — no persona, no Tools, no Run, no
Soul entry, and no way for a user to address one. A **BuiltInAgent** is a `BuiltInAgentSpec` plus
one function that sends one prompt and parses one reply.

## Read on / Skip

Read on when you are changing what one of these prompts says or costs, adding a sixth, or hunting
a prompt-injection path through untrusted input. Skip for anything a user-configured Agent does —
that is `agent-runtime` and `turn-executor`.

## Map

| Path | Owns |
| --- | --- |
| `src/agent.ts` | `BuiltInAgentSpec`, rungs, `builtInAgentRequirements` — the contract each agent declares itself against |
| `src/untrusted.ts` | `UNTRUSTED_PREAMBLE` and `untrusted()` — nonce-fenced blocks for hostile input |
| `src/registry.ts` | `BUILT_IN_AGENTS`, the list the fitness test iterates |
| `src/agents/tool-result-distiller/` | Compresses an oversized Tool result; `grounding.ts` validates citations against the sent bytes |
| `src/agents/effort-classifier/` | Resolves `auto` effort to a rung |
| `src/agents/chat-title/` | Names a Conversation from its first Turn; `sanitize.ts` is the pure fallback path |
| `src/agents/skill-audit/` | Reads a proposed Skill for intent before it may be written |
| `src/agents/onboarding-personalizer/` | Turns a Soul's shape into onboarding suggestions |

One directory per agent, and inside it the same shape every time: `index.ts` holds the spec and
the call, `prompt.ts` holds what the model is told, `schema.ts` holds the structured output, and
any enforcement the prompt only *describes* gets its own module. A prompt that has drifted from
the bound it claims is then a diff in two files, not a paragraph nobody re-read.

## Rules

- **Every agent is in `BUILT_IN_AGENTS`.** `registry.test.ts` fails the build otherwise, and it is
  the only thing that keeps bounds and timeouts from being forgotten on a sixth.
- **Every untrusted input goes through `untrusted()`.** It fences with a per-call nonce so content
  cannot forge its own closing tag, and it passes bytes through unmodified — the distiller
  validates citations by substring against exactly what it sent, so escaping would break grounding.
- **Never import `@tulipfarm/llm`.** Models arrive injected as a `BuiltInAgentModelSource<TGate>`;
  the gate type is a parameter for the same reason. The import scanner counts type-only imports.
- **`agents/skill-audit/` guards Soul writes.** It sits beside a Conversation-naming prompt, but it
  is the one prompt here whose failure has consequences. Review it as such. Its rubric is
  `SKILL_AUDIT_TAXONOMY` from `@tulipfarm/soul`, shared with the bundled `skill-forge` Skill — edit
  the taxonomy there, not a paraphrase here, or the forge authors against rules this never checks.
- Curator is deliberately not here: it is a two-process trust boundary, not a single-shot call.
  See `packages/curator` and `packages/curator-host`.
