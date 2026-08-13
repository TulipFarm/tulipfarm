# Run TulipFarm on local coding-agent CLIs instead of API keys

> **On approval, first action:** copy this file to `docs/plans/cli-agent-providers.md`
> in the repo (per global agent instructions: plans live in the repo, not in scratch paths).

## Context

Today TulipFarm can only talk to a model through an API key. `packages/llm/src/provider.ts`
supports four providers — `anthropic`, `openai`, `azure`, `openai-compatible` — and each one
resolves a key from the secrets store before it can build a model.

A user who has a **Claude Pro/Max or ChatGPT subscription but no API key** cannot run TulipFarm
at all. That is the gap this closes.

The sister repo `/Users/dhruv/dev/tulipfarm/qm` already drives Claude Code, Codex, Pi and
OpenCode as inference engines. Two facts from studying it change the shape of this work:

1. **qm does not reuse a personal login.** It jails `HOME` to a `mkdtemp` dir, allowlists env,
   and synthesises its own Codex `auth.json` from `OPENAI_API_KEY`
   (`qm/src/harness/codex-harness.ts:199-210`). A test asserts "never an ambient login".
   qm is *harness-as-engine, still API-keyed*. The subscription path is new work.
2. **qm cuts the seam at a different depth.** qm delegates the whole agent loop to the CLI.
   TulipFarm's seam is a *model*: messages in, one completion out, tool calls returned
   **unexecuted**, because the Tool Broker is the only effect path
   (`packages/agent-runtime/src/loop/loop.ts:9-24`). We keep TulipFarm's seam.

### Intended outcome

A user with no API key pastes one token into Settings and TulipFarm runs — chat turns,
routines, chat titles, memory extraction, skills audits — with governance, budgets, approvals
and audit unchanged.

## Decisions taken

| Question | Decision |
| --- | --- |
| Integration depth | **Model provider.** Implement `LanguageModelV4`. AgentLoop + Tool Broker stay in charge. |
| Binary source | **Bake into the image via pnpm deps.** No host PATH, no volume mounts. |
| Credential | **Portable token in the secrets table**, injected into a jailed subprocess env. |
| Codex refresh | **`auth.json` blob + write-back** after each turn if the refresh token rotated. |
| Coverage | **Everything**, including `generateObject` structured output. |
| Tool calls | **Capture → abort → replay.** One CLI invocation per AgentLoop iteration. |
| Structured output | **Prompt + parse + repair.** |
| Harnesses | Claude Code, Codex, Pi, OpenCode — phased, Pi gated (see Risks). |

## Verified facts this plan rests on

- `@anthropic-ai/claude-agent-sdk@0.3.231` has **zero runtime deps** — it vendors its own
  `claude` binary. One dep gives both API and binary.
- `@openai/codex@0.147.0` ships `bin = { codex: 'bin/codex.js' }`.
- `claude setup-token` → *"Set up a long-lived authentication token (requires Claude
  subscription)"*. Purpose-built portable credential. Read via `CLAUDE_CODE_OAUTH_TOKEN`.
- `~/.codex/auth.json` = `{ auth_mode, last_refresh, OPENAI_API_KEY,
  tokens: { access_token, refresh_token, id_token, account_id } }`. Contains the refresh
  token, so a copied blob self-refreshes.
- `codex app-server` is flagged **[experimental]** by the CLI itself.
- `ProviderEntrySchema.provider` is `Type.String()`, not an enum
  (`packages/schema/src/llm.ts:63`) — schema validation already accepts new provider names.

## Architecture

