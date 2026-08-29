# TulipFarm Terminology — Canonical Glossary

**Status:** binding. This is the single source of truth for what every concept is
called, at every layer (code, DB, REST, URL, UI, docs). Linked from AGENTS.md —
all agents and contributors MUST follow it. The cross-layer renames it prescribes have
been applied across the repo (see *Completed Renames*); where any new divergence appears,
the canonical term wins.

## How to read this

Every concept has ONE canonical term. The layer columns show how that term is
spelled per layer; they are spellings of the SAME concept, never different concepts.

| Layer | Convention |
|---|---|
| **Code (types)** | `PascalCase` (`Conversation`, `Record`) |
| **Code (vars/fns)** | `camelCase` |
| **Files** | `kebab-case` |
| **DB table/collection** | lowercase, plural |
| **REST path** | `/api/v1/<plural-kebab>` |
| **App URL** | `/<kebab>` |
| **UI label** | Title Case |
| **Docs prose** (`apps/docs`) | lowercase — `a run`, `the soul`, `an agent` |

Docs prose is the one layer where the noun is an ordinary English word, not an identifier:
"a run reaches a state" reads as English, "a Run reaches a State" reads as jargon. The exception is
quoting the screen — a UI label keeps its own casing, so **Run SkillAudit** stays as printed.

## Cross-cutting rule: external vs internal vocabulary

Two concepts deliberately use two words across a clean boundary — this is a rule,
not drift:

- **Chat** = the *external/wire* word: app routes, REST paths, UI labels, the verb.
- **Conversation** = the *internal/persistence* word: entity, table, repo, domain code.

Never let these bleed: UI/URL never say "conversation"; domain/DB never say "chat".

## Canonical glossary

