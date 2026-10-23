# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Calendar Versioning](https://calver.org/) in the format `YYYY.M.D.N`: the
release date, then the release number on that day (for example `2026.10.19.1`).
One version identifies all apps and images of a release.

## [Unreleased]

### Changed

- **Breaking:** one model catalog file configures every model. The shipped
  catalog is `packages/config/catalog/models.json`, in the
  [model catalog format](https://tulipfarm.ai/schemas/model-catalog.v1.json).
  `MODEL_CATALOG_FILE` (a path) or `MODEL_CATALOG` (the same JSON inline)
  replaces it entirely; setting both fails. It lists each model's provider
  routes, limits, capabilities and prices, the default model for new chats and
  agents, paused and hidden (`"selectable": false`) models, and the model of
  each role. A listed model whose provider key is unset stops startup, or is
  left out with `"missingKeys": "skip"`. Chats and agents on a model the
  catalog no longer lists move to the default model, and the web app says so.
  Without a `table-search` or `recommendation` model, that feature is off.
- **Breaking:** `MODEL_FAMILIES`, `MODEL_PAUSED_FAMILIES`,
  `MODEL_DEFAULT_FAMILY`, `MODEL_CATALOG_MODE`, `CHAT_TITLE_MODEL_FAMILY`,
  `SKILL_REVIEW_MODEL_FAMILY`, `PLAN_SPECIALIST_MODEL_FAMILY`,
  `GMAIL_HEARTBEAT_MODEL_FAMILY`, `PUBLIC_GUIDE_MODEL_FAMILY`,
  `TABLE_SEARCH_MODEL_FAMILY` and `RECOMMENDATION_MODEL_FAMILY` are removed.
  Startup fails while any is set, naming what replaces it in the catalog. The
  api and worker need at least one served model to start.
- Bundles, runs and receipts stored by earlier releases still verify, and an
  unchanged catalog keeps the earlier server bundle ids and price revision.

### Fixed

- New chats use the configured default model; the default model setting was
  previously ignored for them.
- A reply on a model that can't serve it, for example a deployment that
  doesn't exist, a rejected key or no quota, now fails at once instead of
  retrying for over a minute. Busy or unavailable providers still retry.
- Model call failures record a bounded `error.code` (`auth`, `not_found`,
  `rate_limited`, `quota_exceeded`, `bad_request`, `content_filtered`,
  `context_too_long`, `timeout`, `network`, `server_error`, `unknown`, ...) on
  spans, gen_ai metrics and logs, with the HTTP status, provider error code and
  a truncated, sanitised provider message instead of a generic `Error`.
- A context-overflow or output-limit model failure also fails the reply at
  once. Every failed model reply shows short in-chat copy for its class and a
  Retry action, and a reply waiting to retry says so instead of a silent
  spinner. A call the provider refused before generating anything is not
  charged.
- A chat reply that stops after tool calls no longer posts a canned list of
  raw tool statuses. The turn fails with the cause of the failed attempt
  (`database-conflict`, `model-timeout`, `reply-interrupted` and so on), the
  chat shows that cause in plain words, and **Continue** resumes the reply from
  its completed tool receipts without running them again.
- Web and knowledge tool rows that succeeded no longer reload as "failed" or
  "Knowledge source unavailable" when their reply context held personal memory
  or an earlier answer of unknown provenance. Such markers now only conceal a
  row's URLs, query and passages; a revoked retained source still conceals it.
- A long chat reply no longer fails with `conversation-context-overflow` once
  its tool results grow. Context fit is now estimated in tokens (the previous
  round's reported prompt tokens plus a quarter of the bytes added since, or a
  quarter of the request bytes) instead of treating request bytes as tokens;
  bytes only size credit holds. Before every model round, a reply at the
  compaction trigger (default 70% of the model's window) summarises its older
  tool results with the compaction model, keeps the latest round verbatim,
  unloads searched tools idle for two rounds, and continues. Without a summary
  it leaves stubs. Each tool result is cut to 10% of the window, and the model
  rereads any stored full result by call ID with `tool_result_read`. Each
  compaction records `cloud_chat_context_compactions` and a
  `chat.context-compaction` log with counts only.
- Streamed model replies read token usage from any chunk, including a final
  usage-only chunk, and accept null usage details, DeepSeek cache fields and a
  missing `total_tokens`. Credits settle on that usage and
  `gen_ai_client_tokens` is recorded instead of charging the full reservation.
  Calls whose usage is still unknown are counted as `gen_ai_model_usage`
  `model_usage="unknown"` and logged with the usage field shape.

### Added

- The model catalog role `fallback` (off unless a model has it) retries a chat
  model call once on that model when the chat model fails before any output
  with a failure a different model can fix. The reply notes and bills the model
  that answered.
- `MODEL_PAUSED_FAMILIES` pauses model families for new work. A paused family
  stays in the catalog as "temporarily unavailable" (`model-family-paused`) and
  cannot be chosen for new chats, new agents or fallback targets. Existing
  agents and chats move to the workspace's fallback rule target when one is
  set, and otherwise keep using it.
- The `workspace.created` hook event carries `workspaceName`, the workspace's
  display name.
- Leaf workspace packages: typescript-config, build-info, config, keyring,
  content-budget, access, observability, provider-mcp, slack-presentation,
  workflow-snippets, files, workspace-storage, integrations.
- Domain workspace packages: knowledge, conversations, tables, google-workspace,
  atlassian, github, slack, workflows, workspace-mcp, workspace-mcp-transport,
  recommendations, email, agents, workspaces.
- Web app (`apps/web`): the workspace app on `@tulipfarm/sprout` components with
  cloud's look, a web override registry (`analytics`, `credits`, `usage`) loaded
  from `VITE_TULIPFARM_WEB_EXTENSIONS` at build time, browser feature flags from
  the new authenticated `GET /v1/feature-flags` route, Turnstile shown only when
  the API has a site key, and the self-host Compose `web` service served by Caddy.
- Web app UI comes entirely from `@tulipfarm/sprout`: the shadcn
  `src/components/ui` copy and its unused dependencies are removed. The API
  origin defaults to the page's own origin in production, and the support email
  (`VITE_SUPPORT_EMAIL`) and agent avatar service (`VITE_AGENT_AVATAR_URL`) are
  optional build settings, with no hosted tulipfarm.ai defaults.
- Backend apps: api, worker, database (migrations, setup, operator CLIs),
  dev-seed, snippet-broker; self-host Docker Compose stack; local Temporal admin
  image.
- Repository tooling: `pnpm check` / `pnpm check:full` runner, tooling tests,
  documentation link check, and local verification scripts.
- GitHub Actions: CI (lint, typecheck, test) on GitHub-hosted runners, and a
  GHCR container image workflow that stays disabled until release.
- `@tulipfarm/extensions`: typed server slots with no-op defaults (credit gate,
  usage sinks, analytics, error reporters, flag provider, lifecycle hooks,
  extension migrations), a web override registry, and `TULIPFARM_EXTENSIONS`
  loading in the api and workers.
- Feature flags: one registry of typed flags resolved by extension provider,
  then environment variable, then default.
- Error reporting for failed background jobs and api/worker startup and
  shutdown failures, plus a no-op web analytics interface.
- Lifecycle hook events (`workspace.created`, `member.invited`,
  `task.completed`, `usage.recorded`) emitted after commit.
- Credits seam: agents, chat, conversations, knowledge embeddings, table
  search, authoring and worker activities meter usage in the workspace and fund
  it through the extension credit gate, so credits are unlimited unless a
  billing extension registers a gate. Settled model usage, with token counts,
  goes to usage sinks. A gate may provision per-workspace state when a
  workspace is provisioned (`provision`) and report the balance shown by the
  credit summary (`balance`).
- Fresh migration baselines: `apps/database/migrations/0001_baseline.sql` and
  `packages/workspace-storage/common/0001_baseline.sql` replace the earlier
  migration chains, without the hosted credit-adjustment, QA, and
  `tf_credit_account` tables. `apps/database` migrate runs each extension's
  migrations after core in the extension's schema with its own ledger.
- Credit pricing seam: the `creditPricing` extension slot converts provider
  cost to credits. The default is one credit per $0.01 of provider cost with no
  markup or rounding; the model catalog keeps provider cost only.
- Model defaults work with only `ANTHROPIC_API_KEY`: chat, agent-instruction
  improvement and skill review default to Claude Sonnet (`MODEL_DEFAULT_FAMILY`,
  `SKILL_REVIEW_MODEL_FAMILY`), and Azure Foundry needs an explicit
  `AZURE_FOUNDRY_ENDPOINT`.
- Operator model catalog: `MODEL_CATALOG_FILE` (or inline `MODEL_CATALOG`) adds
  or overrides model families and models over the shipped catalog, or replaces
  it with `MODEL_CATALOG_MODE=replace`. An invalid entry stops the api and
  worker at startup with the entry named. Mapping and price revisions come from
  a content hash, and the shipped catalog keeps its published revisions. Family
  ids follow the workspace table pattern `^[a-z][a-z0-9-]{0,99}$`.
- Custom model endpoints: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `XAI_BASE_URL` and `GEMINI_BASE_URL` point a provider at a gateway or regional
  endpoint, and an `openai-compatible` catalog model declares its own `endpoint`
  and `credentialEnv` (vLLM, Ollama, OpenRouter). Hosts other than the built-in
  provider APIs must be listed in `MODEL_ENDPOINT_HOSTS`; endpoints use https
  (http only for localhost outside production) and never carry credentials.
- Self-host Compose runs Temporal under the `temporal` profile, on by default
  through `COMPOSE_PROFILES=temporal` in `.env.example`. Without it, set
  `TEMPORAL_ADDRESS` (and `TEMPORAL_NAMESPACE`, `TEMPORAL_UI_URL`) to use your
  own Temporal. An empty `TEMPORAL_UI_URL` skips the health check's UI probe.
- Public web retrieval is optional: `PUBLIC_WEB_ENDPOINT` takes any keyless
  Firecrawl-compatible API and is off when unset. Self-host Compose passes it
  to the api and worker, and `pnpm dev:setup` no longer writes a default. The
  Firecrawl stack and `pnpm infra:web:*` scripts are no longer in this
  repository.
- Model capabilities: catalog families may set `capabilities` (`api`,
  `toolChoice`, `reasoningOffForTools`, `reasoningTokensInOutput`, `streaming`,
  `responseModelAliases`) over provider defaults, and inference routes accept
  the same `capabilities`. Inference no longer branches on model IDs, so a
  custom deployment named `grok-*` only counts reasoning tokens as output when
  its capabilities say so.
- Chat, chat titles, compaction, skill review, the plan specialist and the Gmail
  heartbeat resolve their model and price through the same model environment as
  tasks and the catalog, so `MODEL_FAMILIES` and `MODEL_CATALOG` apply to them.
  A chat model, `SKILL_REVIEW_MODEL_FAMILY`, `PLAN_SPECIALIST_MODEL_FAMILY` or
  `GMAIL_HEARTBEAT_MODEL_FAMILY` outside `MODEL_FAMILIES` is rejected; a
  `CHAT_TITLE_MODEL_FAMILY` outside it falls back to the chat model.
- Operator pricing: an operator catalog model entry with a shipped id sets
  contract prices for metered cost, and a catalog family with
  `"pricing": "unmetered"` runs models without rates at zero cost while still
  recording tokens. The workspace model catalog returns `null` credit rates for
  unmetered families, and the web shows "Not priced". A model without rates
  outside an unmetered family fails catalog validation.
- Model configuration continuity: the api and worker record their model bundle
  in `model_lifecycle.bundles` at startup (migration `0002_model_bundles.sql`),
  and a task started before a model catalog or family change finishes after a
  restart and is charged at the rates it started with. Bundle ids are now the
  full SHA-256 of the bundle content, and a stored bundle is used only when its
  content still hashes to its id.
- Five default model providers: Anthropic, OpenAI (`OPENAI_API_KEY`), xAI
  (`XAI_API_KEY`), Google Gemini (`GEMINI_API_KEY`, now selectable, with
  streamed chat) and Azure Foundry. OpenAI and xAI use the OpenAI wire on
  api.openai.com and api.x.ai, and the shipped catalog lists direct OpenAI and
  xAI entries for the GPT and Grok families. A family runs on its catalog
  provider when that credential is set, otherwise on another provider with a
  credential. Without `MODEL_FAMILIES`, every family a configured key serves is
  enabled. The shipped catalog revisions are now `families-2026-10-19.1` and
  `prices-2026-10-19.1`.
- Model roles: catalog families declare `roles` (`default-chat`, `title`,
  `compaction`, `review`, `plan`, `heartbeat`, `public-guide`). New chats, the
  web model picker, chat titles, compaction, skill review, the plan specialist,
  the Gmail heartbeat and the public guide default to the first enabled family
  with the role, so a catalog without the shipped Claude or GPT families still
  works. The role settings still override, the new `PUBLIC_GUIDE_MODEL_FAMILY`
  picks the guide's family, and the api and worker warn at startup when no
  enabled family has a role. The guide is priced from the effective catalog.
- `AUTH_METHODS` chooses the sign-in methods: `password`, `magic-link`, `google`.
  Unset, email links follow the email transport and Google follows its client ID
  and secret; a listed method without credentials logs a warning and stays off.
  The login and sign-up pages show only the methods the API reports, and say so
  when none is configured. Email and password sign-in is off unless listed. People change it under Account, and **Forgot password?**
  emails a one-hour reset link when an email transport is configured. Without
  one, `pnpm auth:reset-password <email>` prints the link for an administrator.
  Password attempts are limited per client and per address, and Turnstile
  applies when configured. `GET /v1/auth/options` reports the methods to the
  login page, and migration `0003` lets email deliveries carry password reset emails.
- OpenTelemetry export to any OTLP/HTTP backend (your own Collector, Grafana
  Cloud, Honeycomb, New Relic, SigNoz, Jaeger, a Datadog Agent): any `https`
  endpoint, `http` for local and private hosts, optional `Authorization`,
  `CLOUD_TELEMETRY_OTLP_HEADERS`, per-signal endpoints and switches, and a
  sample ratio from 0 to 1. The self-host stack passes the settings through.
  The export target label is now `otlp` instead of `grafana`; existing Grafana
  Cloud settings keep working. See self-host/README.md#telemetry.
- The model catalog response gives each family's `vendor`. The web app brands
  models from the catalog's vendor and name, so operator catalog families show
  their own name and a neutral logo for vendors without one, and an empty
  catalog shows "No models configured" with a link to the model setup guide.
- Self-hosted model guide at https://docs.tulipfarm.ai/self-hosting/models/:
  the five providers and their credentials, a full operator catalog example,
  capabilities, roles, custom and `openai-compatible` endpoints with
  `MODEL_ENDPOINT_HOSTS`, operator prices and credits, embeddings, and what
  happens to running work after a catalog change. `self-host/.env.example`,
  setting descriptions and package READMEs link to the published docs instead
  of missing repository files.
- Web app on `@tulipfarm/sprout` 0.4.0. Table Board and List layouts use
  Sprout's `Board` and `RecordList`. Board columns still load and retry on
  their own, and clicking a card or list row opens it. The Table, Board and List
  switch is a `ViewSwitcher` tab bar. The Soul repository browser uses
  `FileExplorer`, which searches file names and text as you type. Tiptap
  packages move to 3.32.0 to match Sprout.

### Changed

- Cloudflare Turnstile verification runs in the background. The widget appears
  only when Cloudflare needs the person to interact, or when verification fails.
- Web app (`apps/web`) moves to `@tulipfarm/sprout` v0.7.0. The chat model
  picker is Sprout's `ModelSelector`, with vendor logos, a relative cost meter
  and searchable models. Integration names typed in a message show as chips
  that say whether the app is connected and link to its setup. Task status
  badges show Sprout's `Status` indicator, and chat plans draw their steps as a
  `TaskTree`.
- Bud's animated chat expressions are off by default behind the new
  `bud-avatar` feature flag (`FEATURE_FLAG_BUD_AVATAR`). Without it the model
  is not offered the `bud_state` tool or told to set expressions, so a greeting
  no longer spends extra model rounds on the avatar, and the chat shows Bud as
  a still, idle pose. Set the flag to `true` to restore the animated avatar.
- The chat's reply status shows what the reply is doing. The worker adds an
  optional `status` (`thinking`, `tool`, `finishing` or `done`), the work
  tool's display name, `toolRounds` and `seq` to the `progress` stream event.
  The label reads "Thinking", "Using Knowledge…", "Planning next step · Step 2"
  or "Finishing up". Steps count only finished work tools, never `bud_state`,
  format corrections or the completion check. The spinner ends once the
  checked answer is on screen, even while the chat title is still being
  written. Events without a `status` keep the round-based labels.

### Removed

- `AUTH_EMAIL_PASSWORD`. Set `AUTH_METHODS=password` (with any other methods)
  instead; the api refuses to start while the old variable is set.
- The unused `AGENT_MODEL_ENDPOINT`, `AGENT_MODEL_DEPLOYMENT`, `AGENT_MODEL_AUTH`,
  `AGENT_MODEL_API_KEY` and `OPENAI_CUSTOM_HEADERS` settings and the uncalled
  Azure SDK agent model that read them; configure models through the model
  catalog instead.
- The unused `model_lifecycle` tables (`identities`, `evidence`, `notices`,
  `activations`, `head`, `commands`, `cutoffs`, `notice_deliveries`) and the
  `notice_events` view; only `bundles` remains.