```
  ┌─────────────────────── apps/worker ───────────────────────┐
  │  AgentLoop  (durable budgets, approvals, repair, cancel)  │
  │      │                                                    │
  │      │ ModelPort.stream()                                 │
  │      ▼                                                    │
  │  LlmModelPort ──► streamText() ──► LanguageModelV4        │
  └──────────────────────────────────┬────────────────────────┘
                                     │
                       createModel(entry, secrets)
                                     │
        ┌────────────────────────────┴─────────────────────┐
        │                                                  │
   existing cases                              NEW: CliLanguageModel
   anthropic / openai /                                    │
   azure / openai-compatible              ┌────────────────┴────────────────┐
                                          │ claude-code │ codex │ pi │ oc  │
                                          └────────────────┬────────────────┘
                                                           │
                                          spawn, HOME = mkdtemp jail
                                          env = strict allowlist + token
```

### One AgentLoop iteration

```
  transcript ──► spawn CLI ──► stream
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              text deltas              assistant msg with
                    │                  tool_use blocks
                    │                         │
              emit text-delta          capture ALL blocks
                    │                         │
                    │                     abort() CLI
                    │                         │
                    ▼                         ▼
              finishReason           emit tool-call parts
                'stop'               finishReason 'tool-calls'
                                              │
                                              ▼
                             AgentLoop ──► ToolBroker.dispatch()
                                              │
                             transcript grows, next iteration
```

**Why abort-and-replay:** it is the only shape where TulipFarm's per-iteration budgets,
approval parking, repair counters and `load_skill` narrowing keep working. Letting the CLI's
tool handler block on the broker would collapse a whole turn into one model call and silently
disable all of that.

**Cost:** full transcript replay per iteration. Claude Code has no session resume in print
mode, so it already replays. Do **not** invest in cache tuning in v1 — measure first.

## Work

### Phase 1 — Shared base + Claude Code

New directory `packages/llm/src/cli/`:

| File | Role |
| --- | --- |
| `base.ts` | `CliLanguageModel` — abstract `LanguageModelV4`. Owns `doGenerate`/`doStream`, subprocess lifecycle, timeout, abort, usage, error classification. Subclasses supply transport. |
| `jail.ts` | `mkdtemp` HOME jail + env allowlist. Port `qm/src/harness/claude-harness.ts:121-127`. |
| `transcript.ts` | `LanguageModelV4Prompt` → CLI input; CLI `tool_use` → `LanguageModelV4StreamPart` tool-call. Port the pairing/interrupt logic from `qm/src/harness/replay.ts:128-234`. |
| `structured.ts` | Brace-scanning JSON extractor. Port `qm/src/security/security-posture.ts:56-81`. |
| `specs.ts` | Static `ModelSpec` table per CLI model (`max_input_tokens`, `supports_function_calling: true`, …). |
| `claude-code.ts` | Adapter over `@anthropic-ai/claude-agent-sdk`. |

**Claude Code adapter shape** — mirror `qm/src/harness/claude-harness.ts:427-479`:

```
query({ prompt, options: {
  cwd: jail, env: jailEnv,
  systemPrompt: <from prompt[] system parts>,
  model: entry.model,
  mcpServers: { tulipfarm: createSdkMcpServer({ tools: <declare only> }) },
  settingSources: [],      // ignore the user's ~/.claude config entirely
  strictMcpConfig: true,
  persistSession: false,
  includePartialMessages: true,
  abortController,
}})
```

Tools are **declared, never executed** — read `tool_use` blocks off the `assistant`
`SDKMessage` content array and abort, rather than relying on handlers firing. This captures
**parallel tool calls** correctly; aborting inside the first handler would drop the rest.

`settingSources: []` is deliberate: without it the user's `CLAUDE.md`, hooks, skills and MCP
servers silently alter TulipFarm inference.

Usage: max-merge per `message.id` (`qm/src/harness/claude-harness.ts:581-607`) — the SDK
repeats deltas. Report `inputTokens`/`outputTokens`; **omit `costUsd`** so `priceFor` returns
`null` ("unpriced"). A subscription turn has no per-token cost, and reporting the API-equivalent
figure would corrupt cost budgets and the `llm_cost_usd_total` metric.

### Phase 2 — Registry, config and UI wiring