| Concept (what it is) | Canonical | Code | REST / URL | UI label | Notes & retired synonyms |
|---|---|---|---|---|---|
| Product surface for messaging an agent | **Chat** | — | `/chat`, `/chat/:id`, `/api/v1/chats` | "Chat", "New chat" | external/wire word only |
| A persistent message thread (the entity) | **Conversation** | `Conversation` | (stored under chat paths) | — | internal word; table/repo/domain |
| One user→assistant exchange | **Turn** | `Turn` | — | — | child of Conversation |
| Atomic message unit | **Message** | `Message` | — | — | roles: system\|user\|**assistant**\|tool |
| Auth/login session (cookie) | **Session** | `Session` | `/api/v1/auth/...` | — | AUTH ONLY — never the chat thread |
| Configured AI persona/worker | **Agent** | `Agent` | `/agents`, `/api/v1/agents` | "Agents" | the *who* — addressable, owns the Conversation across Turns, and the **only** one of Agent/Skill that holds authority (`capabilityRestrictions` is server-enforced). Normal chat is the default harness; Agents are user-created. ⛔ never describe an Agent as "a skill" or author one per task — one Agent uses many Skills |
| The resource feature | **Resources** | — | `/resources` | "Resources" | umbrella |
| A user-defined schema (Ticket, Customer) | **Resource type** | `ResourceType` | `/resources/:type` | "Resource type" | has a JSON **schema** |
| The JSON Schema artifact of a type | **Schema** | `schema` | `/resources/:type/schema` | "Schema" | |
| A single data instance | **Record** | `Record` | `/resources/:type/:id` | "Record" | ⛔ bare "resource" for an instance is BANNED; ⛔ "task" — that names the system Task entity, never a user-built todo/ticket Record |
| A scheduled/triggered automation | **Routine** | `Routine` | `/routines`, `/api/v1/routines` | "Routines" | `workflow` = only the CNCF spec-format ref |
| One execution of a routine | **Run** | `Run` | `/routines/:id/runs/:runId` | "Run" | `execution` → retired |
| A durable, ordered fact a Run emitted while executing | **Run event** | `RunEvent` | `/api/v1/runs/:id/events` | — | DB: run_events; types are the closed vocabulary in `@tulipfarm/schema`; ⛔ `SSE event`/`stream frame` name the transport, not the fact |
| Who a Run event may be shown to | **Audience** | `RunEventAudience` | — | — | `participant` (in the conversation) \| `operator` (evidence: digests, dispatch records) |
| How a routine starts | **Trigger** | `Trigger` | — | "Trigger" | event·manual·cron·webhook·agent |
| A step in a routine | **State** | `State` | — | "State" | CNCF Serverless Workflow term |
| A connected third-party | **Integration** | `Integration` | `/integrations`, `/api/v1/integrations` | "Integrations" | `connection`/`connector` → retired |
| The data file that fully defines an Integration | **Integration manifest** | `IntegrationManifest` | — | — | `integrations/<slug>/manifest.yml`; identity + `auth` + `egress` (+ optional `ingress`). Authoring reference: `docs/architecture/building-an-integration.md`; ⛔ "integration config"/"connector definition" |
| What an Integration lets agents *do* to the provider | **Egress** | `EgressConfig` | — | — | `openapi` \| `mcp` \| `ts-code` \| `none`; ⛔ "outbound"/"actions" as the block's name |
| One provider API operation published as an agent Tool | **Egress operation** | `EgressOperation` | — | — | an explicit allowlist entry under `egress.operations`; compiles to a `ToolContractSpec`; ⛔ publishing a whole spec |
| What an Integration lets the provider *send* TulipFarm | **Ingress** | `IngressConfig` | — | — | webhooks and event normalization; ⛔ "inbound"/"listener" as the block's name |
| The GitHub App a deployment registered for itself | **GitHub App** | — | — | "GitHub App" | one App per *deployment*, created by that deployment via GitHub's App Manifest flow and owned by whoever runs it; ⛔ "the TulipFarm GitHub App" — there is no vendor-owned App every customer installs |
| A customer's install of the GitHub App into their org/repos | **GitHub App installation** | maps to an `Integration` row (`external_tenant_id` = GitHub `installation_id`) | `/api/v1/integrations/github/installations/:id` | "GitHub Install" | one per customer connect; ⛔ "GitHub connection"/"GitHub OAuth" — this is App-install, not OAuth |
| Short-lived (~1hr) bearer credential minted per installation | **Installation access token** | — | — | — | minted via App JWT exchange, refreshed before expiry; never persisted long-term, never logged |
| An installation's account + selected repos + granted permissions | **Installation scope** | `GitHubInstallationScope` | — | — | `packages/integrations/src/github/scope.ts` |
| Which repos an installation/access grant covers | **Repository grant** | `AccessGrant` (`externalTargets: {type: "github.repository", ids[]}`) | — | "Connected repositories" | maps onto `integration_access_grants` |
| A channel sender bound to a TulipFarm account | **Channel link** | `ChannelLink` | `/api/v1/identity/channel-links/*`, `/link-channel` | "Link channel" | stored in external_identity_mappings, provider = integration slug; ⛔ "channel identity" as the *link* — that names the sender side only |
| A Google permission subject used for Drive/Docs Knowledge ACLs | **Google permission subject** | `GooglePermissionSubject` | — | "Google permission subject" | User email, group email, or explicitly mapped domain from Drive permissions; link-sharing (`anyone`) grants no Knowledge access |
| The single-use invitation that creates one | **Bind link** | `ChannelBind*` | — | "Link your account" | HMAC-signed, 15 min, nonce consumed on redemption; a credential — never logged, never in a query string |
| The single-use link that gives a TulipFarm account its password | **Invite link** | `Invite`, `UserInvite*` | `/api/v1/users/:id/invite`, `/api/v1/auth/invites/*`, `/accept-invite` | "Invite link", "Reset password link" | Random secret, hash-only storage, 7 days, consumed on redemption; re-issuing revokes the outstanding one and is also the password recovery path. ⛔ "temporary password" — none is ever minted. Distinct from a **Bind link**, which links a channel sender, not an account |
| Auth material for a provider/integration | **Credential** | `Credential` | — | "Credentials" | API key/token/login; *backed by* a Secret |
| Encrypted at-rest value (storage primitive) | **Secret** | `Secret` | `/business/secrets` | "Secrets" | the store; ≠ Credential |
| Boot-time value from `.env`/`process.env` | **Env Config** | — | — | — | restart-required; not all values are secret (e.g. `SOUL_PATH`) — the one genuinely secret value inside it is the KEK (`ENCRYPTION_KEY`), named directly, not by renaming this bucket |
| An installable agent capability module | **Skill** | `Skill` | `/skills`, `/api/v1/skills` | "Skills" | the *what* — a procedure an Agent loads for one task; never addressed by a user, one active per Turn, and it **grants no authority**. A `tools:` list narrows the model-visible offer only (`narrowing.ts`), never authorization. `plugin`/`capability` → retired as synonyms¹ |
| Where skills are browsed/installed | **Marketplace** / **Install** | — | `/skills/marketplace`, `/skills/install` | "Marketplace" | |
| The git-backed config repo | **Soul** | `Soul` | `/api/v1/soul` | "Soul" | holds agents/routines/skills/integrations/resources |
| Git-tracked YAML settings inside the Soul repo | **Soul Config** | `SoulConfig` | — | — | e.g. `soul.yaml`, `guardrails.yaml`; non-secret, runtime-editable but reload behavior varies (some apply on `soul.synced`, others require restart) |
| The knowledge wiki feature | **Knowledge** | — | `/knowledge` | "Knowledge" | a wiki |
| A grouping of pages | **Space** | `Space` | `/knowledge/spaces/:id` | "Space" | retires `bundle`, `collection`²; DB: knowledge_spaces, knowledge_space_overrides |
| A knowledge content node | **Page** | `Page` | `/knowledge/pages/:id` | "Page" | retires `concept`, `document`; pages link pages (backlink graph); DB: knowledge_pages |
| A runtime human-decision gate | **Approval** | `Approval` | `/approvals`, `/api/v1/approvals` | "Approvals" | not "review"/"request" |
| A policy constraining agent/tool behavior | **Guardrail** | `Guardrail` | `/api/v1/guardrails` | "Guardrails" | `policy`/`rule` are subordinate parts, not the concept |
| A callable function exposed to agents | **Tool** | `Tool` | — | "Tool" | includes MCP tools |
| The single Markdown page of durable facts kept for one user | **Memory** | `Memory` | `/api/v1/memory` | "Memory" | one document per user, injected whole into every turn; ≠ Context |
| The stored artifact itself | **Memory Document** | `MemoryDocument` | — | — | Markdown, fixed `##` sections, canonical render, versioned with revisions; machine-authored and not user-editable — ⛔ do not conflate with **Custom instructions**, which are user-authored and user-visible |
| Hard-purging a person's Memory | **Erase** | `MemoryErasureService.eraseUser` | — | "Erase" | removes the Memory Document *and its whole revision history*; deleting only the current page leaves every superseded copy of the same fact behind; ⛔ "forget" |
| One fixed `##` heading inside the document | **Memory Section** | `MemorySection` | — | — | closed set: Identity, Standing instructions, Working context, Preferences, Recent decisions, Other durable facts; a writer names exactly one; ⛔ "memory key", "field" |
| One write against exactly one section | **Memory Delta** | `MemoryDelta` | — | — | `{ section, add?, remove? }` — the only write a Tool may make; removals apply before additions, so naming an entry in both keeps it. A delta touches only entries the caller named, so it needs no stale check. Whole-section `replace` is a privileged repository call under a mandatory section hash, never reachable from a Tool; ⛔ "memory patch", "memory update" as the unit |
| The background system that mines Turns and proposes work | **Curator** | `Curator` | `/api/v1/internal/curator/*` | not surfaced | `curator-sweep` is deterministic maintenance; the reasoning runs as durable Runs with `RunSource` `curator`; ⛔ "the loop", "reconciler" (that names the deterministic Task checks only) |
| One durable unit of pending Curator work for a user | **Curator Work** | `CuratorWork` | — | — | carries a **Work Reason**: `turn_completed`, `proposal_resolved`, `daily_refresh_due`, `proposal_seed_ready`; identity includes its source so distinct work never dedupes together |
| One applied outcome of a Curator Run | **Curator Effect** | `CuratorEffect` | — | — | `pending` → `applying` → `succeeded` \| `retryable_failed` \| `superseded` \| `terminal_rejected`; completion is judged over the latest generation; ⛔ "action", "mutation" |
| One suggested next step, before it is delivered anywhere | **Proposal** | `Proposal` | — | "Task" or a chat suggestion | the single object behind both Tasks and chat suggestion pills; the model picks only a closed `kind` and the server templates every user-visible string and URL; ⛔ "suggestion" as the stored entity, "quest" (retired) |
| A business-scoped Proposal with no audience yet | **Proposal Seed** | `ProposalSeed` | — | — | emitted by the business Run, which cannot name a user; each eligible per-user Run decides whether to personalise it; ⛔ "global suggestion" |
| A sanitized statement promoted from a user Run toward business Knowledge | **Knowledge Promotion** | `KnowledgePromotion` | — | — | declarative only, never raw quotes, never another user's text |
| Assembled model-input window for a turn | **Context** | `Context` | — | — | the Context Engine (assembly, compaction); ≠ Memory |
| First-run setup wizard | **Onboarding** | `Onboarding` | `/onboarding` | "Onboarding" | route rename from `/setup` deferred — `/setup` is still named in ~10 published docs pages and `apps/web/app/routes/_app.tsx`; tracked in Rename backlog below |
| The persistent post-login onboarding assistant | **Companion** | `OnboardingCompanion` | — | "Companion" | floating bottom-right ≥`sm`, top-bar icon button below it; never auto-opens; ⛔ "clippy", "mascot", "tour", "walkthrough" |
| A system-created unit of work asking a human to do something | **Task** | `Task` | `/api/v1/tasks` | "Task" | one of the two deliveries of a **Proposal** (the other is a chat suggestion pill); also created by the deterministic checks or by an Agent via `task.create`; never user-created — a user-facing todo/ticket product is a Resource Type, not a Task; ⛔ "quest" (retired) |
| Model Context Protocol (external tool servers) | **MCP** | `MCP` | — | "MCP" | acronym, verbatim |
| A governed model routing record derived from Soul Config | **ModelProfile** | `ModelProfile` | `/api/v1/model-profiles` | "Model profile" | one word, `PascalCase` — synthesized deterministically from `soul.yaml#llm` and pinned into immutable bundles; holds provider/model, capability, modality, constraints, budgets, fallbacks. There is no authored `models/` directory. ⛔ "tier" as the routing unit — retired |
| A named effort level a participant may pick | **Effort Preset** | `EffortPreset` | — | "Auto"/"Fast"/"Balanced"/"Thorough" | the ONLY model concept a user sees; maps to a ModelProfile ref, one marked default. ⛔ "quick"/"standard"/"complex" — retired |
| Credentials + endpoint for one provider | **Provider Connection** | `ProviderConnection` | — | "Provider" | `provider → {api_key_ref, base_url, resource_name}`; secret-bearing, admin-managed. Distinct from a ModelProfile, which is governance and git-audited |
| A Provider Connection backed by a personal CLI subscription token instead of an API key | **Subscription Provider** | `CliLanguageModel` (`packages/llm/src/cli/`) | — | "(subscription)" suffix on the provider label | `claude-code` (`@anthropic-ai/claude-agent-sdk`) and `codex` (`@openai/codex`); runs a coding-agent CLI as the model in a jailed subprocess, one call per AgentLoop iteration, tool calls captured and never executed by the CLI. Turns are reported **unpriced** — a subscription turn has no per-token cost. See `docs/plans/cli-agent-providers.md`. ⛔ "harness" — already means the default chat surface (see Agent row above) |
| The raw provider model identifier | **Model ID** | `modelId` | — | — | e.g. `claude-sonnet-4`; an implementation detail of a ModelProfile — never a user-facing choice, never a routing unit |
| What a completed reply reports about the call that produced it | **Receipt** | `ModelCallReceipt` | — | "Answered by …" | participant-visible: Model ID, effort asked, effort applied, model-call latency. ⛔ cost — operator-only, on the `model.routed` Run event |
| Re-running a turn one effort level higher | **Try harder** | `nextEffortPreset` | — | "Try harder" | always the participant's choice; escalates from the effort the receipt says was *applied*. ⛔ "retry"/"regenerate" — those repeat a turn unchanged |
| Agent-to-channel presentation standard | **Tulip Surface Protocol** | `TSP`, `SurfaceArtifact`, `SurfaceRenderer`, `SurfaceInteraction` | `/api/v1/surfaces`, `/dev/surfaces`, `surface-components/` | "Tulip Surface Protocol", "presentation" | Channel-neutral semantic components; never persisted provider payloads or executable UI |