| File | Change |
| --- | --- |
| `packages/secrets/src/registry.ts:11` | Widen `LlmProviderId` with the new ids. |
| `packages/secrets/src/registry.ts:34-93` | Add `LLM_PROVIDERS` entries (below). |
| `packages/llm/src/provider.ts:94-119` | Add `case` per CLI provider. |
| `apps/web/app/routes/setup.tsx:371-376` | Add `DEFAULT_MODEL` entries. |
| `apps/api/src/setup/routes.ts:264` | Widen the hardcoded `["anthropic","openai"]` enum. |
| `packages/llm/AGENTS.md` | "How to extend" currently says *"add the `@ai-sdk/<x>` dep, then a case"* — no longer the only shape. |
| `metadata/terminologies.md` | Add a canonical row. Terminology is binding and **"harness" is already taken** (it means the default chat surface, line 43). Proposed term: **CLI Provider**. Needs your sign-off. |

Registry entry — note it reuses `role: "api_key"`, so **no schema widening is needed** and the
Settings form, `/setup` wizard, `isProviderConfigured()` and the delete-key-prunes-config
cascade all work unchanged:

```ts
{ id: "claude-code", label: "Claude Code (subscription)",
  fields: [{ key: "claude-code-oauth-token", label: "OAuth token",
             role: "api_key", kind: "secret", placeholder: "sk-ant-oat01-…" }] }
```

**Routing capacity gate.** `validateRoutingCapacity`
(`apps/api/src/soul/llm-config/routes.ts:242-256`) rejects any config whose model lacks a
verified `max_input_tokens`. CLI models will not resolve against LiteLLM
(`packages/llm/src/model-spec.ts:23-28`). Fix by having `enrichSpecs` fall back to
`cli/specs.ts` — **not** by relaxing the check.

### Phase 3 — Codex

- `codex-rpc.ts` — newline-delimited JSON-RPC over `codex app-server` stdio. Port
  `qm/src/harness/codex-app-server.ts` wholesale (169 lines; SIGTERM→SIGKILL, stderr tail,
  serialized writes).
- `codex.ts` — `thread/start` with `approvalPolicy: "never"`, `sandbox: "read-only"`,
  `ephemeral: true`, all built-in tools off. TulipFarm tools go in as `dynamicTools`; Codex
  hands calls back as an `item/tool/call` **request**, which is the natural fit. Capture and
  `turn/interrupt`.
- **auth.json write-back.** Store the blob as one secret. Before spawn, write it to
  `$CODEX_HOME/auth.json` (mode `0600`). After the turn, re-read; if `tokens.refresh_token`
  or `last_refresh` changed, `secretsService.set()` it back. Without this the container's
  refreshed token dies on restart and silently reverts to a stale copy.
  `SecretsService.set` already exists (used by `apps/api/src/setup/bootstrap.ts:55-57`).
- Error classification: port `CODEX_NON_RETRYABLE_PATTERN`
  (`qm/src/harness/codex-harness.ts:106-115`).

### Phase 4 — OpenCode, then Pi

- OpenCode: HTTP sidecar (`opencode serve --hostname=127.0.0.1`) + plugin bridge. Third
  transport shape. Port `qm/src/harness/opencode-harness.ts:754`.
- Pi: **gated — see Risks.** Port `qm/src/harness/pi-harness.ts`.

### Cross-cutting

**Structured output** (`responseFormat: { type: 'json', schema }`): append the schema to the
prompt, extract the first JSON object, let the AI SDK repair loop retry. In-repo precedent:
`apps/api/src/onboarding/personalize.ts` already uses `experimental_repairText`. Declare
`supports_function_calling: true` in `specs.ts` so `profileFrom`
(`packages/schema/src/model-catalog.ts:77-101`) derives `structuredOutput: true`.

**Error classification.** Extend `classifyProviderError`
(`packages/llm/src/provider-error.ts:54-74`) — it only understands `APICallError`,
`LoadAPIKeyError`, `NoSuchModelError` today. An expired token must map to
`model_authentication_failed` and throw `LlmProviderError`, so `isHardFailure`
(`packages/llm/src/fallback.ts:27-33`) propagates it instead of burning the whole fallback
chain on a credential problem. Surface a UI message naming the fix: re-run `claude setup-token`.

**Empty-completion guard.** `apps/worker/src/model.ts:193-222` throws when a stream finishes
with 0 calls, 0 text and 0 tokens. Every adapter must report token counts.

**Docker.** Deps arrive through the `pnpm install` the Dockerfile already runs. **Verify the
production prune step keeps `node_modules/.bin/claude`** — this is the single most likely
build-time surprise.

## Verification

**Unit** — port qm's two test patterns:
- Fake executables: write a Node script named `codex`, `chmodSync(0o755)`, have it speak the
  JSON-RPC protocol and assert what the adapter sent
  (`qm/test/codex-harness.test.ts`). Assert the jail: `HOME === jail`, and that
  `DATABASE_URL` / `ENCRYPTION_KEY` / `OPENAI_API_KEY` are **absent** from the child env.
- Module mocking: `vi.mock("@anthropic-ai/claude-agent-sdk")` with a scripted async generator
  (`qm/test/claude-harness-turn.test.ts`).
- Assert parallel tool calls survive capture-and-abort — the most likely correctness bug.
- Assert the credential never appears in an error `message`, `stack`, or log output. Copy the
  existing security assertions at `packages/llm/src/provider.test.ts:177-212`.

**Scoped runs** (per repo AGENTS.md tiers):
```
pnpm exec biome check --write packages/llm/src/cli
pnpm --filter @tulipfarm/llm test src/cli
pnpm --filter @tulipfarm/llm typecheck
pnpm --filter @tulipfarm/secrets test
```

**End-to-end, through the product surface** (repo rule: manual QA uses the UI, not `curl`):
1. `claude setup-token` on the host → copy token.
2. `pnpm dev`.
3. Browser → `/setup` (or `/business/models`) → provider **Claude Code** → paste token → save.
4. Send a chat message that needs a tool. Confirm: streamed text, a tool call dispatched
   through the Tool Broker, a coherent multi-iteration turn.
5. Confirm an approval-gated tool still parks the turn — this is what proves the AgentLoop
   was not bypassed.
6. `/business/models` → confirm chat titles and memory extraction work (API-side `generateText`).
7. Trigger a skills audit → confirms `generateObject` emulation.
8. Delete the token secret → confirm the config cascade prunes the provider and the UI says so.

**Container:**
```
docker build -t tulipfarm-cli-test .
docker run --rm tulipfarm-cli-test ls node_modules/.bin/claude
```

## Risks

| Risk | Handling |
| --- | --- |
| **Pi is a private dep.** `@earendil-works/pi-coding-agent` installs from a `yc-software` GitHub release tarball. No public npm package, no `pi` binary on this machine. Pi is also **not a subscription path** — qm authenticates it with `setRuntimeApiKey(provider, key)`, i.e. an API key, which does not serve the goal of this work. | Phase 4, **gated**. Before starting it: confirm distribution rights, and confirm Pi can authenticate without an API key. If it cannot, it does not belong in this feature. |
| `codex app-server` is experimental | Pin `@openai/codex` exactly. Adapter tests use fake binaries, so a protocol change fails loudly in CI rather than in production. |
| Image size — up to 4 CLI packages | Ship Phase 1 (Claude only) and measure before adding more. Consider `optionalDependencies` if it hurts. |
| Token expiry | Hard-fail classification + a UI message naming the exact fix command. |
| **Terms of service** | Pointing a personal Claude/ChatGPT subscription at a multi-user business system is a consumer-ToS question. Your call, but it should be deliberate. Flagged, not decided. |
| Ambient config bleed | `settingSources: []` and the env allowlist. Asserted in tests. |
```