¹ `plugin` remains valid ONLY for build/library tooling (vite, rehype, Chart.js) — never for a Skill.
² `collection` is reserved exclusively for "a Postgres/MongoDB collection" (infra). It never means a knowledge grouping.

### Offline eval

Maintainer-only vocabulary, owned by `apps/eval`. None of it is a product surface: it has no
REST path, no app URL and no UI label, and a participant never meets any of these words.

Two product rules are deliberately relaxed here, and only here:

- **Models are named directly.** The product rule is that a participant picks an Effort Preset,
  never a model. A Sweep is the opposite by design — it exists to compare named models, so it
  names them.
- **A Trial's own execution is not a Run.** `Run` is reserved for a Routine execution across the
  run kernel. A Trial *contains* real Runs when it drives the real executor, which is exactly why
  it cannot also be called one.

| Concept (what it is) | Canonical | Code | REST / URL | UI label | Notes & retired synonyms |
|---|---|---|---|---|---|
| One complete offline eval execution: the whole Corpus against every model under test, at one harness commit | **Sweep** | `runSweep` | — | — | the unit a release gate passes or fails; ⛔ "eval run" (see above), ⛔ "eval suite", "benchmark run" |
| One Eval Case run once against one model | **Trial** | `TrialResult`, `runTrial` | — | — | the atom a Sweep is made of; repeated Trials of the same Case are what measure the Noise Floor. ⛔ "sample", "rollout", "attempt" |
| One frozen scenario: the input, its fixtures, and the Expectations it must meet | **Eval Case** | `EvalCase`, `corpus/*.json` | — | — | "Case" alone is fine inside `apps/eval`. ⛔ "test case" — that belongs to Vitest, and conflating the two hides which one a red build means |
| The versioned set of Eval Cases, content-hashed so a Scorecard names the exact inputs it scored | **Corpus** | `loadCorpus`, `corpusHash` | — | — | ⛔ "dataset", "test suite", "eval set" |
| One deterministic, data-only check a Trial must satisfy | **Expectation** | `Expectation`, `expect` | — | — | data, never a function, so a Corpus stays content-hashable. ⛔ "assertion" — taken by Memory, and one word cannot name two concepts |
| A Trial that passed while expecting nothing, so its pass means nothing | **Vacuous** | `vacuous` | — | — | rejected at Corpus load and counted against the CLI exit code; the framework's worst failure mode, so it is named rather than left implicit |
| The verdict of one Sweep: every Trial's outcome, plus the Corpus hash and harness commit that produced it | **Scorecard** | `Scorecard`, `renderScorecard` | — | — | ⛔ "report", "results", "summary" |
| The Scorecard of an already-released harness commit, that a candidate is measured against | **Baseline** | `Baseline` | — | — | ⛔ "control", "golden", "reference run" |
| The spread across repeated identical Trials; a difference smaller than it is not a result | **Noise Floor** | `noiseFloor` | — | — | the whole point of the framework — it separates a real improvement from model variance. ⛔ "variance", "error bar", "jitter" |
| A pinned model that scores what an Expectation cannot express | **Judge** | `Judge` | — | — | pinned and version-recorded per Sweep, or it becomes a moving ruler. ⛔ "grader", "rubric model", "LLM-as-a-judge" used as a noun |
| The fixed Soul a Sweep loads, so Cases do not drift when the dev Soul changes | **Eval Soul** | `evalSoul` | — | — | ⛔ "fixture soul", "test soul", "mock soul" |

## Banned / retired terms (quick lookup)

| Don't write | Write instead | Status |
|---|---|---|
| conversation (in UI/URL/REST) | chat | clean |
| chat (in entity/DB/domain) | conversation | clean |
| resource (meaning one instance) | record | clean (see Completed Renames) |
| workflow (meaning a routine) | routine | clean (only CNCF/CI uses remain) |
| execution (of a routine) | run | clean (only tool-execution uses remain) |
| connection / connector | integration | clean (only DB/SSE uses remain) |
| plugin (meaning a skill) | skill | clean (only build-tool uses remain) |
| capability (meaning a skill) | skill | clean |
| bundle | space | clean (only build-bundle uses remain) |
| collection (meaning a knowledge group) | space | retired (see Completed Renames) |
| concept (knowledge node) | page | clean |
| document (knowledge node) | page | clean |
| tier (meaning model routing) | ModelProfile | retiring — accepted as a deprecated wire alias for one release |
| quick / standard / complex | Effort Preset (Auto/Fast/Balanced/Thorough) | retiring — deprecated wire aliases for one release |
| model (meaning the user-facing choice) | effort preset | clean — a user picks effort, never a model |
| LLM page | Models | clean |
| Users page / Roles page | People | clean |
| Security page | Auth | clean |
| working memory | Memory Document | retired — every `WorkingMemory*` identifier and the `working_memory` table are deleted (migration v67) |
| memory entry / memory item / memory key | Memory Section entry (one line) | retired — Memory has no keys; a fact is addressed by its own canonical text |
| assertion (as the unit Memory is made of) | Memory Document + Memory Section | retired |
| pending memory / suggested memory / memory candidate | — | retired — the Curator writes directly; there is no confirmation queue |
| episode | `## Recent decisions` | retired — capped at 15; older outcome recall is deliberately given up |
| recalled memory / `<recalled-memory>` | — | retired — the whole document is always in context, so nothing is retrieved per turn |
| memory extraction | Curator | retired — mining moved off the turn path into a durable Run |
| procedural correction | `## Standing instructions` | retired |
| memory scope / memory type / trust tier / validity interval / point-in-time recall / contradiction | — | retired — the document is the current truth, so there is nothing to version, rank or time-travel |
| quest | Proposal | retired — the endpoints had zero consumers and are deleted |
| eval run | sweep | clean — `Run` is a Routine execution; a Trial contains real Runs |
| test case (meaning an eval scenario) | eval case | clean — "test case" belongs to Vitest |
| assertion (meaning an eval check) | expectation | clean — "assertion" is Vitest's `expect`; an Expectation is a property a Case declares, not a runtime check |
| dataset / eval set | corpus | clean |
| grader / rubric model | judge | clean |

## Completed Renames (done 2026-06-27)

The cross-layer mismatches this doc prescribed have been applied across code, DB, REST,
URL, UI, and docs. Migration `v18` renamed the physical Knowledge tables/columns/indexes.

1. **Knowledge → Space/Page** (largest): `bundle`→`space`, `concept`/`document`→`page`
   across DB (tables `knowledge_spaces`/`knowledge_pages`/`knowledge_space_overrides`,
   columns `space_id`/`page_id`/`target_space_*`), REST (`/api/v1/knowledge/spaces`,
   `/api/v1/knowledge/pages`), URL routes (`/knowledge/spaces`, `/knowledge/pages/:id`),
   types, components, agent tools (`create_knowledge_page`), and the synthesized listing
   heading (`# Pages`). The backlink graph is unchanged.
   - **Deviation — collections retired (not renamed):** the legacy flat `collection`
     grouping (its UI already removed) could not become `space` without colliding with
     `bundle`→`space`, so its tables, repo/service/routes/types, and the two agent tools
     (`create_knowledge_collection`, `list_knowledge_collections`) were **dropped**.
     `collection` now means only a Postgres/Mongo collection (infra).
2. **Chat REST**: REST surface aligned to `/api/v1/chats*` (entity, table, repo, and
   internal `Conversation` names stay — only the wire path changed).
3. **Resource instance**: agent tools `resource_*`→`record_*`; bare "resource"-as-instance
   wording → "record". REST `/api/v1/resources/:type/:id` and the `ResourceRecord` type
   stay (canonical). The `resource_id` storage column + its `resourceId` (type, id)
   addressing in domain events are kept as part of the unchanged Resources storage layer.
4. **Routine/Run**: already canonical — no concept-meaning `workflow`/`execution` leaks
   existed; remaining uses are the CNCF Serverless Workflow spec and tool-execution.
5. **Integration**: `SoulIntegration.connection`→`config` (file `connection.yaml`→
   `config.yaml`). "connection" now means only a DB pool / SSE stream.
6. **Skill**: `capability`-as-synonym removed from Skill Forge copy.

## Rename backlog

1. **`/setup` → `/onboarding`**: canonical route decided above but not yet applied. The route,
   its file (`apps/web/app/routes/setup.tsx`), and its redirect target
   (`apps/web/app/routes/_app.tsx`) still say `setup`, as do ~10 published `apps/docs` pages
   (installation, deploy/coolify, deploy/headless, deploy/tls, getting-started, troubleshooting,
   concepts/setup, production-checklist). Rename is a docs sweep, not just a route change —
   scope it as its own change.
